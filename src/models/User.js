import mongoose from "mongoose";
import { ALL_ROLES, ROLES } from "../constants/roles.js";

const userSchema = new mongoose.Schema({
    // The tenant this user belongs to. Superadmin is the system owner and
    // belongs to no church, so it stays null there; every other role requires
    // one. Uniqueness of email is compound with this — see the index below.
    church: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Church',
        required: function () {
            return this.role !== ROLES.SUPERADMIN;
        },
        default: null,
    },
    name: {
        required: true,
        type: String,
    },
    email: {
        required: true,
        type: String,
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
        enum: ALL_ROLES,
    },
}, {timestamps: true});

// Email is unique PER CHURCH, not globally — the same person may hold an
// account in two churches, and login disambiguates with the church dropdown.
// Superadmins share church: null, so their tuples are (null, email), which
// stay distinct from each other because uniqueness is on the pair.
userSchema.index({ church: 1, email: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);