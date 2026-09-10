const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const store = require('./store');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
  config = {};
}
config.webhookUrl = config.webhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
config.ownerEmail = (config.ownerEmail || process.env.OWNER_EMAIL || '').trim().toLowerCase();
config.discordClientId = config.discordClientId || process.env.DISCORD_CLIENT_ID || null;
config.discordClientSecret = config.discordClientSecret || process.env.DISCORD_CLIENT_SECRET || null;
const PORT = process.env.PORT || config.port || 3000;
const CURRENCY = config.currency || '$';
const MAX_PRICE = config.maxPrice || 60;

function accountCredentials(account) {
  if (account && account.credentials) return account.credentials;
  if (account && account.credsEnv) {
    const email = process.env[account.credsEnv + '_EMAIL'];
    const password = process.env[account.credsEnv + '_PASSWORD'];
    if (email && password) return { email, password };
  }
  return null;
}

/* ---------- Google ID token verification (no SDK needed) ---------- */
const GOOGLE_CLIENT_ID = config.googleClientId || process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CERTS_CACHE = { keys: null, at: 0 };

function b64url(s) { return Buffer.from(s, 'base64url').toString(); }

async function googleCerts() {
  if (GOOGLE_CERTS_CACHE.keys && Date.now() - GOOGLE_CERTS_CACHE.at < 3600e3) return GOOGLE_CERTS_CACHE.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('Google certs unavailable');
  GOOGLE_CERTS_CACHE.keys = (await res.json()).keys;
  GOOGLE_CERTS_CACHE.at = Date.now();
  return GOOGLE_CERTS_CACHE.keys;
}
async function verifyGoogleToken(idToken) {
  if (!GOOGLE_CLIENT_ID) return { error: 'Google login is not configured on this store yet.' };
  if (!idToken || typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    return { error: 'Invalid credential.' };
  }
  const [h, p, sig] = idToken.split('.');
  let header, payload;
  try {
    header = JSON.parse(b64url(h));
    payload = JSON.parse(b64url(p));
  } catch (_) {
    return { error: 'Invalid credential.' };
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) return { error: 'Credential expired.' };
  if (payload.iss && !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) {
    return { error: 'Credential issuer not recognized.' };
  }
  if (payload.aud !== GOOGLE_CLIENT_ID) return { error: 'Credential is not for this store.' };
  const keys = await googleCerts();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return { error: 'Issuer key not found.' };
  if (jwk.kty !== 'RSA' || header.alg !== 'RS256') return { error: 'Unsupported credential type.' };
  try {
    const key = crypto.createPublicKey({
      key: { kty: 'RSA', n: jwk.n, e: jwk.e },
      format: 'jwk'
    });
    const ok = crypto.verify('sha256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url'));
    if (!ok) return { error: 'Signature verification failed.' };
  } catch (_) {
    return { error: 'Signature verification failed.' };
  }
  return {
    ok: true,
    googleSub: payload.sub,
    email: payload.email || '',
    name: payload.name || 'Buyer',
    picture: payload.picture || ''
  };
}
const SESSION_COOKIE = 'ghxstly_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

/* ---------- Security headers ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com https://*.googleapis.com https://*.gstatic.com; img-src 'self' data: https://*.googleusercontent.com https://cdn.discordapp.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com https://discord.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  next();
});

app.use((req, res, next) => {
  if (/\.\.|%2e/i.test(req.path)) return res.status(400).send('Bad Request');
  next();
});

/* ---------- Hard-block server-side & data files ---------- */
const BLOCKED = /^(\/admin-codes\.txt|\/config\.json|\/package.*\.json|\/data\/|\/db\.json|\/(seed|setup|admin|store|patch-db)\.js|\/README\.md|\/\.env|\/\.git)/i;
app.use((req, res, next) => {
  if (BLOCKED.test(req.path)) return res.status(404).send('Not Found');
  next();
});

/* ---------- Session middleware ---------- */
app.use((req, res, next) => {
  let token = req.cookies[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{48}$/.test(token)) {
    token = store.randomToken();
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_TTL_MS,
      path: '/'
    });
  }
  req.sessionToken = token;
  store.getOrCreateSession(token);
  next();
});

