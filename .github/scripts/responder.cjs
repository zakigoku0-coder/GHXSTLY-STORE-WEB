// Shop auto-responder (runs on a schedule, e.g. GitHub Actions cron).
// Reads new messages in the store channel(s) and replies to shop questions.
// PUBLIC-SAFE: answers are fixed public strings. No codes, passwords,
// emails or tokens are ever read, stored or sent by this script.
// Secrets (bot token) come ONLY from environment variables.
//
// Env: DISCORD_BOT_TOKEN (required), CHANNEL_IDS (comma list, required),
//      STATE_PATH (default .responder-state.json),
//      API_BASE (default https://discord.com/api/v10)
const fs = require('fs');

const API = (process.env.API_BASE || 'https://discord.com/api/v10').replace(/\/$/, '');
const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNELS = String(process.env.CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_PATH = process.env.STATE_PATH || '.responder-state.json';

// Mirror of server.js SHOP_FAQS (text + order). Keep in sync.
const SHOP_FAQS = [
  { keys: ['ticket', 'deliver', 'receive', 'get my account', 'where.*account', 'hand over', 'handover'], reply: 'Delivery: copy your order code from the store, open a ticket in this Discord and send it there. The seller hands over the account in the ticket.' },
  { keys: ['live', 'stream', 'host', 'tiktok', 'tiktoks', 'giveaway', 'drop'], reply: 'Ghxstly goes live on TikTok (@ghxstlyfn) — lives, giveaways and restock alerts are announced there and in this Discord. Follow so you never miss a stack.' },
  { keys: ['custom', 'build', 'dream', 'personalized', 'request account'], reply: 'Custom account: press Custom Account on the store, enter your Discord name, minimum skins and the specific skins you want. The order goes straight to the owner on Discord.' },
  { keys: ['buy', 'purchase', 'how do i get', 'how to get', 'pay', 'order', 'checkout'], reply: 'How buying works: 1) Recharge your wallet with a code from the store. 2) Press Buy on a listing and enter your Discord name. 3) You get an order code — open a Discord ticket with it and the account is handed over there.' },
  { keys: ['price', 'cost', 'how much', 'expensive', 'cheap'], reply: 'Every account is capped at $60. Prices vary per locker — check the listings. Promo codes give % off at checkout when available.' },
  { keys: ['code', 'recharge', 'balance', 'top up', 'topup', 'wallet'], reply: 'Recharge codes come from the owner (TikTok lives, giveaways, Discord). Open the wallet on the store, enter the code once — each code works a single time, then it is dead.' },
  { keys: ['warranty', 'refund', 'locked', 'recover', 'banned', 'guarantee'], reply: 'Every account has a 48-hour warranty. Locked out after purchase? Open a ticket for a replacement or refund from your seller.' },
  { keys: ['promo', 'discount', 'sale', 'coupon'], reply: 'Promo codes give a % discount at checkout. Enter yours with Apply before confirming the purchase. Each promo is single-use.' },
  { keys: ['legit', 'scam', 'trust', 'safe', 'real'], reply: 'Balances, codes and purchases are secured server-side — nothing can be faked from the browser. Order codes are instant and a real human answers support tickets.' },
  { keys: ['owner', 'admin', 'human', 'support', 'contact', 'someone'], reply: 'Need a human? Open a ticket in this Discord — a person answers, day or night.' }
];

function matchFaq(text) {
  const q = String(text || '').toLowerCase();
  if (!q.trim()) return null;
  for (const faq of SHOP_FAQS) {
    if (faq.keys.some(k => q.includes(k))) return faq.reply;
  }
  return null;
}

function headers() {
  return {
    Authorization: `Bot ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'GHXSTLY-Store-Responder (1.0.0)'
  };
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { lastSeen: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

async function main() {
  if (!TOKEN) { console.error('missing DISCORD_BOT_TOKEN'); process.exit(1); }
  if (!CHANNELS.length) { console.error('missing CHANNEL_IDS'); process.exit(1); }
  const state = loadState();
  state.lastSeen = state.lastSeen || {};
  let replied = 0, seen = 0, authFailed = false;

  for (const ch of CHANNELS) {
    const last = state.lastSeen[ch] || null;
    const url = `/channels/${ch}/messages?limit=25` + (last ? `&after=${encodeURIComponent(last)}` : '');
    const r = await api('GET', url);
    if (r.status === 401 || r.status === 403) {
      console.error(`channel ${ch}: auth failed (${r.status}). Check bot token + channel access.`);
      authFailed = true;
      continue;
    }
    if (r.status !== 200 || !Array.isArray(r.json)) {
      console.error(`channel ${ch}: unexpected ${r.status} ${String(r.text).slice(0, 120)}`);
      continue;
    }
    const msgs = [...r.json].reverse(); // oldest first
    if (!last && msgs.length) {
      // First run: baseline, never reply to history.
      state.lastSeen[ch] = msgs[msgs.length - 1].id;
      console.log(`channel ${ch}: baseline at ${state.lastSeen[ch]} (${msgs.length} old messages skipped)`);
      continue;
    }
    for (const m of msgs) {
      if (!m || !m.id) continue;
      state.lastSeen[ch] = m.id;
      seen++;
      if (m.author && m.author.bot) continue;
      const content = String(m.content || '');
      if (!content.trim() || content.trim().startsWith('/')) continue;
      const answer = matchFaq(content);
      if (!answer) continue;
      const post = await api('POST', `/channels/${ch}/messages`, {
        content: answer.slice(0, 1800),
        message_reference: { message_id: m.id }
      });
      if (post.status === 200 || post.status === 201) {
        replied++;
        console.log(`replied to ${m.id}: ${(answer).slice(0, 60)}...`);
      } else {
        console.error(`reply failed ${post.status} for ${m.id}`);
      }
    }
  }

  saveState(state);
  console.log(`done: saw=${seen} replied=${replied}`);
  if (authFailed) process.exit(1);
}

if (require.main === module) {
  module.exports.matchFaq = matchFaq;
  main().catch(err => { console.error('fatal:', err.message); process.exit(1); });
} else {
  module.exports.matchFaq = matchFaq;
}
