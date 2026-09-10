const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const KV_KEY = 'ghxstly:db';
let kv = null;
let kvAvailable = false;
try {
  kv = require('@vercel/kv').kv;
  kvAvailable = !!(process.env.KV_REST_API_URL || process.env.REDIS_REST_URL);
} catch (_) {}


let blobClient = null;
try {
  blobClient = require('@vercel/blob');
} catch (_) {}
// Immutable snapshots: every write gets a unique timestamped path, so edge
// caches can never serve a stale version (immutable blobs cache correctly).
// Boot and reads merge the newest few heads, so concurrent writers converge.
const SNAP_PREFIX = 'snapshots/';
const SNAP_READ = 5;
const SNAP_KEEP = 10;

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || 'timed out')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function listSnaps() {
  const tok = blobToken();
  const out = [];
  let cursor;
  do {
    const page = await withTimeout(
      blobClient.list({ prefix: SNAP_PREFIX, limit: 100, cursor, token: tok }),
      8000,
      'blob list timed out'
    );
    for (const b of (page && page.blobs) || []) out.push(b);
    cursor = page && page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  return out;
}

async function downloadSnap(blob) {
  const tok = blobToken();
  const url = blob.downloadUrl || blob.url;
  if (!url) throw new Error('no url');
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${tok}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const snap = await r.json();
  if (!snap || !Array.isArray(snap.users)) throw new Error('bad snapshot');
  return snap;
}

async function readRecentSnapshots(n) {
  const list = await listSnaps();
  const snaps = [];
  for (const b of list.slice(0, n || SNAP_READ)) {
    try { snaps.push(await downloadSnap(b)); } catch (_) {}
  }
  return { list, snaps };
}

async function loadDurable() {
  const tok = blobToken();
  if (blobClient && tok) {
    try {
      const meta = await blobClient.head(BLOB_PATH, { token: tok });
      const url = meta.downloadUrl || meta.url;
      if (!url) return null;
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) return null;
      const snap = await r.json();
      return snap && Array.isArray(snap.users) ? { ...DEFAULT_DB, ...snap } : null;
    } catch (_) {
      return null;
    }
  }
  if (!kv || !kvAvailable) return null;
  try {
    const snap = await kv.get(KV_KEY);
    return snap && snap.users ? { ...DEFAULT_DB, ...snap } : null;
  } catch (_) {
    return null;
  }
}

const lastPush = { at: null, ok: null, error: null };

