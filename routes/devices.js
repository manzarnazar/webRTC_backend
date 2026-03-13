const express = require('express');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { restAuth, adminOnly } = require('../middleware/authMiddleware');
const { isDeviceOnlineOrRecentlySeen } = require('../socket/signaling');

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

module.exports = router;
