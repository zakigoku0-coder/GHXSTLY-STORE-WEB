const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const OUT_FILE = path.join(__dirname, 'admin-codes.txt');

const WALLET_DENOMS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const WALLET_TOTAL = 100;
const PROMO_DISCOUNTS = [20, 25, 30, 35, 40, 45, 50];
const PROMO_TOTAL = 100;

console.log('Resetting database…');
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const store = require('./store');
require('./seed.js');

console.log(`Generating ${WALLET_TOTAL} single-use wallet codes…`);
const walletCodes = [];
const perDenom = Math.floor(WALLET_TOTAL / WALLET_DENOMS.length);
let remaining = WALLET_TOTAL;
WALLET_DENOMS.forEach((amount, i) => {
  const n = i === WALLET_DENOMS.length - 1 ? remaining : perDenom;
  remaining -= n;
  walletCodes.push(...store.createWalletCodes(amount, n));
});

console.log(`Generating ${PROMO_TOTAL} single-use promo codes…`);
const promoLines = [];
const perDiscount = Math.floor(PROMO_TOTAL / PROMO_DISCOUNTS.length);
for (let i = 0; i < PROMO_DISCOUNTS.length; i++) {
  const n = i === PROMO_DISCOUNTS.length - 1 ? PROMO_TOTAL - perDiscount * (PROMO_DISCOUNTS.length - 1) : perDiscount;
  for (let j = 0; j < n; j++) {
    const code = `GHX-${PROMO_DISCOUNTS[i]}-${store.generateCode(10)}`;
    store.addPromoCode(code, PROMO_DISCOUNTS[i], 1);
    promoLines.push(code);
  }
}

const lines = [];
lines.push('==============================================');
lines.push('GHXSTLY STORE - CODES');
lines.push('Keep this file PRIVATE. Never upload it.');
lines.push('==============================================');
lines.push('');
lines.push(`WALLET RECHARGE CODES (${walletCodes.length} total, single use):`);
walletCodes.forEach(code => lines.push(`  ${code}`));
lines.push('');
lines.push(`PROMO CODES (${promoLines.length} total, single use):`);
promoLines.forEach(code => lines.push(`  ${code}`));
fs.writeFileSync(OUT_FILE, lines.join('\n'));

console.log(`Done. Wallet codes: ${walletCodes.length}, Promo codes: ${promoLines.length}`);
console.log(`Codes saved to: ${OUT_FILE}`);
console.log('This file is NOT served by the website.');