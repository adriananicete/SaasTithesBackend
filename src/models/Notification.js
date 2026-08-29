import mongoose from "mongoose";

const notifSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ["approval", "rejection","info", "reminder"],
        required: true
    },
    refId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    refModel: {
        type: String,
        enum: ['Tithes','RequestForm','Voucher'],
        required: true
    },
    isRead: {
        type: Boolean,
        default: false
    }
},{timestamps: true});

// getNotifications queries find({ userId }).sort({ createdAt: -1 }).
notifSchema.index({ userId: 1, createdAt: -1 });
// TTL: notifications fan out per recipient and are never deleted, so let
// MongoDB auto-purge anything older than 90 days (read or not — a 90-day-
// old notification is stale either way). TTL must be a single-field index.
notifSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const Notification = mongoose.model('Notification', notifSchema);