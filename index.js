require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const deviceRoutes = require('./routes/devices');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/users');
const walletRoutes = require('./routes/wallet');
const { restAuth, socketAuth, adminOnly } = require('./middleware/authMiddleware');
const { attachSignaling, getActiveRooms, getDeviceSocketId } = require('./socket/signaling');
const { attachFileAccess } = require('./socket/fileAccess');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

// Rate limit auth endpoints
app.use(
  '/auth',
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many requests' },
  })
);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Remote Streaming Signaling Server' });
});

// Public ICE/TURN config for WebRTC clients (admin viewer, etc.)
function getIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  const turnUrl = process.env.TURN_SERVER_URL;
  const turnUser = process.env.TURN_USERNAME;
  const turnCred = process.env.TURN_CREDENTIAL;
  if (turnUrl && turnUser && turnCred) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
    const turnTcp = turnUrl.replace(/^turn:/, 'turn:').replace(/\?.*$/, '') + '?transport=tcp';
    servers.push({ urls: turnTcp, username: turnUser, credential: turnCred });
  }
  return servers;
}

app.get('/config', (req, res) => {
  res.json({ iceServers: getIceServers() });
});

app.use(express.static('public'));
app.use('/auth', authRoutes);
app.use('/devices', deviceRoutes);
app.use('/admin', adminRoutes);
app.use('/users', userRoutes);
app.use('/wallet', walletRoutes);

app.get('/sessions', restAuth, adminOnly, (req, res) => {
  const sessions = getActiveRooms();
  res.json({ sessions });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 50e6,
});

io.use(socketAuth);
attachSignaling(io);
attachFileAccess(io, getDeviceSocketId);

httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
