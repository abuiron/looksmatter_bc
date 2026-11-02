import { Schema, model } from 'mongoose';

const reportSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  order: {
    // Lives in order-service (another database): a plain id, never populated.
    type: Schema.Types.ObjectId,
    required: true,
  },
  // The order fields that never change, copied when the report is filed. Responses
  // fall back to them when order-service can't be reached.
  orderSnapshot: {
    orderNumber: String,
    total: Number,
    createdAt: Date,
  },
  type: {
    type: String,
    enum: ['order_issue', 'payment_issue'],
    required: true,
  },
  subject: {
    type: String,
    required: true,
    trim: true,
  },
  notes: {
    type: String,
    required: true,
  },
  image: {
    type: String, // URL or path to uploaded image
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'resolved', 'rejected'],
    default: 'pending',
  },
  adminNotes: {
    type: String, // Admin can add notes when resolving/rejecting
  },
}, {
  timestamps: true,
});

// Index for faster queries
reportSchema.index({ user: 1, status: 1 });
reportSchema.index({ order: 1 });

const Report = model('Report', reportSchema);

export default Report;
