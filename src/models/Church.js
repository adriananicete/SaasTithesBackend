import mongoose from "mongoose";

// A tenant. Every church-owned document carries a `church` ref back to one of
// these, and that field is the isolation boundary for the whole API.
const churchSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    // Drives the Cloudinary folder (churches/<acronym>/...) and the
    // name@<acronym>.com email convention. Uppercased on write.
    acronym: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
    },
    // Convention only — the frontend prefills it on account creation. Never
    // validated against, so a church may use gmail addresses if it wants to.
    emailDomain: {
        type: String,
        trim: true,
        lowercase: true,
    },
    // Church logo (Cloudinary). logoPublicId is kept so the previous image can
    // be deleted when the logo is replaced, matching the User avatar pattern.
    logoUrl: {
        type: String,
        default: null,
    },
    logoPublicId: {
        type: String,
        default: null,
    },
    address: {
        type: String,
    },
    contactEmail: {
        type: String,
        trim: true,
        lowercase: true,
    },
    contactPhone: {
        type: String,
        trim: true,
    },
    // Deactivated: hidden from the login dropdown and every user blocked.
    isActive: {
        type: Boolean,
        default: true,
    },
    // Soft delete. Hidden and blocked like deactivation, but data is retained
    // until an explicit purge.
    deletedAt: {
        type: Date,
        default: null,
    },
}, { timestamps: true });

// The login dropdown reads active, non-deleted churches on every page load.
churchSchema.index({ isActive: 1, deletedAt: 1 });

export const Church = mongoose.model('Church', churchSchema);
