import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { User } from '../../models/User.js';
import {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    setAuthCookies,
    clearAuthCookies,
} from '../../utils/authTokens.js';
import { sendPasswordResetEmail } from '../../utils/email.js';
import { recordAudit } from '../../utils/recordAudit.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const hashResetToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export const userLogin = async (req, res, next) => {
    const { email, password } = req.body;

    try {
        // Find if user exist
    const findUser = await User.findOne({ email });
    if (!findUser) return res.status(400).json({error: 'User not Found'});

    // checks if the user is Active
    if (!findUser.isActive) return res.status(403).json({error: 'User Deactivated'});

    // checks the password
    const isMatch = await bcrypt.compare(password, findUser.password);
     if (!isMatch) return res.status(400).json({error: 'Invalid Credentials'});

    // Issue short-lived access + long-lived refresh tokens as httpOnly cookies.
    const accessToken = signAccessToken(findUser);
    const refreshToken = signRefreshToken(findUser);
    setAuthCookies(res, { accessToken, refreshToken });

    res.status(200).json({
        status: 'Login Successfull',
        data: {
            id: findUser._id,
            name: findUser.name,
            email: findUser.email,
            role: findUser.role,
            avatarUrl: findUser.avatarUrl,
        },
        // Still returned for backward compatibility with header-based clients
        // during the cookie-auth transition. New clients ignore this.
        token: accessToken
    });
    } catch (error) {
        next(error);
    }

};

// Exchange a valid refresh cookie for a fresh access token (and a rotated
// refresh token). Returns 401 if the refresh cookie is missing/invalid so the
// client falls through to logout.
export const refreshAccessToken = async (req, res, next) => {
    try {
        const token = req.cookies?.refresh_token;
        if (!token) return res.status(401).json({ error: 'No refresh token' });

        const decoded = verifyRefreshToken(token);

        // Ensure the user still exists and is active before re-issuing.
        const user = await User.findById(decoded.id);
        if (!user || !user.isActive) {
            clearAuthCookies(res);
            return res.status(401).json({ error: 'User no longer active' });
        }

        const accessToken = signAccessToken(user);
        const refreshToken = signRefreshToken(user);
        setAuthCookies(res, { accessToken, refreshToken });

        res.status(200).json({ status: 'Token refreshed', token: accessToken });
    } catch (error) {
        clearAuthCookies(res);
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
};

export const userLogout = async (req, res, next) => {
    clearAuthCookies(res);
    res.status(200).json({
        status: 'Success',
        data: {
            message: 'User Logged out!'
        }
    })
};

// Step 1 of reset: always respond 200 (never reveal whether the email exists,
// to avoid leaking which addresses are registered). If the user exists, store a
// hashed, time-limited token and email the raw token as a reset link.
export const forgotPassword = async (req, res, next) => {
    const { email } = req.body;
    try {
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const user = await User.findOne({ email });
        if (user && user.isActive) {
            const rawToken = crypto.randomBytes(32).toString('hex');
            user.resetPasswordToken = hashResetToken(rawToken);
            user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
            await user.save();

            await recordAudit({
                actor: { id: user._id, role: user.role, name: user.name },
                action: 'auth.forgot_password',
                targetModel: 'User',
                targetId: user._id,
                targetRef: user.email,
                summary: 'Requested a password reset link',
            });

            const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
            const resetLink = `${base}/reset-password?token=${rawToken}`;
            try {
                await sendPasswordResetEmail(user.email, resetLink);
            } catch (mailErr) {
                // Don't leak mail failures to the client, but surface server-side.
                console.error('[forgotPassword] email send failed:', mailErr?.message || mailErr);
            }
        }

        return res.status(200).json({
            status: 'Success',
            data: { message: 'If that email is registered, a reset link has been sent.' },
        });
    } catch (error) {
        next(error);
    }
};

// Step 2 of reset: verify the hashed token + expiry, set the new password.
export const resetPassword = async (req, res, next) => {
    const { token, password } = req.body;
    try {
        if (!token || !password) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const user = await User.findOne({
            resetPasswordToken: hashResetToken(token),
            resetPasswordExpires: { $gt: new Date() },
        });
        if (!user) {
            return res.status(400).json({ error: 'Reset link is invalid or has expired' });
        }

        user.password = await bcrypt.hash(password, 10);
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save();

        await recordAudit({
            actor: { id: user._id, role: user.role, name: user.name },
            action: 'auth.reset_password',
            targetModel: 'User',
            targetId: user._id,
            targetRef: user.email,
            summary: 'Reset password via email link',
        });

        return res.status(200).json({
            status: 'Success',
            data: { message: 'Password has been reset. You can now log in.' },
        });
    } catch (error) {
        next(error);
    }
};
