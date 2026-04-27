const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto || crypto;

const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────
let logs = [];
let dailyCount = 0;
let lastResetDate = new Date().toDateString();
let isRunning = false;
let sock = null;
let myJid = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

const logger = pino({ level: 'silent' });
const store = makeInMemoryStore({ logger });

// Saved contacts tracking
const SAVED_FILE = 'saved_contacts.json';
let savedContacts = new Set();
if (fs.existsSync(SAVED_FILE)) {
  try { savedContacts = new Set(JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'))); } catch(_) {}
}
function persistSaved() {
  fs.writeFileSync(SAVED_FILE, JSON.stringify([...savedContacts]));
}

// ─── Google OAuth2 ────────────────────────────────────────
const GTOKEN_FILE = 'google_token.json';
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

if (fs.existsSync(GTOKEN_FILE)) {
  try { oauth2Client.setCredentials(JSON.parse(fs.readFileSync(GTOKEN_FILE, 'utf8'))); } catch(_) {}
}
oauth2Client.on('tokens', tokens => {
  const current = fs.existsSync(GTOKEN_FILE)
    ? JSON.parse(fs.readFileSync(GTOKEN_FILE, 'utf8')) : {};
  fs.writeFileSync(GTOKEN_FILE, JSON.stringify({ ...current, ...tokens }));
});

function isGoogleAuthed() {
  const c = oauth2Client.credentials;
  return !!(c && (c.access_token || c.refresh_token));
}

// ─── Name Parser ──────────────────────────────────────────
function parseContactName(rawName) {
  if (!rawName) return null;
  const name = rawName.trim();
  const hasSpecial = /[$()%@#!*&^]/.test(name);
  const hasEmoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(name);
  const words = name.split(/\s+/).filter(Boolean);

  if (hasSpecial || (hasEmoji && words.length <= 2)) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  if (words.length === 1) {
    return words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
  }
  const realWords = words.filter(w => !/^[A-Z]{2,}$/.test(w));
  const pool = realWords.length ? realWords : words;
  const chosen = pool.length >= 2 ? pool[1] : pool[0];
  return chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase();
}

// ─── Save to Google Contacts ──────────────────────────────
async function saveToGoogleContacts(phone, displayName, rawName) {
  if (!isGoogleAuthed()) {
    addLog(`Brainbox: Google not connected — skipping ${displayName}`);
    return false;
  }
  try {
    const people = google.people({ version: 'v1', auth: oauth2Client });
    await people.people.createContact({
      requestBody: {
        names: [{ givenName: displayName, displayName }],
        phoneNumbers: [{ value: '+' + phone, type: 'mobile' }],
        biographies: [{ value: `WhatsApp name: ${rawName}`, contentType: 'TEXT_PLAIN' }],
        emailAddresses: []
      }
    });
    addLog(`Brainbox: ✅ Saved to Google Contacts — ${displayName} (+${phone})`);
    broadcast({ type: 'contact_saved', name: displayName, phone });
    return true;
  } catch (err) {
    addLog(`Brainbox: Google save failed for ${displayName} — ${err.message}`);
    return false;
  }
}

// ─── WebSocket ────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
function broadcast(data) {
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); });
}

function addLog(msg) {
  const now = new Date();
  if (now.toDateString() !== lastResetDate) { dailyCount = 0; lastResetDate = now.toDateString(); }
  const ts = now.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const entry = `[${ts}] ${msg}`;
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcast({ type: 'log', message: entry, dailyCount });
  console.log(entry);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a)) + a;

function killSocket() {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch (_) {}
  try { sock.end(new Error('kill')); } catch (_) {}
  sock = null;
}

