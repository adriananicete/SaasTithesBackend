import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import { connectDB } from './src/config/db.js';
import { notFound, errorHandler } from './src/middlewares/errorHandler.js';
import authRoutes from './src/routes/auth/authRoutes.js';
import adminUserRoutes  from './src/routes/admin/userRoutes.js';
import userRoutes from './src/routes/userRoutes.js';
import categoryRoutes from './src/routes/admin/categoryRoutes.js';
import tithesRoutes from './src/routes/tithesRoutes.js';
import requestFormRoutes from './src/routes/requestFormRoutes.js';
import voucherRoutes from './src/routes/voucherRoutes.js';
import expenseRoutes from './src/routes/expenseRoutes.js';
import notificationRoutes from './src/routes/notificationRoutes.js';
import reportRoutes from './src/routes/reportRoutes.js';
import searchRoutes from './src/routes/searchRoutes.js';
import auditRoutes from './src/routes/auditRoutes.js';
import pushRoutes from './src/routes/pushRoutes.js';
import presenceRoutes from './src/routes/presenceRoutes.js';
import churchProfileRoutes from './src/routes/churchProfileRoutes.js';
import superadminChurchRoutes from './src/routes/superadmin/churchRoutes.js';
import superadminDashboardRoutes from './src/routes/superadmin/dashboardRoutes.js';
import { setIO } from './src/services/realtime.js';

const PORT = process.env.PORT || 7002;
const app = express();

// Render runs behind a proxy — needed for correct client IP (rate limiting)
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const corsOriginCheck = (origin, cb) => {
    if (!origin) return cb(null, true); // non-browser clients (curl, server-to-server)
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
};

app.use(cors({
    origin: corsOriginCheck,
    credentials: true,
}));

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.use('/api/auth', authRoutes);
app.use('/api/admin/users', adminUserRoutes );
app.use('/api/admin/categories', categoryRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tithes', tithesRoutes);
app.use('/api/request-form', requestFormRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/audit-log', auditRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/church', churchProfileRoutes);
app.use('/api/superadmin/churches', superadminChurchRoutes);
app.use('/api/superadmin/dashboard', superadminDashboardRoutes);

// 404 + centralized error handling — must be last
app.use(notFound);
app.use(errorHandler);

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
    cors: {
        origin: corsOriginCheck,
        credentials: true,
    },
});

// Parse the access_token cookie off the websocket handshake (cookies ride the
// upgrade request just like any HTTP request), falling back to the auth payload.
const readSocketToken = (socket) => {
    const fromAuth = socket.handshake.auth?.token;
    if (fromAuth) return fromAuth;
    const cookieHeader = socket.handshake.headers?.cookie;
    if (!cookieHeader) return null;
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('access_token='));
    return match ? decodeURIComponent(match.slice('access_token='.length)) : null;
};

io.use((socket, next) => {
    const token = readSocketToken(socket);
    if (!token) return next(new Error('Authentication required'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
        socket.userId = decoded.id;
        socket.role = decoded.role;
        // Carried so a later branch can broadcast per church without having to
        // enumerate every user id first.
        socket.church = decoded.church ?? null;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    socket.join(String(socket.userId));
});

setIO(io);

connectDB().then(() => {
    httpServer.listen(PORT, () => console.log(`Server is running on port: ${PORT}`));
});
