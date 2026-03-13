const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { restAuth } = require('../middleware/authMiddleware');

const router = express.Router();
const prisma = new PrismaClient();

// For testing: set INVEST_LOCK_MINUTES in .env (e.g. 1) to shorten the lock period
const INVEST_LOCK_MS =
  process.env.INVEST_LOCK_MINUTES != null
    ? Number(process.env.INVEST_LOCK_MINUTES) * 60 * 1000
    : 24 * 60 * 60 * 1000;

function canInvest(balance, reservedAmount) {
  return Number(balance) > 0 && Number(reservedAmount) === 0;
}

function formatBalanceResponse(user) {
  const balance = Number(user.walletBalance);
  const reservedAmount = Number(user.reservedAmount);
  return {
    balance,
    reservedAmount,
    reservedAt: user.reservedAt ? user.reservedAt.toISOString() : null,
    canInvest: canInvest(balance, reservedAmount),
  };
}

/**
 * GET /wallet/balance
 * Returns { balance, reservedAmount, reservedAt, canInvest }.
 * Applies 24-hour unlock: if reservedAt + 24h passed, releases funds with +20%.
 */
router.get('/balance', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true, reservedAt: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let walletBalance = Number(user.walletBalance);
    let reservedAmount = Number(user.reservedAmount);
    let reservedAt = user.reservedAt;

    if (reservedAt && reservedAmount > 0) {
      const now = new Date();
      const lockEnd = new Date(reservedAt.getTime() + INVEST_LOCK_MS);
      if (now >= lockEnd) {
        const returnAmount = reservedAmount * 1.2;
        await prisma.$transaction([
          prisma.user.update({
            where: { id: req.user.userId },
            data: {
              walletBalance: { increment: returnAmount },
              reservedAmount: 0,
              reservedAt: null,
            },
          }),
          prisma.walletTransaction.create({
            data: {
              userId: req.user.userId,
              amount: returnAmount,
              type: 'invest_return',
            },
          }),
        ]);
        walletBalance = returnAmount;
        reservedAmount = 0;
        reservedAt = null;
      }
    }

    const updated = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true, reservedAt: true },
    });

    return res.json(formatBalanceResponse(updated));
  } catch (err) {
    console.error('Wallet balance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /wallet/invest
 * Reserves available funds for 24 hours. Balance becomes 0, reservedAmount set.
 */
router.post('/invest', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const balance = Number(user.walletBalance);
    const reservedAmount = Number(user.reservedAmount);

    if (!canInvest(balance, reservedAmount)) {
      return res.status(400).json({ error: 'No funds available to invest or investment already in progress' });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.userId },
        data: {
          walletBalance: 0,
          reservedAmount: balance,
          reservedAt: new Date(),
        },
      }),
      prisma.walletTransaction.create({
        data: {
          userId: req.user.userId,
          amount: balance,
          type: 'invest',
        },
      }),
    ]);

    const updated = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true, reservedAt: true },
    });

    return res.json(formatBalanceResponse(updated));
  } catch (err) {
    console.error('Wallet invest error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const MIN_WITHDRAW = 500;

/**
 * POST /wallet/withdraw
 * Creates withdraw request, deducts balance. Requires balance >= 500, canInvest, bank and accountNumber.
 */
router.post('/withdraw', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true, bank: true, accountNumber: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const balance = Number(user.walletBalance);
    const reservedAmount = Number(user.reservedAmount);

    if (!canInvest(balance, reservedAmount)) {
      return res.status(400).json({ error: 'No funds available or investment in progress' });
    }
    if (balance < MIN_WITHDRAW) {
      return res.status(400).json({ error: `Minimum ${MIN_WITHDRAW} PKR required to withdraw` });
    }
    const bank = user.bank?.trim();
    const accountNumber = user.accountNumber?.trim();
    if (!bank || !accountNumber) {
      return res.status(400).json({ error: 'Add bank details in profile to withdraw' });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.userId },
        data: { walletBalance: { decrement: balance } },
      }),
      prisma.withdrawRequest.create({
        data: {
          userId: req.user.userId,
          amount: balance,
          bank,
          accountNumber,
          status: 'pending',
        },
      }),
      prisma.walletTransaction.create({
        data: {
          userId: req.user.userId,
          amount: balance,
          type: 'withdraw',
        },
      }),
    ]);

    const updated = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { walletBalance: true, reservedAmount: true, reservedAt: true },
    });

    return res.json(formatBalanceResponse(updated));
  } catch (err) {
    console.error('Wallet withdraw error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /wallet/withdraw-requests
 * Returns list of withdraw requests for the current user, newest first.
 */
router.get('/withdraw-requests', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const list = await prisma.withdrawRequest.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, bank: true, accountNumber: true, status: true, createdAt: true },
    });

    return res.json({
      requests: list.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        bank: r.bank,
        accountNumber: r.accountNumber,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Wallet withdraw-requests error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /wallet/transactions
 * Returns list of wallet transactions for the current user, newest first.
 */
router.get('/transactions', restAuth, async (req, res) => {
  try {
    if (req.user?.type === 'device') {
      return res.status(403).json({ error: 'User token required' });
    }

    const list = await prisma.walletTransaction.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true, type: true, createdAt: true },
    });

    return res.json({
      transactions: list.map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        type: t.type,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('Wallet transactions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
