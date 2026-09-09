# DEPLOY — go live with a free demo URL

Two options, no credit card needed.

---

## OPTION A — Render + GitHub (recommended)

Fast, reliable, you get `https://your-app-name.onrender.com` for free.

1. **Push the project to GitHub**
   - Create a free account at https://github.com
   - New repository → name it e.g. `ghxstly-store` → make it **Private** (important: `config.json` has your webhook)
   - In this project folder run:
     ```
     git init
     git add .
     git commit -m "initial"
     git remote add origin https://github.com/YOUR_USERNAME/ghxstly-store.git
     git push -u origin main
     ```
   - (`.gitignore` already blocks `config.json`, `data/`, `admin-codes.txt` from being committed — the codes already live in `data/db.json` which is ignored too.)
   - **NOTE:** because `data/` is git-ignored, the DB won't be in the repo. That's fine for a demo — Render generates a fresh one on first run.

2. **Create a Render account** → https://render.com (free, sign in with GitHub)
3. **New Web Service** → "Build and deploy from a Git repository" → pick `ghxstly-store`
4. It auto-detects the `Dockerfile`. If asked: Runtime = **Docker**, Region = **Frankfurt**, Instance type = **Free**.
5. Click **Create Web Service** and wait ~3–5 min for the build.
6. Grab your URL from the top: `https://ghxstly-store.onrender.com` (or whatever you named it).

> Free tier notes:
> - The site **sleeps** after 15 min idle; the first visitor after that waits ~30–60s while it wakes up.
> - The disk is **wiped on every redeploy/restart** → the wallet DB resets. For a live shop this is only a demo; upgrade to a VPS (below) when it's real.
> - Custom domain (`yourname.com`) needs the paid plan — see "Go .com" section.

---

## OPTION B — Replit (no Git, fastest to try)

1. Go to https://replit.com → Sign up (free).
2. **Create Repl** → "Import from GitHub" isn't needed: choose **Blank Repl (Node.js)**.
3. Upload the project files (drag all except `node_modules`, `*.log`, `data/`) into the Repl — keep `public/` folder intact. Re-upload `config.json` too, but after upload **add the webhook as a Secret** instead of leaving it in the file if your repl is public.
4. In the Shell run: `npm install`
5. Press **Run**. Replit injects a `PORT` automatically, so it starts right away and gives you a URL like `https://yourreplname.replit.app`.

---

## GO .COM LATER (real site)

1. Buy a `.com` at https://www.cloudflare.com (prices domain at cost, ~$10/yr) or Namecheap (~$10/yr).
2. Rent a small VPS: OVH / Contabo / Hetzner (~$3–6/mo, Morocco-friendly).
3. On the VPS: install Node 20 + the project, run with `node server.js` behind Nginx + free Cloudflare SSL.
   - `config.json` lives ON the VPS only → webhook stays private.
   - DB now persists permanently (no resets).
4. Then the full shop is safe for real sales.

---

## Admin after deploy

Your admin CLI works wherever the site runs — run it **in the deployed project folder**:
```
node setup.js      # fresh DB + 100 recharge + 100 promo codes (prints admin-codes.txt)
node admin.js codes
node admin.js promos
node admin.js orders
```