/* ---------- State-changing requests must have JSON content type ---------- */
const JSON_EXEMPT = new Set(['/api/auth/logout']);
function requireJson(req, res, next) {
  if (req.method === 'POST' && !JSON_EXEMPT.has(req.path) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}
app.use(requireJson);

/* ---------- Basic rate limiting (per IP + endpoint) ---------- */
const hits = new Map();
function rateLimit(ms = 1000, count = 10) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${clientIp(req)}|${req.path}`;
    const list = (hits.get(key) || []).filter(t => now - t < ms);
    if (list.length >= count) {
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------- Discord webhook (server-side only) ---------- */
async function sendPurchaseNotification(tx) {
  const account = store.getAccount(tx.accountId);
  const tiers = { Common: 0x8a94a3, Rare: 0x5aa9f2, Epic: 0x9d7bea, Legendary: 0xf2a93b };
  const color = tiers[account && account.tier] || 0xbff2e6;

  const payload = {
    embeds: [{
      title: `New purchase — ${tx.accountName}`,
      color,
      fields: [
        { name: 'Buyer Discord', value: tx.discordName || 'Not provided', inline: true },
        { name: 'Account ID', value: String(tx.accountId), inline: true },
        { name: 'Price', value: `${CURRENCY}${tx.amount.toFixed(2)}`, inline: true },
        { name: 'Order code', value: tx.orderCode, inline: false },
        { name: 'Promo used', value: tx.promoCode ? `${tx.promoCode} (-${tx.discount}%)` : 'None', inline: true },
        { name: 'Status', value: 'Payment confirmed — hand over account via ticket.', inline: false }
      ],
      timestamp: tx.createdAt
    }]
  };

  const creds = accountCredentials(account);
  if (creds) {
    payload.embeds[0].fields.push({
      name: 'Account credentials',
      value: `${creds.email}\n${creds.password}`,
      inline: true
    });
  }

  if (!config.webhookUrl) return { ok: false, error: 'No webhookUrl configured.' };

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Discord returned ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

/* ---------- Login webhook ---------- */
async function geoFrom(ip) {
  const cleanIp = String(ip || '').replace(/^::ffff:/, '');
  if (!cleanIp || cleanIp === 'unknown' || /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(cleanIp)) {
    return { text: 'Unknown', lat: null, lng: null };
  }
  const sources = [
    {
      url: `https://ipapi.co/${cleanIp}/json/`,
      ok: j => !j.error && !!j.city,
      parse: j => ({
        text: [j.city, j.region, j.country_name].filter(Boolean).join(', '),
        lat: j.latitude || null,
        lng: j.longitude || null
      })
    },
    {
      url: `https://ipwho.is/${cleanIp}`,
      ok: j => j.success !== false && !!j.city,
      parse: j => ({
        text: [j.city, j.region, j.country].filter(Boolean).join(', '),
        lat: j.latitude || null,
        lng: j.longitude || null
      })
    }
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src.url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (!src.ok(j)) continue;
      return src.parse(j);
    } catch (_) { /* try next source */ }
  }
  return { text: 'Unknown', lat: null, lng: null };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const first = String(fwd).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function clientInfo(req) {
  const ua = req.headers['user-agent'] || '';
  var browser = 'Unknown browser';
  var os = 'Unknown OS';
  if (/Edg\/|EdgA\/|EdgiOS\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/Brave/i.test(ua)) browser = 'Brave';
  else if (/CriOS\//i.test(ua)) browser = 'Chrome (iOS)';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = 'Firefox';
  else if (/Version\/.+Safari\//i.test(ua)) browser = 'Safari';
  else if (/MicroMessenger/i.test(ua)) browser = 'WeChat';
  else if (/Mozilla\/5/i.test(ua)) browser = 'Generic browser';
  if (/Windows NT 10\.0/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.\d/i.test(ua)) os = 'Windows 7';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android \d+/i.test(ua)) { const m = ua.match(/Android (\d+\.?\d*)/); os = 'Android ' + (m ? m[1] : ''); }
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/X11|CrOS|Linux/i.test(ua)) os = 'Linux';
  return `${browser} · ${os}`;
}

