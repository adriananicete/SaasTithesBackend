import { User } from "../models/User.js";
import bcrypt from 'bcrypt';
import cloudinary from "../config/cloudinary.js";
import { recordAudit } from "../utils/recordAudit.js";

// Return the currently authenticated user's profile (minus password). The
// frontend calls this on load to hydrate fields the JWT doesn't carry (e.g.
// avatarUrl), since refresh tokens only re-issue auth, not profile data.
export const getMe = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id).select("-password");
        if (!user) return res.status(404).json({ error: "User not found" });
        res.status(200).json({ status: "Success", data: user });
    } catch (error) {
        next(error);
    }
};

// Upload/replace the current user's avatar. multer-storage-cloudinary has
// already pushed the file to Cloudinary by the time we get here:
// req.file.path = secure URL, req.file.filename = public_id.
export const updateMyAvatar = async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No image uploaded" });

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        // Remove the previous image so Cloudinary doesn't accumulate orphans.
        if (user.avatarPublicId) {
            try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch (e) { /* non-fatal */ }
        }

        user.avatarUrl = req.file.path;
        user.avatarPublicId = req.file.filename;
        await user.save();

        await recordAudit({
            req,
            action: "user.update_avatar",
            targetModel: "User",
            targetId: user._id,
            targetRef: user.email,
            summary: "Updated profile photo",
        });

        const { password: _pw, ...data } = user.toObject();
        res.status(200).json({ status: "Success", message: "Profile photo updated", data });
    } catch (error) {
        next(error);
    }
};

// Remove the current user's avatar (revert to initials fallback).
export const removeMyAvatar = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        if (user.avatarPublicId) {
            try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch (e) { /* non-fatal */ }
        }

        user.avatarUrl = null;
        user.avatarPublicId = null;
        await user.save();

        await recordAudit({
            req,
            action: "user.remove_avatar",
            targetModel: "User",
            targetId: user._id,
            targetRef: user.email,
            summary: "Removed profile photo",
        });

        const { password: _pw, ...data } = user.toObject();
        res.status(200).json({ status: "Success", message: "Profile photo removed", data });
    } catch (error) {
        next(error);
    }
};

export const changePassword = async (req, res, next) => {
    try {

        const { id } = req.user;
        const { currentPassword, newPassword } = req.body;

        if(!newPassword || !currentPassword) return res.status(400).json({error: 'All fields must have a value'});

        const finderUserPassword = await User.findById(id);
        if(!finderUserPassword) return res.status(404).json({error: 'User not found'});

        const isMatch = await bcrypt.compare(currentPassword, finderUserPassword.password);
        if(!isMatch) return res.status(400).json({error: 'Current Password did not match'});

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const findeUser = await User.findByIdAndUpdate(id,{$set: {password: hashedPassword}},{new:true});

        await recordAudit({
            req,
            action: 'user.change_password',
            targetModel: 'User',
            targetId: id,
            targetRef: finderUserPassword.email,
            summary: 'Changed own password',
        });

        res.status(200).json({
            status: 'Success',
            message: 'Password Changed!',
        });
    } catch (error) {
        next(error);
    }
}