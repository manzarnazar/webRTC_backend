const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { restAuth, adminOnly } = require('../middleware/authMiddleware');
const { requestStream, getDeviceSocketId, getDeviceSocketIds } = require('../socket/signaling');
const { createFileSession, closeSession, closeSessionByDeviceId } = require('../socket/fileAccess');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * POST /admin/request-stream (admin JWT required)
 * Body: { deviceId }
 * Emits start-stream to device, returns { roomId } for admin to connect as viewer
 */
router.post('/request-stream', restAuth, adminOnly, (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId required' });
  }

  const socketId = getDeviceSocketId(deviceId);
  if (!socketId) {
    return res.status(404).json({ error: 'Device not online' });
  }

  const roomId = requestStream(deviceId, socketId);
  return res.json({ roomId });
});

/**
 * POST /admin/stop-stream (admin JWT required)
 * Body: { deviceId }
 * Emits stop-stream to device
 */
router.post('/stop-stream', restAuth, adminOnly, (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId required' });
  }

  const { stopStream } = require('../socket/signaling');
  stopStream(deviceId);
  return res.json({ ok: true });
});

/**
 * POST /admin/request-file-access (admin JWT required)
 * Body: { deviceId }
 * Creates file session, notifies device; device auto-accepts for admin. Returns { sessionId }.
 */
router.post('/request-file-access', restAuth, adminOnly, (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId required' });
  }
  const io = global.io;
  if (!io) {
    return res.status(503).json({ error: 'Server not ready' });
  }
  const sessionId = createFileSession(io, getDeviceSocketId, getDeviceSocketIds, deviceId, 'admin');
  if (!sessionId) {
    return res.status(404).json({ error: 'Device not online' });
  }
  return res.json({ sessionId });
});

/**
 * POST /admin/stop-file-access (admin JWT required)
 * Body: { sessionId } or { deviceId }
 */
router.post('/stop-file-access', restAuth, adminOnly, (req, res) => {
  const { sessionId, deviceId } = req.body;
  if (sessionId) {
    closeSession(sessionId);
  } else if (deviceId) {
    closeSessionByDeviceId(deviceId);
  } else {
    return res.status(400).json({ error: 'sessionId or deviceId required' });
  }
  return res.json({ ok: true });
});

/**
 * GET /admin/withdraw-requests (admin JWT required)
 * Returns list of withdraw requests with user info, ordered by createdAt desc.
 */
router.get('/withdraw-requests', restAuth, adminOnly, async (req, res) => {
  try {
    const requests = await prisma.withdrawRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true } },
      },
    });
    return res.json({
      requests: requests.map((r) => ({
        id: r.id,
        username: r.user.username,
        amount: Number(r.amount),
        bank: r.bank,
        accountNumber: r.accountNumber,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Admin withdraw-requests error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
