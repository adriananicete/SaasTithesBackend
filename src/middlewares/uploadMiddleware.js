import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary.js';
import { Church } from '../models/Church.js';

const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

// Every upload lands under its own church: churches/<slug>/receipts, /avatars,
// /logo. These used to be module-load constants ('joscm/receipts'), which meant
// every church's files piled into one folder named after the first customer —
// and, less cosmetically, that purgeChurch deleted nothing, because it has been
// removing `churches/<slug>` since Branch 5b and nothing was ever written there.
//
// Keyed on the SLUG, never the acronym: the acronym is display-only and freely
// editable since Branch 5b, so a rename would strand every file already
// uploaded under the old name. The slug is generated once and never changes.
//
// This is namespacing, not a security boundary — the `church` filter on every
// query is the enforcement layer. A tidy folder tree is what makes the purge
// cascade and a manual audit in the Cloudinary console possible.
const churchFolder = async (req, kind) => {
    // A superadmin belongs to no church but can still set their own avatar.
    if (!req.user?.church) return `churches/_platform/${kind}`;

    const church = await Church.findById(req.user.church).select('slug');
    if (!church?.slug) throw new Error('Could not resolve the church for this upload');
    return `churches/${church.slug}/${kind}`;
};

const receiptStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req) => ({
        folder: await churchFolder(req, 'receipts'),
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
    }),
});

const fileFilter = (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed (jpg, jpeg, png, webp)'), false);
    }
    cb(null, true);
};

export const uploadReceipts = multer({
    storage: receiptStorage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 5,
    },
});

export const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(400).json({ error: 'Each file must be 10MB or smaller' });
        if (err.code === 'LIMIT_FILE_COUNT')
            return res.status(400).json({ error: 'You can upload up to 5 receipts only' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
};

// Single profile photo. Cloudinary applies a 256x256 face-aware square crop so
// every avatar is uniform regardless of the uploaded aspect ratio.
const avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req) => ({
        folder: await churchFolder(req, 'avatars'),
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
        transformation: [{ width: 256, height: 256, crop: 'fill', gravity: 'face' }],
    }),
});

export const uploadAvatar = multer({
    storage: avatarStorage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
    },
});

export const handleAvatarUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(400).json({ error: 'Image must be 5MB or smaller' });
        if (err.code === 'LIMIT_FILE_COUNT')
            return res.status(400).json({ error: 'You can upload only one image' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
};

// The church logo. Not face-cropped like an avatar and not squared — a logo is
// whatever shape it is — so it is only bounded to a sane maximum with its
// aspect ratio kept.
const churchLogoStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req) => ({
        folder: await churchFolder(req, 'logo'),
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
        transformation: [{ width: 512, height: 512, crop: 'limit' }],
    }),
});

export const uploadChurchLogo = multer({
    storage: churchLogoStorage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
    },
});

// Supporting documents for a request form — a quotation, a photo of the thing
// being replaced. Images only, matching receipts and avatars: the fileFilter
// and Cloudinary's resource_type are both image-bound, so a PDF would need its
// own path (noted in businessRequirements §14 item 7).
const rfAttachmentStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req) => ({
        folder: await churchFolder(req, 'attachments'),
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
    }),
});

export const uploadRfAttachments = multer({
    storage: rfAttachmentStorage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 5,
    },
});

export const handleAttachmentUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(400).json({ error: 'Each file must be 10MB or smaller' });
        if (err.code === 'LIMIT_FILE_COUNT')
            return res.status(400).json({ error: 'You can upload up to 5 attachments only' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
};

export const handleLogoUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
            return res.status(400).json({ error: 'Logo must be 5MB or smaller' });
        if (err.code === 'LIMIT_FILE_COUNT')
            return res.status(400).json({ error: 'You can upload only one image' });
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
};
