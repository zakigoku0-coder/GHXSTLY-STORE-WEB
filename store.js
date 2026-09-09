const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  accounts: [],
  walletCodes: [],
  promoCodes: [],
  transactions: [],
  sessions: [],
  users: []
};

let db = load();

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    return { ...DEFAULT_DB };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...DEFAULT_DB, ...parsed };
  } catch (err) {
    console.error('Corrupt database file, starting fresh:', err.message);
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    return { ...DEFAULT_DB };
  }
}

let saveTimer = null;
let dirty = false;
let lastOwnWriteMs = 0;
function save() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      skipNextWatch = true;
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
      try { lastOwnWriteMs = fs.statSync(DB_FILE).mtimeMs; } catch (_) {}
      dirty = false;
    } catch (err) {
      console.error('Failed to save database:', err.message);
    }
  }, 25);
}

let skipNextWatch = false;
function pushWatch(eventType, filename) {
  if (filename && filename !== 'db.json') return;
  if (dirty) return;
  try {
    let mtime = 0;
    try { mtime = fs.statSync(DB_FILE).mtimeMs; } catch (e) { return; }
    if (mtime <= lastOwnWriteMs) return; // our own write, not an external change
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = { ...DEFAULT_DB, ...parsed };
  } catch (_) { /* ignore transient read errors */ }
}
try { fs.watch(DATA_DIR, { persistent: false }, pushWatch); } catch (_) {}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function generateOrderCode() {
  const time = Date.now().toString(36).toUpperCase();
  return `GHX-${time}-${generateCode(8)}-${generateCode(4)}`;
}

/* ---------- Digital goods (Tweaks / Macro) ---------- */

const DIGITAL_CATALOG = [
  { id: 'tweaks-normal', type: 'Tweaks', name: 'Tweaks — Normal', price: 0, limited: false },
  { id: 'tweaks-premium', type: 'Tweaks', name: 'Tweaks — Premium', price: 10, limited: false },
  { id: 'macro-normal', type: 'Macro', name: 'Macro — Normal', price: 5, limited: false },
  { id: 'macro-premium', type: 'Macro', name: 'Macro — Premium', price: 10, limited: false },
  { id: 'macro-unlimited', type: 'Macro', name: 'Macro — Unlimited', price: 30, limited: false }
];

function listDigitals() {
  return DIGITAL_CATALOG.map(i => {
    const stock = i.limited ? digitalStock(i.id) : null;
    return {
      id: i.id,
      type: i.type,
      name: i.name,
      price: i.price,
      limited: i.limited,
      stock,
      saleable: !i.limited || stock > 0
    };
  });
}

function digitalStock(itemId) {
  if (!db.digitalStock) db.digitalStock = {};
  if (db.digitalStock[itemId] == null) db.digitalStock[itemId] = 10;
  return db.digitalStock[itemId];
}

function buyDigital(itemId, sessionToken, discordName) {
  const item = DIGITAL_CATALOG.find(i => i.id === itemId);
  if (!item) return { ok: false, error: 'Invalid item.' };
  if (item.limited && digitalStock(itemId) <= 0) {
    return { ok: false, error: 'This limited item is sold out.' };
  }
  const session = getSession(sessionToken);
  if (!session) return { ok: false, error: 'Session missing' };
  if (session.balance < item.price) {
    return { ok: false, error: 'Insufficient wallet balance.', need: item.price, balance: session.balance };
  }
  session.balance = Math.max(0, Math.round((session.balance - item.price) * 100) / 100);
  if (item.limited) db.digitalStock[itemId] = Math.max(0, digitalStock(itemId) - 1);
  const tx = createTransaction({
    sessionToken,
    accountId: itemId,
    accountName: item.name,
    amount: item.price,
    promoCode: null,
    discount: 0,
    discordName: discordName || null
  });
  save();
  return { ok: true, tx };
}

/* ---------- Sessions ---------- */

function getOrCreateSession(sessionToken) {
  let session = db.sessions.find(s => s.token === sessionToken);
  if (!session) {
    session = { token: sessionToken, balance: 0, userId: null, createdAt: Date.now() };
    db.sessions.push(session);
    save();
  }
  return session;
}

