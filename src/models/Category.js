import mongoose from "mongoose";

const categorySchema = new mongoose.Schema({
    church: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Church',
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    type: {
        type: String,
        enum: ['rf','expense'],
        required: true,
    },
    color: {
        type: String,
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
}, { timestamps: true});

// Categories are always listed for one church, often filtered by type.
categorySchema.index({ church: 1, type: 1 });

export const Category = mongoose.model('Category', categorySchema);