# Brainbox Auto-Like — Setup & Deployment

## Files
- `server.js` — Node.js backend (WhatsApp + Express + WebSocket)
- `public/index.html` — Web dashboard
- `package.json` — Dependencies

---

## Local Setup (Test First)

1. Install Node.js 18+ from nodejs.org
2. Run:
   ```
   npm install
   node server.js
   ```
3. Open http://localhost:3000
4. Enter your WhatsApp number → Get pairing code
5. Go to WhatsApp → Settings → Linked Devices → Link with phone number → Enter code
6. Once connected, click "Start Auto-Like"

---

## Deploy on Railway.app (FREE — Runs 24/7)

Railway is the recommended host. It runs Node.js in the background permanently,
even when nobody visits the link. Free tier = $5 credit/month (usually enough).

### Steps:
1. Create account at https://railway.app (free)
2. Install Railway CLI or use GitHub:
   - Push these 3 files to a GitHub repo
   - Go to Railway → New Project → Deploy from GitHub → Select your repo
3. Railway auto-detects Node.js and runs `npm start`
4. Go to Settings → Networking → Generate Domain (you get a free URL)
5. Visit your URL and log in WhatsApp once — it stays connected forever

### Environment:
- Railway keeps the server alive 24/7 automatically
- No need to visit the URL for it to keep running
- Auth session is saved in `auth_info/` folder on the server

---

## Deploy on Render.com (Alternative — Free)

1. Create account at https://render.com
2. New → Web Service → Connect GitHub repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Free tier spins down after 15 min of inactivity (not ideal)
   → Upgrade to $7/month for always-on

---

## ⚠️ Important Notes

- **Test on a spare number first** before using your Brainbox Store number
- Auth session is saved locally — you only need to pair once
- If WhatsApp disconnects, the app auto-reconnects using saved session
- Random intervals (45–90 min between cycles) + random delays (8–25s between likes)
  make it look human-like

---

## Dashboard Features

- Enter phone number → Get 8-digit pairing code → Link in WhatsApp app
- Start / Stop engine with one click
- Live terminal logs: every action with timestamp (Africa/Lagos timezone)
- Daily counter: resets at midnight automatically
- Auto-reconnects if WhatsApp disconnects
