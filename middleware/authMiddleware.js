const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in environment');
}

/**
 * REST middleware: validate JWT from Authorization header.
 * Attaches decoded user to req.user.
 */
const restAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * Socket.IO middleware: validate JWT from handshake auth.
 * Expects client to pass { auth: { token: '...' } } on connect.
 */
const socketAuth = (socket, next) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error('Missing token'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
};

/**
 * Admin-only REST middleware. Use after restAuth.
 * Requires user JWT with isAdmin: true (rejects device JWT).
 */
const adminOnly = (req, res, next) => {
  if (req.user?.type === 'device') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * Check if socket has device JWT (type === 'device').
 */
const isDeviceSocket = (socket) => socket.user?.type === 'device';

/**
 * Check if socket has admin/user JWT (isAdmin).
 */
const isAdminSocket = (socket) => socket.user?.isAdmin === true;

module.exports = { restAuth, socketAuth, adminOnly, isDeviceSocket, isAdminSocket };
