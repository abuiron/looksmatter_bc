import Report from '../models/Report.js';
import { isValidObjectId } from 'mongoose';
import { getOrder, getOrderSummaries } from '../clients/orderClient.js';

// Reports point at orders, and orders live in order-service (another database), so
// they can't be populated. Instead:
//   - when a report is filed, order-service confirms the shopper owns the order, and the
//     report keeps a snapshot of the order fields that never change (number, total, date);
//   - responses add the live order status from order-service, one batch call per list.
// If order-service is unreachable, lists still answer from the snapshots (without the
// live status), so the support desk keeps working.

/** The order as report responses have always shown it: { _id, orderNumber, total, status, createdAt }. */
function orderView(report, live, { items = false } = {}) {
  const snapshot = report.orderSnapshot || {};
  return {
    _id: report.order,
    orderNumber: live?.orderNumber ?? snapshot.orderNumber,
    total: live?.total ?? snapshot.total,
    status: live?.status, // live only: a stored copy of a status would go stale
    createdAt: live?.createdAt ?? snapshot.createdAt,
    ...(items && live?.items && { items: live.items }),
  };
}

// The report as the API returns it: the snapshot is an internal detail, `order` is the view.
const present = (report, live, options) => {
  const { orderSnapshot, ...rest } = report;
  return { ...rest, order: orderView(report, live, options) };
};

/** Attach each report's order, fetched from order-service in a single call. */
async function withOrders(reports, requestId) {
  let live = new Map();
  try {
    const ids = [...new Set(reports.map((r) => String(r.order)))];
    const summaries = await getOrderSummaries(ids, requestId);
    live = new Map(summaries.map((o) => [String(o._id), o]));
  } catch (err) {
    console.warn(`[${requestId}] reports: order-service unavailable, answering from snapshots: ${err.message}`);
  }
  return reports.map((r) => present(r, live.get(String(r.order))));
}

/** POST /api/reports - Create a new report */
export async function createReport(req, res) {
  try {
    const { orderId, type, subject, notes, image } = req.body;

    if (!orderId || !type || !subject || !notes) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({ message: 'Invalid order ID' });
    }

    if (!['order_issue', 'payment_issue'].includes(type)) {
      return res.status(400).json({ message: 'Invalid report type' });
    }

    // Verify order exists and belongs to user. Orders live in order-service; without its
    // answer we can't check ownership, so refuse rather than guess.
    let order;
    try {
      order = await getOrder(orderId, { userId: req.user.id, requestId: req.id });
    } catch (err) {
      console.error(`[${req.id}] createReport: order-service unavailable:`, err.message);
      return res.status(503).json({ message: 'Orders are temporarily unavailable. Please try again in a moment.' });
    }
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const report = await Report.create({
      user: req.user.id,
      order: orderId,
      orderSnapshot: { orderNumber: order.orderNumber, total: order.total, createdAt: order.createdAt },
      type,
      subject,
      notes,
      image: image || '',
      status: 'pending',
    });

    const populatedReport = await Report.findById(report._id)
      .populate('user', 'name email')
      .lean();

    res.status(201).json(present(populatedReport, order));
  } catch (err) {
    console.error('createReport error:', err);
    res.status(500).json({ message: 'Failed to create report' });
  }
}

/** GET /api/reports/my - Get current user's reports */
export async function myReports(req, res) {
  try {
    const reports = await Report.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    res.json(await withOrders(reports, req.id));
  } catch (err) {
    console.error('myReports error:', err);
    res.status(500).json({ message: 'Failed to fetch reports' });
  }
}

/** GET /api/reports/admin/all - Get all reports (admin only) */
export async function allReports(req, res) {
  try {
    const { status, type } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    const reports = await Report.find(filter)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    res.json(await withOrders(reports, req.id));
  } catch (err) {
    console.error('allReports error:', err);
    res.status(500).json({ message: 'Failed to fetch reports' });
  }
}

/** GET /api/reports/:id - Get single report */
export async function getReport(req, res) {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid report ID' });
    }

    const report = await Report.findById(id)
      .populate('user', 'name email')
      .lean();

    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    // Users can only view their own reports, admins can view all
    if (req.user.role !== 'admin' && report.user._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // One report: fetch its order with items. Fall back to the snapshot if order-service is down.
    let order = null;
    try {
      order = await getOrder(report.order, { requestId: req.id });
    } catch (err) {
      console.warn(`[${req.id}] getReport: order-service unavailable, answering from snapshot: ${err.message}`);
    }

    res.json(present(report, order, { items: true }));
  } catch (err) {
    console.error('getReport error:', err);
    res.status(500).json({ message: 'Failed to fetch report' });
  }
}

/** PUT /api/reports/admin/:id/status - Update report status (admin only) */
export async function updateReportStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid report ID' });
    }

    if (!status || !['pending', 'in_progress', 'resolved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const report = await Report.findByIdAndUpdate(
      id,
      {
        status,
        ...(adminNotes && { adminNotes })
      },
      { new: true }
    )
      .populate('user', 'name email')
      .lean();

    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    const [shaped] = await withOrders([report], req.id);
    res.json(shaped);
  } catch (err) {
    console.error('updateReportStatus error:', err);
    res.status(500).json({ message: 'Failed to update report status' });
  }
}

/** GET /api/reports/admin/stats - Get report statistics (admin only) */
export async function getReportStats(req, res) {
  try {
    const stats = await Report.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const typeStats = await Report.aggregate([
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      byStatus: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
      byType: typeStats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
    });
  } catch (err) {
    console.error('getReportStats error:', err);
    res.status(500).json({ message: 'Failed to fetch report statistics' });
  }
}
