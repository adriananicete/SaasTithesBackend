import jwt from 'jsonwebtoken';

// Token lifetimes (overridable via env)
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL = process.env.REFRESH_TOKEN_TTL || '7d';

// Refresh tokens are signed with a separate secret so a leaked access token
// can never be replayed against the refresh endpoint (and vice versa).
const refreshSecret = () =>
  process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET_KEY;

export const signAccessToken = (user) =>
  jwt.sign({ id: user._id ?? user.id, role: user.role }, process.env.JWT_SECRET_KEY, {
    expiresIn: ACCESS_TTL,
  });

export const signRefreshToken = (user) =>
  jwt.sign({ id: user._id ?? user.id, role: user.role }, refreshSecret(), {
    expiresIn: REFRESH_TTL,
  });

export const verifyRefreshToken = (token) => jwt.verify(token, refreshSecret());

// Cross-site cookies (FE and BE on different domains in prod) require
// SameSite=None + Secure. Locally everything is on localhost over http, so
// SameSite=Lax without Secure lets the cookie flow during development.
const isProd = () => process.env.NODE_ENV === 'production';

const baseCookieOptions = () => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: isProd() ? 'none' : 'lax',
  path: '/',
});

// Rough ms lifetimes mirroring the JWT expiry so the cookie and token expire together.
const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15m
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7d

export const setAuthCookies = (res, { accessToken, refreshToken }) => {
  res.cookie('access_token', accessToken, {
    ...baseCookieOptions(),
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie('refresh_token', refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_MAX_AGE,
  });
};

export const clearAuthCookies = (res) => {
  const opts = baseCookieOptions();
  res.clearCookie('access_token', opts);
  res.clearCookie('refresh_token', opts);
};
