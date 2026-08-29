import mongoose from "mongoose";

const categorySchema = new mongoose.Schema({
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

export const Category = mongoose.model('Category', categorySchema);