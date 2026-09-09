const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const store = require('./store');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || config.port || 3000;
const CURRENCY = config.currency || '$';
const MAX_PRICE = config.maxPrice || 60;
const SESSION_COOKIE = 'ghxstly_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

/* ---------- Security headers ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
      secure: false,
      maxAge: SESSION_TTL_MS,
      path: '/'
    });
  }
  req.sessionToken = token;
  store.getOrCreateSession(token);
  next();
});

/* ---------- State-changing requests must have JSON content type ---------- */
function requireJson(req, res, next) {
  if (req.method === 'POST' && !req.is('application/json')) {
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
    const key = `${req.ip}|${req.path}`;
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

  if (account && account.credentials) {
    payload.embeds[0].fields.push({
      name: 'Account credentials',
      value: `${account.credentials.email}\n${account.credentials.password}`,
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

/* ---------- API ---------- */

app.get('/api/meta', (req, res) => {
  res.json({
    currency: CURRENCY,
    maxPrice: MAX_PRICE,
    discordInvite: config.discordInvite || null,
    stock: store.listAccounts().length
  });
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
      gallery: a.gallery || []
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

app.get('/api/wallet', (req, res) => {
  const session = store.getSession(req.sessionToken);
  res.json({ balance: session.balance, currency: CURRENCY });
});

app.post('/api/wallet/redeem', rateLimit(1000, 5), (req, res) => {
  const code = String(req.body.code || '').trim();
  if (code.length > 40) return res.status(400).json({ error: 'Invalid code' });

  const result = store.redeemWalletCode(code, req.sessionToken);
  if (!result.ok) {
    return res.status(400).json({ error: result.reason === 'used' ? 'Code already used.' : 'Invalid code.' });
  }
  res.json({ ok: true, added: result.amount, balance: result.balance, currency: CURRENCY });
});

app.get('/api/promo/check', (req, res) => {
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

  if (promoCode) {
    const consumed = store.consumePromoCode(promoCode);
    if (!consumed.ok) return res.status(400).json({ error: 'Promo code is no longer valid.' });
  }

  store.setBalance(req.sessionToken, session.balance - price);
  const stockResult = store.decrementStock(accountId);
  if (!stockResult.ok) {
    return res.status(410).json({ error: stockResult.error });
  }

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
    credentials: account.credentials || null
  });
});

app.get('/api/orders', (req, res) => {
  const orders = store.listBySession(req.sessionToken).map(t => ({
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
    const payload = {
      content: '@here 🚨 NEW CUSTOM ACCOUNT ORDER 🚨',
      embeds: [{
        title: 'Custom Account Request',
        color: 0x9d7bea,
        fields: [
          { name: 'Buyer Discord', value: discordName, inline: false },
          { name: 'Minimum skins', value: `${skinCount}+`, inline: true },
          { name: 'Specific skins wanted', value: skins.length ? skins.join(', ') : 'None specified', inline: false },
          { name: 'Notes', value: notes, inline: false }
        ],
        timestamp: order.createdAt
      }]
    };
    try {
      const r = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
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
app.listen(PORT, () => {
  console.log(`Ghxstly Store running at http://localhost:${PORT}`);
  console.log(`Max price: ${CURRENCY}${MAX_PRICE} · Currency: ${CURRENCY}`);
  console.log(`Webhook configured: ${config.webhookUrl ? 'yes (server-side only)' : 'NO — add one in config.json'}`);
});