async function sendLoginNotification(req, { email, name, method }) {
  if (!config.webhookUrl) return;
  try {
    const ip = clientIp(req);
    const device = clientInfo(req);
    const now = new Date();
    const when = now.toUTCString();
    const [geo] = await Promise.all([geoFrom(ip)]);
    const mapLink = geo.lat !== null && geo.lng !== null
      ? `[View map](https://www.google.com/maps?q=${geo.lat},${geo.lng})`
      : '';
    const locationValue = geo.text === 'Unknown' && mapLink ? 'Unknown' : `${geo.text}${mapLink ? ' · ' + mapLink : ''}`;

    const payload = {
      embeds: [{
        title: method.endsWith('up') ? 'New account created' : 'New sign-in',
        color: method === 'google' ? 0x4285f4 : method === 'discord' ? 0x5865f2 : method.endsWith('up') ? 0x5aa9f2 : 0x4ade80,
        fields: [
          { name: 'Email', value: email || 'Unknown', inline: true },
          { name: 'Name', value: name || '—', inline: true },
          { name: 'When', value: `${when}\n(UTC)`, inline: false },
          { name: 'IP address', value: ip, inline: true },
          { name: 'Location', value: locationValue, inline: true },
          { name: 'Device', value: device, inline: false }
        ],
        footer: { text: `Sign-in via ${method === 'email' ? 'email & password' : method === 'google' ? 'Google' : method === 'discord' ? 'Discord' : 'account signup'}` },
        timestamp: now.toISOString()
      }]
    };

    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.error('Login webhook failed:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('Login webhook error:', err.message);
  }
}

/* ---------- API ---------- */

app.get('/api/meta', (req, res) => {
  res.json({
    currency: CURRENCY,
    maxPrice: MAX_PRICE,
    discordInvite: config.discordInvite || null,
    googleClientId: GOOGLE_CLIENT_ID,
    stock: store.listAccounts().length,
    googleClientId: config.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
    discordEnabled: !!(config.discordClientId && config.discordClientSecret)
  });
});

/* ---------- Owner role ---------- */
function publicUser(user) {
  return user ? { uid: user.uid, name: user.name, email: user.email, picture: user.picture, balance: user.balance, role: user.role || null } : null;
}
function applyOwnerRole(user) {
  if (!user || !config.ownerEmail || user.role === 'owner') return user;
  if (String(user.email || '').toLowerCase() === config.ownerEmail) {
    store.setUserRole(user.uid, 'owner');
    user.role = 'owner';
  }
  return user;
}

/* ---------- Google auth ---------- */
app.post('/api/auth/google', rateLimit(1500, 8), async (req, res) => {
  const idToken = String(req.body.token || req.body.credential || '');
  let result;
  try {
    result = await verifyGoogleToken(idToken);
  } catch (err) {
    return res.status(400).json({ error: 'Google is unreachable right now. Try again.' });
  }
  if (!result.ok) return res.status(400).json({ error: result.error });

  const user = applyOwnerRole(store.createUser({ googleSub: result.googleSub, email: result.email, name: result.name || 'Shopper', picture: result.picture }));
  store.bindUserToSession(req.sessionToken, user.uid);
  sendLoginNotification(req, { email: user.email, name: user.name, method: 'google' }).catch(() => {});
  res.json({ ok: true, user: publicUser(user) });
});

/* ---------- Discord auth ---------- */
app.get('/api/auth/discord', (req, res) => {
  if (!config.discordClientId || !config.discordClientSecret) {
    return res.status(400).json({ error: 'Discord login is not configured on this store yet.' });
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
  const url = 'https://discord.com/oauth2/authorize' +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(config.discordClientId) +
    '&scope=' + encodeURIComponent('identify email') +
    '&state=' + encodeURIComponent(req.sessionToken) +
    '&prompt=consent' +
    '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.redirect(url);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  if (!code || state !== req.sessionToken) {
    return res.redirect('/#auth-error');
  }
  if (!config.discordClientId || !config.discordClientSecret) {
    return res.redirect('/#auth-error');
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
  let user;
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: 'identify email'
      }).toString(),
      signal: AbortSignal.timeout(10000)
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) throw new Error('no access token');
    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'GHXSTLY-Store (1.0.0)' }
    });
    const me = await meRes.json();
    if (!me.id) throw new Error('no user');
    user = me;
  } catch (_) {
    return res.redirect('/#auth-error');
  }

  const picture = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256` : '';
  const linked = store.createUser({ discordSub: user.id, email: user.email && user.verified ? user.email : '', name: user.global_name || user.username || 'Shopper', picture });
  const owner = applyOwnerRole(linked);
  store.bindUserToSession(req.sessionToken, owner.uid);
  sendLoginNotification(req, { email: owner.email, name: owner.name, method: 'discord' }).catch(() => {});
  res.redirect('/#signed-in');
});

/* ---------- Email / password auth ---------- */
app.post('/api/auth/signup', rateLimit(1500, 6), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (name.length < 2) return res.status(400).json({ error: 'Enter your real name or a display name (min 2 characters).' });
  if (/^buyer$/i.test(name)) return res.status(400).json({ error: 'Pick a different display name.' });
  if (config.ownerEmail && email === config.ownerEmail) {
    return res.status(400).json({ error: 'That email signs in with Google or Discord only.' });
  }
  const existing = store.findUserByEmail(email);
  if (existing && existing.passwordHash) return res.status(400).json({ error: 'An account with that email already exists. Sign in instead.' });
  const user = applyOwnerRole(store.createUser({ name, email, password, googleSub: existing && existing.googleSub ? existing.googleSub : null }));
  store.bindUserToSession(req.sessionToken, user.uid);
  sendLoginNotification(req, { email: user.email, name: user.name, method: 'signup' }).catch(() => {});
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/login', rateLimit(1500, 8), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '');
  const user = store.findUserByEmail(email);
  if (!user || !store.verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  applyOwnerRole(user);
  store.bindUserToSession(req.sessionToken, user.uid);
  sendLoginNotification(req, { email: user.email, name: user.name, method: 'email' }).catch(() => {});
  res.json({ ok: true, user: publicUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const user = store.getUserForSession(req.sessionToken);
  if (!user) return res.json({ user: null });
  applyOwnerRole(user);
  res.json({ user: publicUser(user) });
});

app.get('/api/wallet', (req, res) => {
  const session = store.getSession(req.sessionToken);
  const user = applyOwnerRole(store.getUserForSession(req.sessionToken));
  res.json({ balance: session.balance, currency: CURRENCY, user: user ? { name: user.name, email: user.email, picture: user.picture, role: user.role || null } : null });
});

app.get('/api/accounts', (req, res) => {
  const accounts = store
    .listAccounts()
    .map(a => ({
      id: a.id,
      name: a.name,
      tier: a.tier,
      tierVar: a.tierVar,
      price: a.price,
      skins: a.skins,
      warranty: a.warranty,
      stock: a.stock,
      desc: a.desc,
      chips: a.chips,
      gallery: a.gallery || [],
      deliveryNote: a.deliveryNote || null
    }));
  res.json({ accounts });
});

app.get('/api/account/:id', (req, res) => {
  const id = Number(req.params.id);
  const account = store.getAccount(id);
  if (!account || account.status === 'sold') {
    return res.status(404).json({ error: 'Account not found' });
  }
  const { id: _id, status, credentials: _credentials, ...safe } = account;
  res.json({ account: safe });
});

app.post('/api/auth/logout', (req, res) => {
  store.logoutUser(req.sessionToken);
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    path: '/'
  });
  res.json({ ok: true });
});

app.post('/api/wallet/redeem', rateLimit(1000, 5), (req, res) => {
  const code = String(req.body.code || '').trim();
  if (code.length > 40) return res.status(400).json({ error: 'Invalid code' });

  const result = store.redeemWalletCode(code, req.sessionToken);
  if (!result.ok) {
    // Deliberately identical message: never reveal whether a code exists or is spent.
    return res.status(400).json({ error: 'Invalid or already-used code.' });
  }
  res.json({ ok: true, added: result.amount, balance: result.balance, currency: CURRENCY });
});

app.get('/api/promo/check', rateLimit(10000, 20), (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const promo = store.getPromoCode(code);
  if (!promo) return res.json({ valid: false });
  res.json({ valid: true, discount: promo.discount });
});

app.post('/api/checkout', rateLimit(1500, 4), (req, res) => {
  const accountId = Number(req.body.accountId);
  const promoCode = req.body.promoCode ? String(req.body.promoCode).trim().toUpperCase() : null;
  const discordName = req.body.discordName ? String(req.body.discordName).trim().slice(0, 80) : '';

  if (discordName.length < 3 || discordName.length > 80) {
    return res.status(400).json({ error: 'Please enter your Discord username (3-80 characters).' });
  }
  if (!Number.isInteger(accountId)) return res.status(400).json({ error: 'Invalid account' });
  const account = store.getAccount(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.status === 'sold') return res.status(410).json({ error: 'This account was just sold to someone else.' });

  let discount = 0;
  if (promoCode) {
    const promo = store.getPromoCode(promoCode);
    if (!promo) return res.status(400).json({ error: 'Invalid or fully-used promo code.' });
    discount = promo.discount;
  }

  const price = Math.max(0, Math.round(account.price * (1 - discount / 100) * 100) / 100);
  const session = store.getSession(req.sessionToken);
  if (session.balance < price) {
    return res.status(400).json({
      error: 'Insufficient wallet balance.',
      need: price,
      balance: session.balance
    });
  }

  const stockResult = store.decrementStock(accountId);
  if (!stockResult.ok) {
    return res.status(410).json({ error: stockResult.error });
  }

  if (promoCode) {
    const consumed = store.consumePromoCode(promoCode);
    if (!consumed.ok) {
      store.restoreAccount(accountId);
      return res.status(400).json({ error: 'Promo code is no longer valid.' });
    }
  }

  store.setBalance(req.sessionToken, session.balance - price);

  const tx = store.createTransaction({
    sessionToken: req.sessionToken,
    accountId,
    accountName: account.name,
    amount: price,
    promoCode,
    discount,
    discordName
  });

  sendPurchaseNotification(tx)
    .then(result => {
      if (result.ok) store.markNotified(tx.id);
      else console.error('Webhook failed for order', tx.orderCode, result.error);
    })
    .catch(err => console.error('Webhook error:', err.message));

  res.json({
    ok: true,
    orderCode: tx.orderCode,
    amount: tx.amount,
    currency: CURRENCY,
    accountName: tx.accountName,
    credentials: accountCredentials(account),
    deliveryNote: account.deliveryNote || null
  });
});

app.get('/api/orders', (req, res) => {
  const user = store.getUserForSession(req.sessionToken);
  const list = user
    ? store.listOrdersForUser(user.uid)
    : store.listBySession(req.sessionToken);
  const orders = list.map(t => ({
    orderCode: t.orderCode,
    accountName: t.accountName,
    amount: t.amount,
    currency: CURRENCY,
    createdAt: t.createdAt,
    notified: t.notified
  }));
  res.json({ orders });
});

/* ---------- Digital goods ---------- */

app.get('/api/digital', (req, res) => {
  res.json({ items: store.listDigitals(), currency: CURRENCY });
});

app.post('/api/digital/buy', rateLimit(1500, 4), (req, res) => {
  const itemId = String(req.body.itemId || '').trim().slice(0, 40);
  const discordName = req.body.discordName ? String(req.body.discordName).trim().slice(0, 80) : '';

  if (discordName.length < 3 || discordName.length > 80) {
    return res.status(400).json({ error: 'Please enter your Discord username (3-80 characters).' });
  }
  if (!itemId) return res.status(400).json({ error: 'Invalid item' });

  const result = store.buyDigital(itemId, req.sessionToken, discordName);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const tx = result.tx;
  sendPurchaseNotification(tx)
    .then(r => {
      if (r.ok) store.markNotified(tx.id);
      else console.error('Webhook failed for digital order', tx.orderCode, r.error);
    })
    .catch(err => console.error('Digital webhook error:', err.message));

  res.json({ ok: true, orderCode: tx.orderCode, itemName: tx.accountName, amount: tx.amount, currency: CURRENCY });
});

app.post('/api/custom-order', rateLimit(5000, 3), (req, res) => {
  const discordName = String(req.body.discordName || '').trim().slice(0, 80);
  const skinCount = Math.min(Number(req.body.skinCount) || 0, 100000);
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const skins = Array.isArray(req.body.skins)
    ? req.body.skins.map(s => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 12)
    : [];

  if (discordName.length < 3 || discordName.length > 80) {
    return res.status(400).json({ error: 'Please enter your Discord username.' });
  }

  const order = {
    id: Date.now(),
    discordName,
    skinCount: Number.isFinite(skinCount) ? skinCount : 0,
    skins,
    notes: notes || 'None',
    createdAt: new Date().toISOString()
  };

  (async () => {
    if (!config.webhookUrl) return;
    const embed = {
      title: 'Custom Account Request',
      color: 0x9d7bea,
      fields: [
        { name: 'Buyer Discord', value: discordName, inline: false },
        { name: 'Minimum skins', value: `${skinCount}+`, inline: true },
        { name: 'Specific skins wanted', value: skins.length ? skins.join(', ') : 'None specified', inline: false },
        { name: 'Notes', value: notes, inline: false }
      ],
      timestamp: order.createdAt
    };
    const post = (content) => fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, embeds: [embed] })
    });
    try {
      let r = await post('@here 🚨 NEW CUSTOM ACCOUNT ORDER 🚨');
      if (!r.ok) r = await post('');
      if (!r.ok) console.error('Custom-order webhook failed:', r.status, (await r.text()).slice(0, 200));
    } catch (err) {
      console.error('Custom-order webhook error:', err.message);
    }
  })();

  res.json({ ok: true });
});

/* ---------- Static files ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------- Start ---------- */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ghxstly Store running at http://localhost:${PORT}`);
    console.log(`Max price: ${CURRENCY}${MAX_PRICE} · Currency: ${CURRENCY}`);
    console.log(`Webhook configured: ${config.webhookUrl ? 'yes (server-side only)' : 'NO — add one in config.json'}`);
  });
}

module.exports = app;