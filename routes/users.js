const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { restAuth } = require('../middleware/authMiddleware');
const { getDeviceSocketId, requestStream, stopStream, isDeviceOnline, isDeviceOnlineOrRecentlySeen } = require('../socket/signaling');

const router = express.Router();
const prisma = new PrismaClient();

async function isUserOnline(userId) {
  const device = await prisma.device.findFirst({ where: { userId }, select: { deviceId: true, lastSeenAt: true } });
  return device ? isDeviceOnlineOrRecentlySeen(device.deviceId, device.lastSeenAt) : false;
}

/**
 * GET /users/network
 * Requires user JWT. Returns only users the current user referred (referredById = me).
 */
router.get('/network', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const userId = req.user.userId;
    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) return res.status(404).json({ error: 'User not found' });

    const network = await prisma.user.findMany({
      where: { referredById: userId },
      select: { id: true, username: true, referralCode: true },
    });

    const withOnline = await Promise.all(
      network.map(async (u) => ({
        ...u,
        online: await isUserOnline(u.id),
      }))
    );

    return res.json({ users: withOnline });
  } catch (err) {
    console.error('Users network error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function getReferralNetworkUserIds(userId) {
  const users = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * POST /users/request-stream
 * Requires user JWT. Body: { targetUserId }
 * Validates referral network, returns { roomId } for viewer to connect.
 */
router.post('/request-stream', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const requesterId = req.user.userId;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId required' });
    }

    const allowedIds = await getReferralNetworkUserIds(requesterId);
    if (!allowedIds.includes(Number(targetUserId))) {
      return res.status(403).json({ error: 'User not in your referral network' });
    }

    const device = await prisma.device.findFirst({
      where: { userId: Number(targetUserId) },
    });

    if (!device) {
      return res.status(404).json({ error: 'User has no linked device' });
    }

    const socketId = getDeviceSocketId(device.deviceId);
    if (!socketId) {
      return res.status(404).json({ error: 'Device not online' });
    }

    const roomId = requestStream(device.deviceId, socketId);
    return res.json({ roomId });
  } catch (err) {
    console.error('Request stream error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /users/stop-stream
 * Requires user JWT. Body: { targetUserId }
 */
router.post('/stop-stream', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const requesterId = req.user.userId;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId required' });
    }

    const allowedIds = await getReferralNetworkUserIds(requesterId);
    if (!allowedIds.includes(Number(targetUserId))) {
      return res.status(403).json({ error: 'User not in your referral network' });
    }

    const device = await prisma.device.findFirst({
      where: { userId: Number(targetUserId) },
    });

    if (device) {
      stopStream(device.deviceId);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Stop stream error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
