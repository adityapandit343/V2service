import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import qrcode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'CHANGE_THIS_NODE_API_KEY';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'CHANGE_THIS_WEBHOOK_SECRET';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

// In-memory session store: sessionId → { socket, qrCode, status, callbackUrl, tenantId }
const sessions = new Map();

// ── Auth middleware ────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Start a new WhatsApp session ───────────────────────────────────────────
async function startSession(sessionId, tenantId, tenantPhoneNumber, callbackUrl, statusCallbackUrl) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['ChatbotSystem', 'Chrome', '1.0.0'],
  });

  sessions.set(sessionId, {
    socket: sock,
    qrCode: null,
    qrDataUrl: null,
    status: 'pending',
    callbackUrl,
    statusCallbackUrl,
    tenantId,
    tenantPhoneNumber,
    sessionId
  });

  // QR code event
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr);
      const session = sessions.get(sessionId);
      if (session) {
        session.qrCode = qr;
        session.qrDataUrl = qrDataUrl;
        session.status = 'awaiting_scan';
      }
      logger.info({ sessionId }, 'QR code generated');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const session = sessions.get(sessionId);

      if (reason === DisconnectReason.loggedOut) {
        logger.info({ sessionId }, 'Logged out');
        if (session) { session.status = 'disconnected'; }
        notifyStatus(sessionId, 'disconnected');
      } else if (reason !== DisconnectReason.connectionReplaced) {
        logger.info({ sessionId, reason }, 'Reconnecting...');
        if (session) { session.status = 'reconnecting'; }
        setTimeout(() => startSession(sessionId, tenantId, tenantPhoneNumber, callbackUrl, statusCallbackUrl), 3000);
      }
    }

    if (connection === 'open') {
      logger.info({ sessionId }, 'WhatsApp connected');
      const session = sessions.get(sessionId);
      if (session) { session.status = 'connected'; session.qrCode = null; }
      notifyStatus(sessionId, 'connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Incoming message handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const session = sessions.get(sessionId);
      if (!session) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      const senderJid = msg.key.remoteJid;
      const senderPhone = senderJid.replace('@s.whatsapp.net', '').replace('@g.us', '');

      logger.info({ sessionId, from: senderPhone, text }, 'Incoming message');

      try {
        // Call .NET webhook; it returns the answer.
        const res = await axios.post(session.callbackUrl, {
          recipientPhoneNumber: session.tenantPhoneNumber,
          senderPhoneNumber: `+${senderPhone}`,
          messageText: text,
          messageId: msg.key.id
        }, {
          headers: { 'x-webhook-secret': WEBHOOK_SECRET },
          timeout: 10000
        });

        const answer = res.data?.answer || res.data?.fallback;
        if (answer) {
          await sock.sendMessage(senderJid, { text: answer });
          logger.info({ sessionId, to: senderPhone }, 'Reply sent');
        }
      } catch (err) {
        logger.error({ err: err.message, sessionId }, 'Failed to get/send reply');
      }
    }
  });

  return sessions.get(sessionId);
}

async function notifyStatus(sessionId, status) {
  const session = sessions.get(sessionId);
  if (!session?.statusCallbackUrl) return;
  try {
    await axios.post(session.statusCallbackUrl,
      { sessionId, status },
      { headers: { 'x-webhook-secret': WEBHOOK_SECRET }, timeout: 5000 }
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to notify status');
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Start or restart a session
app.post('/sessions/start', requireApiKey, async (req, res) => {
  const { sessionId, tenantId, tenantPhoneNumber, callbackUrl, statusCallbackUrl } = req.body;
  if (!sessionId || !tenantPhoneNumber || !callbackUrl) return res.status(400).json({ error: 'Missing fields' });

  // Stop existing if any
  const existing = sessions.get(sessionId);
  if (existing?.socket) {
    try { await existing.socket.logout(); } catch {}
    sessions.delete(sessionId);
  }

  try {
    const session = await startSession(sessionId, tenantId, tenantPhoneNumber, callbackUrl, statusCallbackUrl);
    // Wait briefly for QR
    await new Promise(r => setTimeout(r, 2000));
    const current = sessions.get(sessionId);
    res.json({ sessionId, status: current?.status, qrCode: current?.qrDataUrl });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to start session');
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Get session status (polling)
app.get('/sessions/:sessionId/status', requireApiKey, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.json({ status: 'not_found', qrCode: null });
  res.json({ status: session.status, qrCode: session.qrDataUrl });
});

// Disconnect session
app.post('/sessions/:sessionId/disconnect', requireApiKey, async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try {
    await session.socket.logout();
  } catch {}
  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

// Send a message (optional, for outbound from .NET)
app.post('/messages/send', requireApiKey, async (req, res) => {
  const { sessionId, to, message } = req.body;
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'connected')
    return res.status(400).json({ error: 'Session not connected' });

  const jid = `${to.replace('+', '')}@s.whatsapp.net`;
  try {
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.listen(PORT, () => logger.info(`WhatsApp bridge running on port ${PORT}`));