// Merge a remote snapshot into memory without losing anything:
// bindings and spends are ordered by recency, single-use flags and
// sold states only ever move forward, lists are unioned.
function mergeSnapshot(local, remote) {
  const out = { ...DEFAULT_DB };

  const sess = new Map();
  for (const s of (remote.sessions || [])) {
    if (s && s.token) sess.set(s.token, { ...s });
  }
  for (const s of (local.sessions || [])) {
    if (!s || !s.token) continue;
    const r = sess.get(s.token);
    if (!r) { sess.set(s.token, { ...s }); continue; }
    const lu = s.updatedAt || 0;
    const ru = r.updatedAt || 0;
    // userId: a proven logout (loggedOutAt newer than the binding) unbinds;
    // otherwise a live binding always beats a stray empty row.
    let userId;
    if (s.userId && r.userId) {
      userId = (lu >= ru ? s : r).userId;
    } else if (s.userId || r.userId) {
      const bound = s.userId ? s : r;
      const bare = s.userId ? r : s;
      const provenLogout = (bare.loggedOutAt || 0) >= (bound.updatedAt || 0) && !!bare.loggedOutAt;
      userId = provenLogout ? null : bound.userId;
    } else {
      userId = null;
    }
    // balance: newest write wins (redeems, spends and binds all bump updatedAt).
    const balance = (lu >= ru ? s.balance : r.balance);
    sess.set(s.token, {
      token: s.token,
      balance: typeof balance === 'number' ? balance : 0,
      userId: userId || null,
      createdAt: s.createdAt || r.createdAt || Date.now(),
      updatedAt: Math.max(lu, ru),
      loggedOutAt: Math.max(s.loggedOutAt || 0, r.loggedOutAt || 0) || null
    });
  }
  out.sessions = [...sess.values()];

  const users = new Map();
  for (const u of (remote.users || [])) {
    if (u && u.uid) users.set(u.uid, { ...u });
  }
  for (const u of (local.users || [])) {
    if (!u || !u.uid) continue;
    const r = users.get(u.uid);
    if (!r) { users.set(u.uid, { ...u }); continue; }
    const merged = { ...r };
    for (const k of ['name', 'email', 'picture', 'googleSub', 'discordSub', 'passwordHash']) {
      if ((merged[k] === undefined || merged[k] === null || merged[k] === '') && u[k]) merged[k] = u[k];
    }
    if (u.role === 'owner' || r.role === 'owner') merged.role = 'owner';
    const lb = u.balanceAt || 0;
    const rb = r.balanceAt || 0;
    if (lb > rb || (lb === rb && (u.balance || 0) > (merged.balance || 0))) {
      merged.balance = u.balance || 0;
      merged.balanceAt = lb;
    }
    users.set(u.uid, merged);
  }
  out.users = [...users.values()];

  const codes = new Map();
  for (const c of (remote.walletCodes || [])) {
    if (c && c.code) codes.set(c.code, { ...c });
  }
  for (const c of (local.walletCodes || [])) {
    if (!c || !c.code) continue;
    const r = codes.get(c.code);
    if (!r) { codes.set(c.code, { ...c }); continue; }
    const used = !!(r.used || c.used);
    const src = c.used ? c : r;
    codes.set(c.code, { ...r, ...c, used, usedBy: src.usedBy || null, usedAt: src.usedAt || null });
  }
  out.walletCodes = [...codes.values()];

  const promos = new Map();
  for (const p of (remote.promoCodes || [])) {
    if (p && p.code) promos.set(p.code, { ...p });
  }
  for (const p of (local.promoCodes || [])) {
    if (!p || !p.code) continue;
    const r = promos.get(p.code);
    if (!r) { promos.set(p.code, { ...p }); continue; }
    promos.set(p.code, { ...r, ...p, uses: Math.max(r.uses || 0, p.uses || 0) });
  }
  out.promoCodes = [...promos.values()];

  const accounts = new Map();
  for (const a of (remote.accounts || [])) {
    if (a && a.id !== undefined && a.id !== null) accounts.set(a.id, { ...a });
  }
  for (const a of (local.accounts || [])) {
    if (!a || a.id === undefined || a.id === null) continue;
    const r = accounts.get(a.id);
    if (!r) { accounts.set(a.id, { ...a }); continue; }
    accounts.set(a.id, {
      ...r,
      ...a,
      status: (r.status === 'sold' || a.status === 'sold') ? 'sold' : a.status,
      stock: Math.min(typeof r.stock === 'number' ? r.stock : 99, typeof a.stock === 'number' ? a.stock : 99)
    });
  }
  out.accounts = [...accounts.values()];

  const tx = new Map();
  for (const t of (remote.transactions || [])) {
    if (t && t.orderCode) tx.set(t.orderCode, { ...t });
  }
  for (const t of (local.transactions || [])) {
    if (t && t.orderCode && !tx.has(t.orderCode)) tx.set(t.orderCode, { ...t });
  }
  out.transactions = [...tx.values()];

  const stock = { ...(remote.digitalStock || {}) };
  for (const [k, v] of Object.entries(local.digitalStock || {})) {
    stock[k] = (stock[k] === undefined) ? v : Math.min(stock[k], v);
  }
  out.digitalStock = stock;

  return out;
}

