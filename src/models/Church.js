import mongoose from "mongoose";

// A tenant. Every church-owned document carries a `church` ref back to one of
// these, and that field is the isolation boundary for the whole API.
const churchSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    // Display identity — "JIL" for a standalone church, "JIL-San Pedro" for a
    // branch of an organisation. Freely editable, and may contain spaces,
    // which is why it is NOT what names the storage folder. Not uppercased on
    // write any more: the locality half reads as a place name, not an acronym.
    acronym: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    // Names the church's Cloudinary folder (churches/<slug>/...). Generated
    // once at creation and never changed, so renaming a church or switching
    // its type can never strand the files already uploaded under it.
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    // A standalone church stands alone; an organisation has branches in
    // several places, so its locality is appended to the acronym to tell them
    // apart. Editable — a church can grow into an organisation.
    type: {
        type: String,
        enum: ['standalone', 'organization'],
        default: 'standalone',
        required: true,
    },
    // One field, not separate city and municipality: a Philippine locality is
    // either a city or a municipality, never both, so two fields would leave
    // one always blank and force the acronym logic to guess.
    cityMunicipality: {
        type: String,
        trim: true,
    },
    province: {
        type: String,
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