function getSession(sessionToken) {
  return db.sessions.find(s => s.token === sessionToken) || null;
}

function syncUserBalance(sessionToken) {
  const session = getSession(sessionToken);
  if (!session || !session.userId) return;
  const user = db.users.find(u => u.uid === session.userId);
  if (user) user.balance = session.balance;
}

function setBalance(sessionToken, balance) {
  const session = getSession(sessionToken);
  session.balance = Math.max(0, Math.round(balance * 100) / 100);
  syncUserBalance(sessionToken);
  save();
  return session.balance;
}

/* ---------- Accounts (email/password + Google) ---------- */

function getUserById(uid) {
  return db.users.find(u => u.uid === uid) || null;
}

function findUserByEmail(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return db.users.find(u => u.email && u.email.toLowerCase() === e) || null;
}

function findUserByGoogleSub(googleSub) {
  return db.users.find(u => u.googleSub === googleSub) || null;
}

function hashPassword(password) {
  if (password.length > 200) return null;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  try {
    const [saltHex, hashHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const hash = Buffer.from(hashHex, 'hex');
    const test = crypto.scryptSync(String(password), salt, 64);
    return test.length === hash.length && crypto.timingSafeEqual(test, hash);
  } catch (_) {
    return false;
  }
}

function createUser({ name, email, password, googleSub, picture }) {
  let user = findUserByEmail(email) || (googleSub && findUserByGoogleSub(googleSub));
  if (user) {
    if (email && !user.email) user.email = String(email).trim().toLowerCase();
    if (name && !user.name) user.name = name;
    if (picture && !user.picture) user.picture = picture;
    if (googleSub && !user.googleSub) user.googleSub = googleSub;
    if (password && !user.passwordHash) user.passwordHash = hashPassword(password);
    save();
    return user;
  }
  user = {
    uid: randomToken(8),
    name: name || (email ? email.split('@')[0] : 'Buyer'),
    email: email ? String(email).trim().toLowerCase() : '',
    picture: picture || '',
    googleSub: googleSub || null,
    passwordHash: password ? hashPassword(password) : null,
    balance: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  save();
  return user;
}

function bindUserToSession(sessionToken, uid) {
  const session = getSession(sessionToken);
  if (!session) return null;
  const user = getUserById(uid);
  if (!user) return null;
  session.userId = user.uid;
  // carry the user's stored balance onto this device
  session.balance = Math.max(session.balance, user.balance || 0);
  user.balance = session.balance;
  save();
  return session;
}

function getUserForSession(sessionToken) {
  const session = getSession(sessionToken);
  if (!session || !session.userId) return null;
  const user = getUserById(session.userId);
  if (!user) return null;
  const safe = { ...user };
  delete safe.passwordHash;
  return safe;
}

function logoutUser(sessionToken) {
  const session = getSession(sessionToken);
  if (!session) return;
  syncUserBalance(sessionToken);
  session.userId = null;
  save();
}

function listOrdersForUser(uid) {
  return db.transactions
    .filter(t => t.userId === uid || t.sessionToken && db.sessions.some(s => s.token === t.sessionToken && s.userId === uid))
    .reverse();
}

/* ---------- Accounts ---------- */

function listAccounts(includeSold = false) {
  return db.accounts
    .filter(a => includeSold || a.status !== 'sold')
    .sort((a, b) => a.id - b.id)
    .map(a => ({ ...a }));
}

function getAccount(id) {
  return db.accounts.find(a => a.id === id) || null;
}

function addAccount(account) {
  if (account.id == null) {
    account.id = db.accounts.reduce((max, a) => Math.max(max, a.id), 0) + 1;
  }
  account.status = account.status || 'available';
  account.stock = account.stock == null ? 50 : account.stock;
  db.accounts.push(account);
  save();
  return account;
}

function markAccountSold(id) {
  const account = getAccount(id);
  if (!account) return false;
  account.status = 'sold';
  save();
  return true;
}

function decrementStock(id) {
  const account = getAccount(id);
  if (!account) return { ok: false, error: 'Account not found' };
  if (account.status === 'sold' || account.stock <= 0) {
    return { ok: false, error: 'This account is out of stock.' };
  }
  account.stock = Math.max(0, account.stock - 1);
  if (account.stock === 0) account.status = 'sold';
  save();
  return { ok: true, stock: account.stock, sold: account.status === 'sold' };
}

function restoreAccount(id) {
  const account = getAccount(id);
  if (!account) return false;
  account.status = 'available';
  save();
  return true;
}

/* ---------- Wallet codes ---------- */

function createWalletCodes(amount, count) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = `GHX-${amount}-${generateCode(10)}`;
    db.walletCodes.push({ code, amount, used: false, usedBy: null, usedAt: null });
    codes.push(code);
  }
  save();
  return codes;
}