async function readBlobSnapshot() {
  if (!blobClient || !blobToken()) return { snap: null, error: 'not configured' };
  try {
    // Newest head wins for the quick check; deeper merges happen on push/boot.
    const { snaps } = await readRecentSnapshots(1);
    if (!snaps.length) return { snap: null, error: 'no snapshot yet' };
    return { snap: snaps[0], error: null };
  } catch (err) {
    return { snap: null, error: String(err && err.message || err).slice(0, 200) };
  }
}

// Newest few heads merged oldest-first, so concurrent writers converge.
async function readMergedSnapshots(n) {
  const { snaps } = await readRecentSnapshots(n || SNAP_READ);
  let merged = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    merged = merged ? mergeSnapshot(merged, snaps[i]) : snaps[i];
  }
  return merged;
}

async function pushDurable() {
  const tok = blobToken();
  if (blobClient && tok) {
    try {
      // Read-merge-write across the newest heads, then write a NEW immutable
      // key: concurrent writers converge instead of clobbering each other.
      const { list, snaps } = await readRecentSnapshots(SNAP_READ);
      let merged = db;
      for (let i = snaps.length - 1; i >= 0; i--) {
        merged = mergeSnapshot(merged, snaps[i]);
      }
      db.sessions = merged.sessions;
      db.users = merged.users;
      db.walletCodes = merged.walletCodes;
      db.promoCodes = merged.promoCodes;
      db.accounts = merged.accounts;
      db.transactions = merged.transactions;
      db.digitalStock = merged.digitalStock;
      const key = `${SNAP_PREFIX}${Date.now()}-${randomToken(4)}.json`;
      const putRes = await blobClient.put(key, JSON.stringify(db), {
        access: 'private',
        contentType: 'application/json',
        token: tok
      });
      // Prune old heads (best effort).
      const stale = list.slice(SNAP_KEEP).map(b => b.url).filter(Boolean);
      if (stale.length) {
        try { await blobClient.del(stale, { token: tok }); } catch (_) {}
      }
      lastPush.at = new Date().toISOString();
      lastPush.ok = true;
      lastPush.error = null;
      lastPush.verified = true;
      lastPush.url = (putRes && putRes.url) || null;
      lastPush.size = null;
    } catch (err) {
      lastPush.at = new Date().toISOString();
      lastPush.ok = false;
      lastPush.error = String(err && err.message || err).slice(0, 300);
      console.error('Durable snapshot failed:', err.message);
    }
    return;
  }
  if (!kv || !kvAvailable) return;
  try { await kv.set(KV_KEY, db); } catch (_) {}
}

function durableStatus() {
  return {
    hasToken: !!blobToken(),
    hasClient: !!blobClient,
    kv: !!(kv && kvAvailable),
    lastPush,
    bootLoad
  };
}

async function flushDurable() {
  save();
  await pushDurable();
}

const DEFAULT_DB = {
  accounts: [],
  walletCodes: [],
  promoCodes: [],
  transactions: [],
  sessions: [],
  users: []
};

let db = load();

