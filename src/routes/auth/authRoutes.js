import express from 'express';
import rateLimit from 'express-rate-limit';
import { userLogin, userLogout, refreshAccessToken, forgotPassword, resetPassword } from '../../controllers/auth/authController.js';

const router = express.Router();

// Throttle login attempts to slow down brute-force / credential-stuffing
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
});

// Slightly looser limiter for token refresh (called automatically by clients)
const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many refresh attempts. Try again later.' },
});

// Throttle password-reset requests (email-sending + token issuance)
const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset attempts. Try again later.' },
});

// Auth
router.post('/login', loginLimiter, userLogin);
router.post('/refresh', refreshLimiter, refreshAccessToken);
// Logout just clears cookies — must work even with an expired access token.
router.post('/logout', userLogout);

// Password reset (public)
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);

export default router;
