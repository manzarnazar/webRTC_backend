const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const REFERRAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin', 10);

  const existing = await prisma.user.findFirst({ where: { isAdmin: true } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { username, password: hash },
    });
    console.log('Updated admin user:', username, '| Referral code:', existing.referralCode);
    return;
  }

  const referralCode = await ensureUniqueReferralCode();
  const admin = await prisma.user.create({
    data: {
      username,
      password: hash,
      referralCode,
      isAdmin: true,
    },
  });
  console.log('Created admin user:', admin.username, '| Referral code:', admin.referralCode);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
