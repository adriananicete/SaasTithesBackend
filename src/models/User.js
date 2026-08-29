import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    name: {
        required: true,
        type: String,
    },
    email: {
        required: true,
        type: String,
        unique: true,
    },
    password: {
        required: true,
        type: String,
    },
    isActive: {
        type: Boolean,
        default: true
    },
    // Profile photo (Cloudinary). avatarPublicId is kept so the previous image
    // can be deleted from Cloudinary when the avatar is replaced or removed.
    avatarUrl: {
        type: String,
        default: null,
    },
    avatarPublicId: {
        type: String,
        default: null,
    },
    role: {
        required: true,
        type: String,
        enum: ['admin','do','member','pastor','validator','auditor',]
    },
    // Password reset — stores the SHA-256 hash of the emailed token (never the
    // raw token) plus its expiry. Cleared once the password is reset.
    resetPasswordToken: {
        type: String,
        default: null,
    },
    resetPasswordExpires: {
        type: Date,
        default: null,
    },
}, {timestamps: true});

export const User = mongoose.model('User', userSchema);