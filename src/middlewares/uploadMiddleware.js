import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import cloudinary from '../config/cloudinary.js';

const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

const receiptStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: 'joscm/receipts',
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
    },
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
    params: {
        folder: 'joscm/avatars',
        allowed_formats: ALLOWED_FORMATS,
        resource_type: 'image',
        transformation: [{ width: 256, height: 256, crop: 'fill', gravity: 'face' }],
    },
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
