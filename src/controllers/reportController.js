import Report from '../models/Report.js';
import Order from '../models/Order.js';
import { isValidObjectId } from 'mongoose';

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

    // Verify order exists and belongs to user
    const order = await Order.findOne({ _id: orderId, user: req.user.id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const report = await Report.create({
      user: req.user.id,
      order: orderId,
      type,
      subject,
      notes,
      image: image || '',
      status: 'pending',
    });

    const populatedReport = await Report.findById(report._id)
      .populate('user', 'name email')
      .populate('order', 'orderNumber total status');

    res.status(201).json(populatedReport);
  } catch (err) {
    console.error('createReport error:', err);
    res.status(500).json({ message: 'Failed to create report' });
  }
}

/** GET /api/reports/my - Get current user's reports */
export async function myReports(req, res) {
  try {
    const reports = await Report.find({ user: req.user.id })
      .populate('order', 'orderNumber total status createdAt')
      .sort({ createdAt: -1 });

    res.json(reports);
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
      .populate('order', 'orderNumber total status createdAt')
      .sort({ createdAt: -1 });

    res.json(reports);
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
      .populate('order', 'orderNumber total status createdAt items');

    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    // Users can only view their own reports, admins can view all
    if (!req.user.isAdmin && report.user._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(report);
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
      .populate('order', 'orderNumber total status');

    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    res.json(report);
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