// ─── WhatsApp Connect ─────────────────────────────────────
async function connectWhatsApp() {
  killSocket();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ['Brainbox Store', 'Chrome', '124.0.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  store.bind(sock.ev);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      addLog('Brainbox: QR ready — scan in WhatsApp now.');
      try {
        const img = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        broadcast({ type: 'qr', image: img });
      } catch (e) { addLog('Brainbox: QR error — ' + e.message); }
    }

    if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      myJid = jidNormalizedUser(sock.user?.id);
      addLog(`Brainbox: ✅ Connected as ${sock.user?.name || myJid}`);
      broadcast({ type: 'connected', name: sock.user?.name });

    } else if (connection === 'connecting') {
      addLog('Brainbox: Connecting...');

    } else if (connection === 'close') {
      isConnected = false;
      myJid = null;
      broadcast({ type: 'disconnected' });
      const code = lastDisconnect?.error?.output?.statusCode;
      addLog(`Brainbox: Disconnected (code: ${code ?? 'unknown'})`);

      if (code === DisconnectReason.loggedOut) {
        addLog('Brainbox: Logged out. Scan QR again.');
        if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
        return;
      }
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        await sleep(reconnectAttempts * 7000);
        connectWhatsApp();
      } else {
        addLog('Brainbox: Max reconnects. Generate QR again.');
        reconnectAttempts = 0;
      }
    }
  });

  // ── Real-time status listener ─────────────────────────
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!isRunning) return;
    for (const msg of messages) {
      if (msg.key?.remoteJid !== 'status@broadcast') continue;
      if (msg.key?.fromMe) continue;

      const senderJid = msg.key?.participant || msg.key?.remoteJid;
      if (!senderJid) continue;

      const senderName = store.contacts[senderJid]?.name
        || store.contacts[senderJid]?.notify
        || senderJid.split('@')[0];

      addLog(`Brainbox: 📱 Status from ${senderName} — liking...`);
      await sleep(rand(3000, 12000));

      try {
        await sock.readMessages([msg.key]);
        await sock.sendMessage(senderJid, {
          react: { text: '❤️', key: msg.key }
        });
        dailyCount++;
        addLog(`Brainbox: ❤️ Liked ${senderName}'s status | Daily: ${dailyCount}`);
        broadcast({ type: 'liked', dailyCount });
      } catch (err) {
        addLog(`Brainbox: Like failed — ${err.message}`);
      }
    }
  });

  // ── Auto-save new contacts to Google ─────────────────
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const contact of contacts) {
      const jid = contact.id;
      if (!jid?.endsWith('@s.whatsapp.net')) continue;
      if (savedContacts.has(jid)) continue;

      const rawName = contact.name || contact.notify || contact.verifiedName;
      if (!rawName) continue;

      const phone = jid.split('@')[0];
      const displayName = parseContactName(rawName);
      if (!displayName) continue;

      addLog(`Brainbox: 🆕 New contact — "${rawName}" → "${displayName}"`);
      await sleep(rand(1000, 3000));

      const ok = await saveToGoogleContacts(phone, displayName, rawName);
      if (ok) { savedContacts.add(jid); persistSaved(); }
    }
  });
}

// ─── Google Auth Routes ───────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/contacts'],
    login_hint: 'brainboxstores@gmail.com'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(GTOKEN_FILE, JSON.stringify(tokens));
    addLog('Brainbox: ✅ Google Contacts connected!');
    broadcast({ type: 'google_connected' });
    res.send(`<html><body style="background:#0a0f0a;color:#00ff88;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:1.2rem;">
      ✅ Google Contacts connected! You can close this tab.
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (e) {
    addLog('Brainbox: Google auth error — ' + e.message);
    res.send('Auth failed: ' + e.message);
  }
});

app.get('/api/google/status', (_, res) =>
  res.json({ connected: isGoogleAuthed() }));

app.post('/api/google/disconnect', (_, res) => {
  if (fs.existsSync(GTOKEN_FILE)) fs.rmSync(GTOKEN_FILE);
  oauth2Client.revokeCredentials().catch(() => {});
  addLog('Brainbox: Google Contacts disconnected.');
  broadcast({ type: 'google_disconnected' });
  res.json({ success: true });
});

// ─── WhatsApp Routes ──────────────────────────────────────
app.post('/api/qr', async (req, res) => {
  addLog('Brainbox: Generating QR...');
  try {
    if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
    await connectWhatsApp();
    res.json({ success: true });
  } catch (e) {
    addLog('Brainbox: QR error — ' + e.message);
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/start', (req, res) => {
  if (!isConnected) return res.json({ success: false, error: 'Not connected.' });
  if (isRunning) return res.json({ success: false, error: 'Already running.' });
  isRunning = true;
  addLog('Brainbox: ▶ Engine STARTED — listening for statuses in real-time');
  broadcast({ type: 'engine_started' });
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  addLog('Brainbox: ■ Engine STOPPED');
  broadcast({ type: 'engine_stopped' });
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  isRunning = false; isConnected = false; myJid = null;
  try { await sock?.logout(); } catch (_) {}
  killSocket();
  if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
  addLog('Brainbox: Logged out.');
  broadcast({ type: 'disconnected' });
  res.json({ success: true });
});

app.get('/api/status', (_, res) =>
  res.json({ connected: isConnected, running: isRunning, dailyCount,
    googleAuthed: isGoogleAuthed(), logs: logs.slice(-100) }));

app.get('/health', (_, res) => res.send('OK'));

// ─── Server ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
  addLog(`Brainbox: Server on port ${PORT}`);
  addLog('Brainbox: Open dashboard → Generate QR to connect.');
});

server.on('upgrade', (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));

wss.on('connection', ws => ws.send(JSON.stringify({
  type: 'init', logs: logs.slice(-100), dailyCount,
  connected: isConnected, running: isRunning, googleAuthed: isGoogleAuthed()
})));

(async () => {
  if (fs.existsSync('auth_info')) {
    addLog('Brainbox: Session found. Reconnecting...');
    await connectWhatsApp();
  }
})();