// Secrets (redeem codes, promo codes, owner login) are injected from
// environment variables — never from the git repo — so the public repo
// can never leak them. Missing entries are added, existing ones are
// left untouched (used flags and balances are never reset).
//   WALLET_CODES="GHX-20-ABC:20,GHX-25-DEF:25"
//   PROMO_CODES="SAVE10:10:100,ONE50:50:1"
//   OWNER_EMAIL="you@mail.com"  OWNER_PASSWORD="long-secret"
function seedFromEnv() {
  let changed = false;
  for (const part of String(process.env.WALLET_CODES || '').split(',')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const code = part.slice(0, idx).trim();
    const amount = Number(part.slice(idx + 1));
    if (!code || code.length > 40 || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
    if (!db.walletCodes.some(c => c.code === code)) {
      db.walletCodes.push({ code, amount, used: false, usedBy: null, usedAt: null });
      changed = true;
    }
  }
  for (const part of String(process.env.PROMO_CODES || '').split(',')) {
    const seg = part.split(':');
    if (seg.length < 3) continue;
    const code = (seg[0] || '').trim().toUpperCase();
    const discount = Number(seg[1]);
    const maxUses = Number(seg[2]);
    if (!code || code.length > 40 || !Number.isFinite(discount) || discount <= 0 || discount > 100 || !Number.isInteger(maxUses) || maxUses < 0) continue;
    if (!db.promoCodes.some(p => p.code === code)) {
      db.promoCodes.push({ code, discount, maxUses, uses: 0 });
      changed = true;
    }
  }
  const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const ownerPass = String(process.env.OWNER_PASSWORD || '');
  if (ownerEmail && ownerPass.length >= 6 && ownerPass.length <= 200) {
    let owner = db.users.find(u => u.email && String(u.email).toLowerCase() === ownerEmail);
    if (!owner) {
      owner = {
        uid: randomToken(8),
        name: 'Owner',
        email: ownerEmail,
        picture: '',
        googleSub: null,
        discordSub: null,
        passwordHash: null,
        role: 'owner',
        balance: 0,
        createdAt: new Date().toISOString()
      };
      db.users.push(owner);
    }
    owner.role = 'owner';
    owner.passwordHash = hashPassword(ownerPass);
    changed = true;
  }
  if (changed) save();
}
seedFromEnv();

// On serverless (Vercel) the file system is ephemeral, so take the persisted
// snapshot from durable storage (Blob, else KV) the moment the store boots.
// loadDurable() is a safe no-op when nothing is configured.
const bootLoad = { at: null, ok: null, error: null, sessions: 0 };
let bootReadyResolve;
const bootReady = new Promise(resolve => { bootReadyResolve = resolve; });
const bootSafety = setTimeout(() => { try { bootReadyResolve(); } catch (_) {} }, 10000);
if (bootSafety.unref) bootSafety.unref();
function ready() {
  return bootReady;
}

async function bootDurable() {
  if (blobClient && blobToken()) {
    try {
      // Boot takes only the newest head: fast, so the first requests
      // already see durable state. Convergence across heads happens
      // on every later save.
      const { snaps } = await withTimeout(readRecentSnapshots(1), 9000, 'boot load timed out');
      const merged = snaps.length ? snaps[0] : null;
      bootLoad.at = new Date().toISOString();
      if (merged) {
        db.sessions = merged.sessions;
        db.users = merged.users;
        db.walletCodes = merged.walletCodes;
        db.promoCodes = merged.promoCodes;
        db.accounts = merged.accounts;
        db.transactions = merged.transactions;
        db.digitalStock = merged.digitalStock;
        bootLoad.ok = true;
        bootLoad.sessions = (merged.sessions || []).length;
        save();
      } else {
        bootLoad.ok = false;
        bootLoad.error = 'no snapshot (fresh boot)';
      }
    } catch (err) {
      bootLoad.at = new Date().toISOString();
      bootLoad.ok = false;
      bootLoad.error = String(err && err.message || err).slice(0, 200);
    } finally {
      try { bootReadyResolve(); } catch (_) {}
    }
    return;
  }
  loadDurable().then(snap => {
    bootLoad.at = new Date().toISOString();
    if (snap) {
      db = snap;
      bootLoad.ok = true;
      bootLoad.sessions = (snap.sessions || []).length;
      save();
    } else {
      bootLoad.ok = false;
      bootLoad.error = 'no snapshot (fresh boot)';
    }
    try { bootReadyResolve(); } catch (_) {}
  }).catch(err => {
    bootLoad.at = new Date().toISOString();
    bootLoad.ok = false;
    bootLoad.error = String(err && err.message || err).slice(0, 200);
    try { bootReadyResolve(); } catch (_) {}
  });
}
bootDurable();

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

let lastOwnWriteMs = 0;
// Synchronous write-through save: every mutation is on disk before the
// API response is sent, so refreshes, restarts and crashes can never
// lose a purchase, a sold flag, a redeemed code or a session.
function save() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    pushDurable();
    try { lastOwnWriteMs = fs.statSync(DB_FILE).mtimeMs; } catch (_) {}
  } catch (err) {
    console.error('Failed to save database:', err.message);
  }
}

