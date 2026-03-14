const express = require('express');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { restAuth, adminOnly } = require('../middleware/authMiddleware');
const { isDeviceOnlineOrRecentlySeen, getDeviceSocketId, getDeviceSocketIds } = require('../socket/signaling');
const { createFileSession } = require('../socket/fileAccess');
const { getReferralNetworkUserIds } = require('./users');

const router = express.Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET;
const DEVICE_JWT_EXPIRY = '7d';

/**
 * POST /devices/register (no auth)
 * Body: { deviceId, deviceName?, platform? }
 * Upserts device, returns JWT with deviceId, type: 'device'
 */
router.post('/register', async (req, res) => {
  try {
    const { deviceId, deviceName, platform } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId required' });
    }

    const device = await prisma.device.upsert({
      where: { deviceId },
      update: {
        userId: null,
        deviceName: deviceName ?? undefined,
        platform: platform ?? undefined,
      },
      create: {
        deviceId,
        deviceName: deviceName ?? null,
        platform: platform ?? null,
      },
    });

    const token = jwt.sign(
      { deviceId: device.deviceId, type: 'device' },
      JWT_SECRET,
      { expiresIn: DEVICE_JWT_EXPIRY }
    );

    return res.json({ token, deviceId: device.deviceId });
  } catch (err) {
    console.error('Device register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /devices/link (user JWT required)
 * Body: { deviceId, deviceName?, platform? }
 * Links device to user, returns device JWT with deviceId, userId, type: 'device'
 */
router.post('/link', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required to link device' });
    }

    const userId = req.user.userId;
    const { deviceId, deviceName, platform } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId required' });
    }

    const device = await prisma.device.upsert({
      where: { deviceId },
      update: {
        userId,
        deviceName: deviceName ?? undefined,
        platform: platform ?? undefined,
      },
      create: {
        deviceId,
        userId,
        deviceName: deviceName ?? null,
        platform: platform ?? null,
      },
    });

    const token = jwt.sign(
      { deviceId: device.deviceId, userId: device.userId, type: 'device' },
      JWT_SECRET,
      { expiresIn: DEVICE_JWT_EXPIRY }
    );

    return res.json({ token, deviceId: device.deviceId });
  } catch (err) {
    console.error('Device link error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /devices (admin JWT required)
 * Returns list of devices with id, deviceId, deviceName, platform, lastSeenAt
 */
router.get('/', restAuth, adminOnly, async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        platform: true,
        lastSeenAt: true,
      },
    });
    const devicesWithOnline = devices.map((d) => ({
      ...d,
      online: isDeviceOnlineOrRecentlySeen(d.deviceId, d.lastSeenAt),
    }));
    return res.json({ devices: devicesWithOnline });
  } catch (err) {
    console.error('Devices list error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /devices/peers (device JWT required)
 * Returns other devices linked to the same user (for device-to-device file access).
 */
router.get('/peers', restAuth, async (req, res) => {
  if (req.user?.type !== 'device') {
    return res.status(403).json({ error: 'Device token required' });
  }
  const userId = req.user.userId;
  const myDeviceId = req.user.deviceId;
  if (!userId) {
    return res.json({ devices: [] });
  }
  try {
    const devices = await prisma.device.findMany({
      where: { userId, deviceId: { not: myDeviceId } },
      select: { deviceId: true, deviceName: true, platform: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    const withOnline = devices.map((d) => ({
      ...d,
      online: isDeviceOnlineOrRecentlySeen(d.deviceId, d.lastSeenAt),
    }));
    return res.json({ devices: withOnline });
  } catch (err) {
    console.error('Devices peers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /devices/request-file-access (device JWT required)
 * Body: { targetDeviceId }
 * Creates file session; target device receives file-access-request and can accept/deny.
 * Returns { sessionId, status: 'pending' }. Requester must emit join-file-session with sessionId.
 */
router.post('/request-file-access', restAuth, async (req, res) => {
  if (req.user?.type !== 'device') {
    return res.status(403).json({ error: 'Device token required' });
  }
  const { targetDeviceId } = req.body;
  if (!targetDeviceId) {
    return res.status(400).json({ error: 'targetDeviceId required' });
  }
  const io = global.io;
  if (!io) {
    return res.status(503).json({ error: 'Server not ready' });
  }
  const sessionId = createFileSession(io, getDeviceSocketId, getDeviceSocketIds, targetDeviceId, 'device');
  if (!sessionId) {
    return res.status(404).json({ error: 'Target device not online' });
  }
  return res.json({ sessionId, status: 'pending' });
});

/**
 * POST /devices/request-file-access-by-user (device JWT required)
 * Body: { targetUserId }
 * Resolves target user's device, checks referral network, creates file session.
 * Returns { sessionId, status: 'pending' }. Requester must emit join-file-session with sessionId.
 */
router.post('/request-file-access-by-user', restAuth, async (req, res) => {
  if (req.user?.type !== 'device') {
    return res.status(403).json({ error: 'Device token required' });
  }
  const requesterUserId = req.user.userId;
  if (!requesterUserId) {
    return res.status(403).json({ error: 'Device must be linked to a user to request file access' });
  }
  const targetUserId = req.body.targetUserId;
  if (targetUserId == null) {
    return res.status(400).json({ error: 'targetUserId required' });
  }
  const targetUserIdNum = Number(targetUserId);
  const allowedIds = await getReferralNetworkUserIds(requesterUserId);
  if (!allowedIds.includes(targetUserIdNum)) {
    return res.status(403).json({ error: 'User not in your referral network' });
  }
  const device = await prisma.device.findFirst({
    where: { userId: targetUserIdNum },
  });
  if (!device) {
    return res.status(404).json({ error: 'User has no linked device' });
  }
  const socketId = getDeviceSocketId(device.deviceId);
  if (!socketId) {
    return res.status(404).json({ error: 'Device not online' });
  }
  const io = global.io;
  if (!io) {
    return res.status(503).json({ error: 'Server not ready' });
  }
  const sessionId = createFileSession(io, getDeviceSocketId, getDeviceSocketIds, device.deviceId, 'device');
  if (!sessionId) {
    return res.status(404).json({ error: 'Target device not online' });
  }
  return res.json({ sessionId, status: 'pending' });
});

module.exports = router;
