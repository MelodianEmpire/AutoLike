// Fix for Railway/older Node.js environments
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto;

const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────
let logs = [];
let dailyCount = 0;
let lastResetDate = new Date().toDateString();
let isRunning = false;
let sock = null;
let cycleTimeout = null;
let isConnected = false;

// ─── WebSocket Server ─────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function log(message) {
  const now = new Date();

  // Reset daily count at midnight (Nigeria time = UTC+1)
  const today = now.toDateString();
  if (today !== lastResetDate) {
    dailyCount = 0;
    lastResetDate = today;
    addLog('Brainbox: Daily counter reset. New day started.');
  }

  addLog(message);
}

function addLog(message) {
  const now = new Date();
  const timestamp = now.toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const entry = `[${timestamp}] ${message}`;
  logs.push(entry);
  if (logs.length > 500) logs.shift(); // Keep last 500 logs

  broadcast({ type: 'log', message: entry, dailyCount });
  console.log(entry);
}

// ─── Helpers ──────────────────────────────────────────────
function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── WhatsApp Connection ──────────────────────────────────
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

async function connectWhatsApp(phoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' }); // Suppress Baileys internal logs

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: ['Brainbox Store', 'Chrome', '120.0.6099.109'],
    markOnlineOnConnect: false, // Stay offline-looking
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      isConnected = false;
      broadcast({ type: 'disconnected' });

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log(`Brainbox: Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        const backoff = reconnectAttempts * 8000; // 8s, 16s, 24s...
        log(`Brainbox: Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT} in ${backoff/1000}s...`);
        await sleep(backoff);
        connectWhatsApp();
      } else if (reconnectAttempts >= MAX_RECONNECT) {
        log('Brainbox: Max reconnects reached. Please re-pair via dashboard.');
        reconnectAttempts = 0;
      } else {
        log('Brainbox: Logged out. Please re-authenticate via the dashboard.');
        // Clear auth on logout
        if (fs.existsSync('auth_info')) {
          fs.rmSync('auth_info', { recursive: true, force: true });
        }
      }
    } else if (connection === 'open') {
      isConnected = true;
      reconnectAttempts = 0; // Reset on successful connect
      log(`Brainbox: WhatsApp connected ✓ | Logged in as ${sock.user?.name || sock.user?.id}`);
      broadcast({ type: 'connected', name: sock.user?.name });
    } else if (connection === 'connecting') {
      log('Brainbox: Connecting to WhatsApp...');
    }
  });

  return sock;
}

// ─── Auto-Like Engine ─────────────────────────────────────
async function runLikeCycle() {
  if (!sock || !isRunning || !isConnected) return;

  log('Brainbox: ── Starting like cycle ──');

  try {
    // Get your own JID
    const myJid = sock.user?.id;
    if (!myJid) {
      log('Brainbox: Cannot get user ID. Skipping cycle.');
      scheduleNextCycle();
      return;
    }

    // Fetch statuses from all contacts (WhatsApp pushes these automatically)
    // We subscribe to status updates to get the list
    const contactsWithStatus = [];

    // Subscribe to get status list
    await sock.sendNode({
      tag: 'iq',
      attrs: {
        to: 'broadcast',
        type: 'get',
        xmlns: 'w:status'
      },
      content: [{ tag: 'status_list', attrs: {} }]
    }).catch(() => {}); // Some versions don't support this

    // Use contacts store as fallback
    const contactStore = sock.store?.contacts || {};
    const allContacts = Object.keys(contactStore).filter(id =>
      id.endsWith('@s.whatsapp.net') && id !== myJid
    );

    log(`Brainbox: Found ${allContacts.length} contacts to check.`);

    let likedThisCycle = 0;

    for (const contactId of allContacts) {
      if (!isRunning) break;

      try {
        // Fetch this contact's status
        const statusResult = await sock.fetchStatus(contactId).catch(() => null);

        if (statusResult && statusResult.status) {
          const contactName = contactStore[contactId]?.name
            || contactStore[contactId]?.notify
            || contactId.split('@')[0];

          // Send heart reaction to their status
          await sock.sendMessage(`${contactId}`, {
            react: {
              text: '❤️',
              key: {
                remoteJid: 'status@broadcast',
                participant: contactId,
                fromMe: false,
                id: statusResult.setAt?.toString() || Date.now().toString()
              }
            }
          }).catch(() => null);

          dailyCount++;
          likedThisCycle++;

          log(`Brainbox: ❤️ Liked status from ${contactName} | Daily total: ${dailyCount}`);
          broadcast({ type: 'liked', dailyCount });

          // Random delay between likes: 8–25 seconds (human-like)
          const delay = randomDelay(8000, 25000);
          log(`Brainbox: Waiting ${(delay / 1000).toFixed(1)}s before next like...`);
          await sleep(delay);
        }
      } catch (err) {
        // Contact has no status or inaccessible — skip silently
      }
    }

    log(`Brainbox: ── Cycle complete. Liked ${likedThisCycle} statuses. Daily total: ${dailyCount} ──`);

  } catch (error) {
    log(`Brainbox: Cycle error — ${error.message}`);
  }

  scheduleNextCycle();
}

function scheduleNextCycle() {
  if (!isRunning) return;

  // Random interval: 45–90 minutes
  const delay = randomDelay(2700000, 5400000);
  const minutes = Math.floor(delay / 60000);
  log(`Brainbox: Next cycle scheduled in ~${minutes} minutes.`);
  cycleTimeout = setTimeout(runLikeCycle, delay);
}

// ─── API Routes ───────────────────────────────────────────

// Request pairing code
app.post('/api/pair', async (req, res) => {
  let { phone } = req.body;

  if (!phone) return res.json({ success: false, error: 'Phone number is required.' });

  // Clean phone number (digits only, include country code e.g. 2347012850166)
  phone = phone.replace(/\D/g, '');
  if (!phone.startsWith('234')) {
    phone = '234' + phone.replace(/^0/, '');
  }

  log(`Brainbox: Pairing requested for +${phone}`);

  try {
    // Clear old auth if exists
    if (fs.existsSync('auth_info')) {
      fs.rmSync('auth_info', { recursive: true, force: true });
    }

    await connectWhatsApp(phone);

    // Wait for socket to initialize
    await sleep(3000);

    const code = await sock.requestPairingCode(phone);
    log(`Brainbox: Pairing code generated. Enter it in WhatsApp.`);
    res.json({ success: true, code, phone });

  } catch (error) {
    log(`Brainbox: Pairing error — ${error.message}`);
    res.json({ success: false, error: error.message });
  }
});

// Start engine
app.post('/api/start', (req, res) => {
  if (!isConnected) {
    return res.json({ success: false, error: 'WhatsApp not connected yet.' });
  }
  if (isRunning) {
    return res.json({ success: false, error: 'Engine already running.' });
  }

  isRunning = true;
  log('Brainbox: ✅ Auto-like engine STARTED');
  broadcast({ type: 'engine_started' });
  runLikeCycle();
  res.json({ success: true });
});

// Stop engine
app.post('/api/stop', (req, res) => {
  isRunning = false;
  if (cycleTimeout) clearTimeout(cycleTimeout);
  log('Brainbox: 🛑 Auto-like engine STOPPED');
  broadcast({ type: 'engine_stopped' });
  res.json({ success: true });
});

// Logout
app.post('/api/logout', async (req, res) => {
  isRunning = false;
  isConnected = false;
  if (cycleTimeout) clearTimeout(cycleTimeout);
  if (sock) {
    await sock.logout().catch(() => {});
    sock = null;
  }
  if (fs.existsSync('auth_info')) {
    fs.rmSync('auth_info', { recursive: true, force: true });
  }
  log('Brainbox: Logged out. Auth cleared.');
  broadcast({ type: 'disconnected' });
  res.json({ success: true });
});

// Get all logs + status
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    running: isRunning,
    dailyCount,
    logs: logs.slice(-100) // Last 100 logs
  });
});

// Health check (keeps server alive on Railway/Render)
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start Server ─────────────────────────────────────────
const server = app.listen(PORT, () => {
  addLog(`Brainbox: Server started on port ${PORT}`);
  addLog('Brainbox: Open the dashboard to connect WhatsApp.');
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  // Send history + current state on connect
  ws.send(JSON.stringify({
    type: 'init',
    logs: logs.slice(-100),
    dailyCount,
    connected: isConnected,
    running: isRunning
  }));
});

// Auto-reconnect if auth exists on startup
(async () => {
  if (fs.existsSync('auth_info')) {
    addLog('Brainbox: Existing session found. Reconnecting...');
    await connectWhatsApp();
  }
})();