function pushWatch(eventType, filename) {
  if (filename && filename !== 'db.json') return;
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
  touchSession(session);
  syncUserBalance(sessionToken);
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

function touchSession(session) {
  if (session) session.updatedAt = Date.now();
}

function getOrCreateSession(sessionToken) {
  let session = db.sessions.find(s => s.token === sessionToken);
  if (!session) {
    session = { token: sessionToken, balance: 0, userId: null, createdAt: Date.now(), updatedAt: Date.now(), loggedOutAt: null };
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
  if (user) {
    user.balance = session.balance;
    user.balanceAt = Date.now();
  }
}

function setBalance(sessionToken, balance) {
  const session = getSession(sessionToken);
  session.balance = Math.max(0, Math.round(balance * 100) / 100);
  touchSession(session);
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

function createUser({ name, email, password, googleSub, discordSub, picture }) {
  let user = findUserByEmail(email) || (googleSub && findUserByGoogleSub(googleSub)) || (discordSub && findUserByDiscordSub(discordSub));
  if (user) {
    if (email && !user.email) user.email = String(email).trim().toLowerCase();
    if (name && !user.name) user.name = name;
    if (picture && !user.picture) user.picture = picture;
    if (googleSub && !user.googleSub) user.googleSub = googleSub;
    if (discordSub && !user.discordSub) user.discordSub = discordSub;
    if (password && !user.passwordHash) user.passwordHash = hashPassword(password);
    save();
    return user;
  }
  user = {
    uid: randomToken(8),
    name: name || (email ? email.split('@')[0] : 'Shopper'),
    email: email ? String(email).trim().toLowerCase() : '',
    picture: picture || '',
    googleSub: googleSub || null,
    discordSub: discordSub || null,
    passwordHash: password ? hashPassword(password) : null,
    role: null,
    balance: 0,
    balanceAt: Date.now(),
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  save();
  return user;
}

function findUserByDiscordSub(discordSub) {
  if (!discordSub) return null;
  return db.users.find(u => u.discordSub === discordSub) || null;
}

function setUserRole(uid, role) {
  const user = getUserById(uid);
  if (!user) return null;
  user.role = role || null;
  save();
  return user;
}

function bindUserToSession(sessionToken, uid) {
  const session = getSession(sessionToken);
  if (!session) return null;
  const user = getUserById(uid);
  if (!user) return null;
  session.userId = user.uid;
  session.loggedOutAt = null;
  // carry the user's stored balance onto this device
  session.balance = Math.max(session.balance, user.balance || 0);
  user.balance = session.balance;
  user.balanceAt = Date.now();
  touchSession(session);
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
  // Note: updatedAt deliberately NOT bumped here — the logout is ordered
  // purely by loggedOutAt so a stale balance can never become "newer".
  session.loggedOutAt = Date.now();
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

function setStock(id, stock) {
  const account = getAccount(id);
  if (!account) return null;
  const n = Number(stock);
  if (!Number.isFinite(n)) return null;
  account.stock = Math.min(Math.max(0, Math.round(n)), 100000);
  if (account.stock === 0) account.status = 'sold';
  else if (account.status === 'sold') account.status = 'available';
  save();
  return account;
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
  if (!session) return { ok: false, reason: 'nosession' };
  session.balance = Math.round((session.balance + entry.amount) * 100) / 100;
  touchSession(session);
  syncUserBalance(sessionToken);
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
  findUserByDiscordSub,
  createUser,
  setUserRole,
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
  setStock,
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
  generateCode,
  durableStatus,
  flushDurable,
  readBlobSnapshot,
  readMergedSnapshots,
  mergeSnapshot,
  ready
};