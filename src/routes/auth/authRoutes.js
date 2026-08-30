import express from 'express';
import rateLimit from 'express-rate-limit';
import { userLogin, userLogout, refreshAccessToken } from '../../controllers/auth/authController.js';
import { getPublicChurches } from '../../controllers/auth/churchListController.js';

const router = express.Router();

// Throttle login attempts to slow down brute-force / credential-stuffing.
// The cap is env-overridable purely so the check suites can run back to back
// in development — several of them sign in a dozen times and would otherwise
// need a server restart between runs to clear the in-memory counter. Leave it
// unset in production, where 10 is the intended limit.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
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

// Church dropdown — public by necessity, it is read before anyone can log in.
router.get('/churches', getPublicChurches);

// Auth
router.post('/login', loginLimiter, userLogin);
router.post('/refresh', refreshLimiter, refreshAccessToken);
// Logout just clears cookies — must work even with an expired access token.
router.post('/logout', userLogout);

// There is no public password reset. A user who has forgotten their password
// asks their church admin, who calls PATCH /api/admin/users/:id/reset-password
// and hands over the generated one — the same way the account was created.

export default router;
