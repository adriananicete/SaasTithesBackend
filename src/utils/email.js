import nodemailer from 'nodemailer';

// Lazily build the Gmail transporter so the app still boots without mail creds
// configured (email simply no-ops + logs the link in that case).
let transporter = null;
const getTransporter = () => {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER,
                // A Gmail "App Password" (requires 2FA on the account), NOT the
                // normal account password.
                pass: process.env.GMAIL_APP_PASSWORD,
            },
        });
    }
    return transporter;
};

const FROM =
    process.env.EMAIL_FROM ||
    `JOSCM Tithes <${process.env.GMAIL_USER || 'noreply@example.com'}>`;

export const sendPasswordResetEmail = async (to, resetLink) => {
    const tx = getTransporter();
    if (!tx) {
        // Dev fallback: no creds configured, so log the link instead of sending.
        console.warn(`[email] GMAIL creds not set — reset link for ${to}: ${resetLink}`);
        return;
    }

    const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937">
            <h2 style="color:#2f6a7a">JOSCM Tithes App</h2>
            <p>We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong>1 hour</strong>.</p>
            <p style="margin:24px 0">
                <a href="${resetLink}" style="background:#2f6a7a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">Reset Password</a>
            </p>
            <p style="font-size:13px;color:#6b7280">If you didn't request this, you can safely ignore this email — your password won't change.</p>
            <p style="font-size:12px;color:#9ca3af;word-break:break-all">Or paste this link into your browser:<br>${resetLink}</p>
        </div>
    `;

    await tx.sendMail({
        from: FROM,
        to,
        subject: 'Reset your JOSCM Tithes password',
        html,
    });
};
