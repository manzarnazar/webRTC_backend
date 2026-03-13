const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { restAuth } = require('../middleware/authMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '24h';

const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate referral code using crypto for strong uniqueness (10 chars = ~1e15 combinations). */
function generateReferralCode() {
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += REFERRAL_CHARS.charAt(bytes[i] % REFERRAL_CHARS.length);
  }
  return code;
}

async function ensureUniqueReferralCode() {
  let code;
  let exists = true;
  while (exists) {
    code = generateReferralCode();
    const found = await prisma.user.findUnique({ where: { referralCode: code } });
    exists = !!found;
  }
  return code;
}

/**
 * POST /auth/token
 * Body: { username, password, deviceId? }
 * Returns JWT with userId, username, isAdmin, deviceId
 */
router.post('/token', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const payload = {
      userId: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    };
    if (deviceId) payload.deviceId = deviceId;

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    return res.json({ token });
  } catch (err) {
    console.error('Auth token error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const REGISTRATION_BONUS = 50;
const REFERRAL_BONUS = 50;

/**
 * POST /auth/register
 * Body: { username, password, referralCode?, phoneNumber?, accountNumber?, bank? }
 * Creates user. referralCode optional; if provided, must belong to existing user.
 * New user gets 50 PKR. If referred, both referrer and referee get 50 PKR each.
 */
router.post('/register', async (req, res) => {
  try {
    const { username, password, referralCode, phoneNumber, accountNumber, bank } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    let referredById = null;
    if (referralCode && referralCode.trim()) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: referralCode.trim() } });
      if (!referrer) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      referredById = referrer.id;
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    let user;
    let initialBalance = REGISTRATION_BONUS;
    if (referredById) {
      initialBalance += REFERRAL_BONUS; // referee gets 50 + 50
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const newReferralCode = await ensureUniqueReferralCode();
      try {
        user = await prisma.user.create({
          data: {
            username,
            password: hash,
            referralCode: newReferralCode,
            referredById,
            phoneNumber: phoneNumber?.trim() || null,
            accountNumber: accountNumber?.trim() || null,
            bank: bank?.trim() || null,
            walletBalance: initialBalance,
          },
        });
        break;
      } catch (err) {
        if (err.code === 'P2002' && attempt < 4) continue;
        throw err;
      }
    }
    if (!user) throw new Error('Failed to create user');

    await prisma.walletTransaction.create({
      data: {
        userId: user.id,
        amount: initialBalance,
        type: referredById ? 'referral_reward' : 'registration',
      },
    });

    if (referredById) {
      await prisma.user.update({
        where: { id: referredById },
        data: { walletBalance: { increment: REFERRAL_BONUS } },
      });
      await prisma.walletTransaction.create({
        data: {
          userId: referredById,
          amount: REFERRAL_BONUS,
          type: 'referral_bonus',
        },
      });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, isAdmin: user.isAdmin },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        referralCode: user.referralCode,
        walletBalance: Number(user.walletBalance),
      },
    });
  } catch (err) {
    console.error('Auth register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/me
 * Requires user JWT. Returns current user with referralCode.
 */
router.get('/me', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        username: true,
        referralCode: true,
        isAdmin: true,
        walletBalance: true,
        reservedAmount: true,
        reservedAt: true,
        bank: true,
        accountNumber: true,
        phoneNumber: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Explicitly return DB values (never JWT payload) so referralCode always matches database
    const body = {
      id: user.id,
      username: user.username,
      referralCode: user.referralCode,
      isAdmin: user.isAdmin,
      walletBalance: Number(user.walletBalance),
      reservedAmount: Number(user.reservedAmount),
      reservedAt: user.reservedAt ? user.reservedAt.toISOString() : null,
      bank: user.bank ?? null,
      accountNumber: user.accountNumber ?? null,
      phoneNumber: user.phoneNumber ?? null,
    };
    console.log('[auth/me] userId=%d username=%s referralCode=%s (from DB)', user.id, user.username, user.referralCode);
    return res.json(body);
  } catch (err) {
    console.error('Auth me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/change-password
 * Change password for current user. Requires user JWT.
 * Body: { currentPassword, newPassword }
 */
router.post('/change-password', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Current password required' });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { password: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { password: hash },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Auth change-password error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /auth/me
 * Update current user profile: phoneNumber, accountNumber, bank.
 * Body: { phoneNumber?, accountNumber?, bank? }
 */
router.patch('/me', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const { phoneNumber, accountNumber, bank } = req.body;
    const data = {};
    if (phoneNumber !== undefined) data.phoneNumber = phoneNumber?.trim() || null;
    if (accountNumber !== undefined) data.accountNumber = accountNumber?.trim() || null;
    if (bank !== undefined) data.bank = bank?.trim() || null;

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data,
      select: { id: true, username: true, phoneNumber: true, accountNumber: true, bank: true },
    });

    return res.json({
      id: user.id,
      username: user.username,
      phoneNumber: user.phoneNumber ?? null,
      accountNumber: user.accountNumber ?? null,
      bank: user.bank ?? null,
    });
  } catch (err) {
    console.error('Auth patch me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
