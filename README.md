# Ghxstly Store — Server-Secure Fortnite Account Marketplace

A Fortnite account storefront where the wallet, promo codes, purchases, and Discord notifications all run **on the server**. The browser never sees secrets, and nobody can fake a balance or reuse a code.

- Prices in USD, capped at **$60**.
- Node.js + Express, JSON-file database (`data/db.json`).

## Run it

```bash
npm install
npm run seed        # fill the catalogue (only if db.json is empty)
npm start           # http://localhost:3000
```

## Important: rotate your webhook FIRST

The webhook in `config.json` is the one that was leaked in the original page source. Anyone who has it can post to your Discord channel. **Delete it in Discord and create a new one** (Server Settings → Integrations → Webhooks → New Webhook), then put the new URL in `config.json`.

```json
{
  "port": 3000,
  "webhookUrl": "https://discord.com/api/webhooks/.../...",
  "maxPrice": 60,
  "currency": "$",
  "discordInvite": "https://discord.gg/your-invite"
}
```

Never put the webhook URL anywhere except `config.json` — it is never sent to the browser.

On hosting (Vercel) put secrets in environment variables instead of files —
they are seeded into the store at boot and override the file values:

```bash
WALLET_CODES="GHX-20-ABC:20,GHX-25-DEF:25"   # recharge codes (CODE:amount, comma-separated)
PROMO_CODES="SAVE10:10:100"                  # promo codes (CODE:discount:maxUses, comma-separated)
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/.../..."
OWNER_EMAIL="you@mail.com"                   # owner login (also enables the OWNER badge)
OWNER_PASSWORD="long-secret-here"
DISCORD_CLIENT_ID="..."                      # Discord sign-in
DISCORD_CLIENT_SECRET="..."
GHXSTLY_ACCT2_EMAIL="..."                    # stored credentials for account #2 delivery
GHXSTLY_ACCT2_PASSWORD="..."
```

## Admin CLI

```bash
node admin.js codegen 20 10        # generate 10 recharge codes worth $20 each
node admin.js codes                # list unused recharge codes
node admin.js promo GHX10 10 50    # promo code: 10% off, max 50 uses
node admin.js promos               # list promos
node admin.js orders               # list recent orders (incl. Discord notified flag)
node admin.js order <codeOrId>     # full order details
node admin.js notify <codeOrId>    # re-send Discord notification for an order
node admin.js accounts             # list accounts (incl. sold)
node admin.js restore <id>         # re-list a sold account
node admin.js import file.json     # import accounts [{name,tier,tierVar,price,skins,desc,chips,warranty}]
```

## How a sale works

1. Buyer recharges wallet with a code you generated (`codegen`). Codes are single-use and checked server-side.
2. Buyer clicks **Buy** on an account, optionally applies a promo code.
3. Server checks balance, deducts it, marks the account sold, records the order, and DMs/announces it to your Discord via the webhook (server-side only).
4. Buyer copies the order code and opens a Discord ticket; you hand over the account.
5. If the Discord message ever fails, the order is still recorded — run `node admin.js notify <id>` to retry.

## Selling to real buyers over the internet

This runs locally over `http://localhost:3000`. To sell to real people you must deploy it (e.g. on a VPS/Railway/Fly.io), set it to HTTPS, and change `secure: true` for the session cookie in `server.js`.