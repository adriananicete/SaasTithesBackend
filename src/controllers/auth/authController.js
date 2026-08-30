import bcrypt from 'bcrypt';
import { User } from '../../models/User.js';
import { Church } from '../../models/Church.js';
import { isValidObjectId } from '../../utils/validate.js';
import { ROLES } from '../../constants/roles.js';
import {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    setAuthCookies,
    clearAuthCookies,
} from '../../utils/authTokens.js';
import { recordAudit } from '../../utils/recordAudit.js';


export const userLogin = async (req, res, next) => {
    const { email, password, church } = req.body;

    try {
    // Which church the user belongs to is part of their identity now: email is
    // only unique within a church, so the same address can exist in two of
    // them. Omitting church matches the superadmin only, which is why the
    // owner needs no dropdown.
    let findUser;
    if (church) {
        if (!isValidObjectId(church))
            return res.status(400).json({ error: 'Invalid church selected' });

        const selectedChurch = await Church.findById(church);
        if (!selectedChurch || selectedChurch.deletedAt)
            return res.status(400).json({ error: 'Church not found' });
        if (!selectedChurch.isActive)
            return res.status(403).json({ error: 'This church is currently deactivated. Contact your system administrator.' });

        findUser = await User.findOne({ church, email });
    } else {
        findUser = await User.findOne({ church: null, email, role: ROLES.SUPERADMIN });
        // A church member who forgot to pick one gets told what is missing,
        // rather than a misleading "user not found".
        if (!findUser && (await User.exists({ email })))
            return res.status(400).json({ error: 'Select your church to sign in' });
    }

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
            church: findUser.church,
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

        // A church that was deactivated or deleted mid-session ends here too.
        // This lookup already costs a round trip, so the check is free; the
        // per-request guard that closes the remaining window is separate.
        if (user.church) {
            const church = await Church.findById(user.church).select('isActive deletedAt');
            if (!church || !church.isActive || church.deletedAt) {
                clearAuthCookies(res);
                return res.status(403).json({ error: 'This church is no longer active' });
            }
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
