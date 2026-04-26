// Polyfill crypto for older Node environments (Railway fix)
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto || crypto;

const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const WebSocket = require('ws');
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
let cycleTimeout = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

// ─── WebSocket Server ─────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

function addLog(message) {
  const now = new Date();
  const today = now.toDateString();
  if (today !== lastResetDate) { dailyCount = 0; lastResetDate = today; }

  const timestamp = now.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  const entry = `[${timestamp}] ${message}`;
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcast({ type: 'log', message: entry, dailyCount });
  console.log(entry);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (a, b) => Math.floor(Math.random() * (b - a)) + a;

function cleanPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0')) p = '234' + p.slice(1);
  else if (!p.startsWith('234')) p = '234' + p;
  return p;
}

function killSocket() {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch (_) {}
  try { sock.end(new Error('kill')); } catch (_) {}
  sock = null;
}

// ─── Shared connection listener ───────────────────────────
function attachConnectionListener() {
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0;
      addLog(`Brainbox: Connected as ${sock.user?.name || sock.user?.id}`);
      broadcast({ type: 'connected', name: sock.user?.name });

    } else if (connection === 'connecting') {
      addLog('Brainbox: Connecting to WhatsApp...');

    } else if (connection === 'close') {
      isConnected = false;
      broadcast({ type: 'disconnected' });
      const code = lastDisconnect?.error?.output?.statusCode;
      addLog(`Brainbox: Disconnected (code: ${code ?? 'unknown'})`);

      if (code === DisconnectReason.loggedOut) {
        addLog('Brainbox: Logged out. Re-pair via dashboard.');
        if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
        return;
      }
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const delay = reconnectAttempts * 7000;
        addLog(`Brainbox: Reconnect ${reconnectAttempts}/${MAX_RECONNECT} in ${delay/1000}s...`);
        await sleep(delay);
        connectWhatsApp();
      } else {
        addLog('Brainbox: Max reconnects hit. Re-pair via dashboard.');
        reconnectAttempts = 0;
      }
    }
  });
}

// ─── Normal reconnect (existing session) ─────────────────
async function connectWhatsApp() {
  killSocket();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ['Brainbox Store', 'Chrome', '124.0.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);
  attachConnectionListener();
}

// ─── Auto-Like Engine ─────────────────────────────────────
async function runLikeCycle() {
  if (!isRunning || !isConnected || !sock) return;
  addLog('Brainbox: Starting like cycle...');
  let liked = 0;

  try {
    const myJid = sock.user?.id;
    if (!myJid) { addLog('Brainbox: No user ID. Skipping.'); scheduleNextCycle(); return; }

    const contacts = sock.store?.contacts || {};
    const ids = Object.keys(contacts).filter(id => id.endsWith('@s.whatsapp.net') && id !== myJid);
    addLog(`Brainbox: ${ids.length} contacts to check.`);

    for (const id of ids) {
      if (!isRunning) break;
      try {
        const s = await sock.fetchStatus(id).catch(() => null);
        if (s?.status) {
          const name = contacts[id]?.name || contacts[id]?.notify || id.split('@')[0];
          await sock.sendMessage(id, {
            react: {
              text: '❤️',
              key: { remoteJid: 'status@broadcast', participant: id, fromMe: false, id: s.setAt?.toString() || Date.now().toString() }
            }
          }).catch(() => null);
          dailyCount++; liked++;
          addLog(`Brainbox: Liked ${name}'s status | Daily: ${dailyCount}`);
          broadcast({ type: 'liked', dailyCount });
          await sleep(randomDelay(8000, 25000));
        }
      } catch (_) {}
    }
    addLog(`Brainbox: Cycle done. Liked ${liked} | Daily: ${dailyCount}`);
  } catch (e) {
    addLog(`Brainbox: Cycle error — ${e.message}`);
  }
  scheduleNextCycle();
}

function scheduleNextCycle() {
  if (!isRunning) return;
  const d = randomDelay(2700000, 5400000);
  addLog(`Brainbox: Next cycle in ~${Math.floor(d/60000)} min.`);
  cycleTimeout = setTimeout(runLikeCycle, d);
}

// ─── API Routes ───────────────────────────────────────────

app.post('/api/pair', async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.json({ success: false, error: 'Phone number required.' });
  phone = cleanPhone(phone);
  addLog(`Brainbox: Pairing for +${phone}...`);

  try {
    if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
    killSocket();

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    // Create socket
    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      printQRInTerminal: false,
      browser: ['Brainbox Store', 'Chrome', '124.0.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    attachConnectionListener();

    // KEY FIX: request code immediately (1.5s delay just for WS handshake to start)
    await sleep(1500);
    const code = await sock.requestPairingCode(phone);
    addLog(`Brainbox: Code sent — enter it in WhatsApp immediately (expires in ~60s).`);
    res.json({ success: true, code, phone });

  } catch (err) {
    addLog(`Brainbox: Pairing error — ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/start', (req, res) => {
  if (!isConnected) return res.json({ success: false, error: 'Not connected.' });
  if (isRunning) return res.json({ success: false, error: 'Already running.' });
  isRunning = true;
  addLog('Brainbox: Engine STARTED');
  broadcast({ type: 'engine_started' });
  runLikeCycle();
  res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  if (cycleTimeout) clearTimeout(cycleTimeout);
  addLog('Brainbox: Engine STOPPED');
  broadcast({ type: 'engine_stopped' });
  res.json({ success: true });
});

app.post('/api/logout', async (req, res) => {
  isRunning = false; isConnected = false;
  if (cycleTimeout) clearTimeout(cycleTimeout);
  try { await sock?.logout(); } catch (_) {}
  killSocket();
  if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
  addLog('Brainbox: Logged out.');
  broadcast({ type: 'disconnected' });
  res.json({ success: true });
});

app.get('/api/status', (req, res) =>
  res.json({ connected: isConnected, running: isRunning, dailyCount, logs: logs.slice(-100) }));

app.get('/health', (_, res) => res.send('OK'));

// ─── Server ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
  addLog(`Brainbox: Server on port ${PORT}`);
  addLog('Brainbox: Open dashboard to connect WhatsApp.');
});

server.on('upgrade', (req, socket, head) =>
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));

wss.on('connection', ws => ws.send(JSON.stringify({
  type: 'init', logs: logs.slice(-100), dailyCount, connected: isConnected, running: isRunning
})));

// Auto-reconnect on startup
(async () => {
  if (fs.existsSync('auth_info')) {
    addLog('Brainbox: Session found. Reconnecting...');
    await connectWhatsApp();
  }
})();