function redeemWalletCode(code, sessionToken) {
  const entry = db.walletCodes.find(c => c.code === code);
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.used) return { ok: false, reason: 'used' };
  entry.used = true;
  entry.usedBy = sessionToken;
  entry.usedAt = new Date().toISOString();
  const session = getSession(sessionToken);
  session.balance = Math.round((session.balance + entry.amount) * 100) / 100;
  save();
  return { ok: true, amount: entry.amount, balance: session.balance };
}

function unusedWalletCodes() {
  return db.walletCodes.filter(c => !c.used);
}

/* ---------- Promo codes ---------- */

function addPromoCode(code, discountPercent, maxUses) {
  const existing = db.promoCodes.find(p => p.code === code);
  if (existing) {
    existing.discount = discountPercent;
    existing.maxUses = maxUses;
  } else {
    db.promoCodes.push({ code, discount: discountPercent, maxUses, uses: 0 });
  }
  save();
  return getPromoCode(code);
}

function getPromoCode(code) {
  const promo = db.promoCodes.find(p => p.code === code);
  if (!promo) return null;
  return promo.maxUses > 0 && promo.uses >= promo.maxUses ? null : { ...promo };
}

function listPromoCodes() {
  return db.promoCodes.map(p => ({ ...p }));
}

function consumePromoCode(code) {
  const promo = db.promoCodes.find(p => p.code === code);
  if (!promo) return { ok: false, reason: 'invalid' };
  if (promo.maxUses > 0 && promo.uses >= promo.maxUses) return { ok: false, reason: 'used' };
  promo.uses += 1;
  save();
  return { ok: true, discount: promo.discount };
}

/* ---------- Transactions ---------- */

function createTransaction({ sessionToken, accountId, accountName, amount, promoCode, discount, discordName }) {
  const session = getSession(sessionToken);
  const tx = {
    id: db.transactions.reduce((max, t) => Math.max(max, t.id), 0) + 1,
    orderCode: generateOrderCode(),
    sessionToken,
    userId: session && session.userId ? session.userId : null,
    accountId,
    accountName,
    amount: Math.round(amount * 100) / 100,
    promoCode: promoCode || null,
    discount: discount || 0,
    discordName: discordName || null,
    createdAt: new Date().toISOString(),
    notified: false
  };
  db.transactions.push(tx);
  save();
  return tx;
}

function getOrder(orderCodeOrId) {
  return db.transactions.find(
    t => t.orderCode === orderCodeOrId || String(t.id) === String(orderCodeOrId)
  ) || null;
}

function listTransactions(limit = 25) {
  return [...db.transactions].reverse().slice(0, limit);
}

function listBySession(sessionToken) {
  return db.transactions.filter(t => t.sessionToken === sessionToken).reverse();
}

function markNotified(id) {
  const tx = db.transactions.find(t => t.id === id);
  if (tx) {
    tx.notified = true;
    save();
    return tx;
  }
  return null;
}

module.exports = {
  getOrCreateSession,
  getSession,
  setBalance,
  getUserById,
  findUserByEmail,
  findUserByGoogleSub,
  createUser,
  verifyPassword,
  bindUserToSession,
  getUserForSession,
  logoutUser,
  listOrdersForUser,
  listAccounts,
  getAccount,
  addAccount,
  markAccountSold,
  decrementStock,
  restoreAccount,
  createWalletCodes,
  redeemWalletCode,
  unusedWalletCodes,
  addPromoCode,
  getPromoCode,
  listPromoCodes,
  consumePromoCode,
  createTransaction,
  getOrder,
  listTransactions,
  listBySession,
  markNotified,
  listDigitals,
  buyDigital,
  randomToken,
  generateCode
};