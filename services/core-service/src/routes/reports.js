import { Router } from 'express';
import { protect, adminOnly } from '../middleware/auth.js';
import {
  createReport,
  myReports,
  allReports,
  getReport,
  updateReportStatus,
  getReportStats,
} from '../controllers/reportController.js';

const router = Router();

// User routes
router.post('/', protect, createReport);
router.get('/my', protect, myReports);

// Admin routes
router.get('/admin/all', protect, adminOnly, allReports);
router.get('/admin/stats', protect, adminOnly, getReportStats);
router.put('/admin/:id/status', protect, adminOnly, updateReportStatus);

// Single report (accessible by owner or admin)
router.get('/:id', protect, getReport);

export default router;
