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
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json());

// ========== ENVIRONMENT VARIABLES ==========
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'CHANGE_THIS_NODE_API_KEY';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'CHANGE_THIS_WEBHOOK_SECRET';
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const TYPING_DURATION = parseInt(process.env.TYPING_DURATION) || 2000;
const PAUSE_DURATION = parseInt(process.env.PAUSE_DURATION) || 1000;
const REPLY_DELAY = parseInt(process.env.REPLY_DELAY) || 3000;

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

// ========== HELPER FUNCTIONS ==========

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function showTyping(socket, jid) {
  try {
    await socket.sendPresenceUpdate('composing', jid);
    await delay(TYPING_DURATION);
    await socket.sendPresenceUpdate('paused', jid);
    await delay(PAUSE_DURATION);
  } catch (error) {
    logger.warn({ error: error.message }, 'Typing indicator failed');
  }
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }
  next();
}

async function notifyStatus(sessionId, status) {
  const session = sessions.get(sessionId);
  if (!session?.statusCallbackUrl) return;
  
  try {
    await axios.post(session.statusCallbackUrl, {
      sessionId,
      status,
      timestamp: Date.now()
    }, {
      headers: { 'x-webhook-secret': WEBHOOK_SECRET },
      timeout: 5000
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Status notification failed');
  }
}

// ========== MAIN SESSION FUNCTION ==========

async function startSession(sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsAppBot', 'Chrome', '1.0.0']
  });

  sessions.set(sessionId, {
    socket: sock,
    status: 'pending',
    qrCode: null,
    qrDataUrl: null,
    tenantPhoneNumber,
    callbackUrl,
    statusCallbackUrl
  });

  // QR Code and Connection Events
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
      logger.info({ sessionId }, 'QR Code generated');
    }

    if (connection === 'close') {
      // बिना Boom के statusCode निकालें
      let statusCode = null;
      if (lastDisconnect?.error) {
        statusCode = lastDisconnect.error?.output?.statusCode || 
                     lastDisconnect.error?.statusCode ||
                     (lastDisconnect.error?.message ? 500 : null);
      }
      
      // Check for logged out
      const isLoggedOut = statusCode === DisconnectReason.loggedOut ||
                         lastDisconnect?.error?.message?.includes('logged out');
      
      if (isLoggedOut) {
        logger.info({ sessionId }, 'Session logged out');
        const session = sessions.get(sessionId);
        if (session) session.status = 'disconnected';
        notifyStatus(sessionId, 'disconnected');
      } else if (statusCode !== DisconnectReason.connectionReplaced) {
        logger.info({ sessionId, statusCode }, 'Reconnecting...');
        setTimeout(() => {
          startSession(sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl);
        }, 3000);
      }
    }

    if (connection === 'open') {
      logger.info({ sessionId }, 'WhatsApp connected successfully');
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'connected';
        session.qrCode = null;
        session.qrDataUrl = null;
      }
      notifyStatus(sessionId, 'connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Message Handler with Typing Simulation
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'connected') return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || '';
      
      if (!text) continue;

      const senderJid = msg.key.remoteJid;
      const senderPhone = senderJid.replace('@s.whatsapp.net', '');

      logger.info({ sessionId, from: senderPhone, text }, 'Message received');

      try {
        // Show typing indicator
        await showTyping(sock, senderJid);
        
        // Wait before reply
        await delay(REPLY_DELAY);

        // Call webhook
        const response = await axios.post(session.callbackUrl, {
          recipientPhoneNumber: session.tenantPhoneNumber,
          senderPhoneNumber: `+${senderPhone}`,
          messageText: text,
          messageId: msg.key.id,
          timestamp: Date.now()
        }, {
          headers: { 
            'x-webhook-secret': WEBHOOK_SECRET,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });

        const reply = response.data?.answer || response.data?.reply || response.data?.message;
        if (reply) {
          await sock.sendMessage(senderJid, { text: reply });
          logger.info({ sessionId, to: senderPhone }, 'Reply sent');
        }

      } catch (error) {
        logger.error({ error: error.message, sessionId }, 'Failed to process message');
        
        if (error.code === 'ECONNABORTED') {
          await sock.sendMessage(senderJid, { 
            text: '⏰ Server is busy. Please try again in a moment.' 
          }).catch(e => logger.error(e.message));
        }
      }
    }
  });

  return sessions.get(sessionId);
}

// ========== API ROUTES ==========

app.post('/sessions/start', requireApiKey, async (req, res) => {
  const { sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl } = req.body;
  
  if (!sessionId || !tenantPhoneNumber || !callbackUrl) {
    return res.status(400).json({ 
      error: 'Missing required fields: sessionId, tenantPhoneNumber, callbackUrl' 
    });
  }

  const existing = sessions.get(sessionId);
  if (existing?.socket) {
    try { await existing.socket.logout(); } catch {}
    sessions.delete(sessionId);
  }

  try {
    await startSession(sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl);
    await delay(2000);
    
    const session = sessions.get(sessionId);
    res.json({
      success: true,
      sessionId,
      status: session?.status,
      qrCode: session?.qrDataUrl
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start session');
    res.status(500).json({ error: 'Failed to start session' });
  }
});

app.get('/sessions/:sessionId/status', requireApiKey, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.json({ status: 'not_found', qrCode: null });
  }
  res.json({
    status: session.status,
    qrCode: session.qrDataUrl,
    phoneNumber: session.tenantPhoneNumber
  });
});

app.post('/sessions/:sessionId/disconnect', requireApiKey, async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    await session.socket.logout();
    sessions.delete(req.params.sessionId);
    res.json({ success: true, message: 'Session disconnected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/messages/send', requireApiKey, async (req, res) => {
  const { sessionId, to, message } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  const jid = `${to.replace('+', '')}@s.whatsapp.net`;
  
  try {
    await showTyping(session.socket, jid);
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  logger.info(`✅ WhatsApp Bridge Server Running on port ${PORT}`);
  logger.info(`📱 Typing Duration: ${TYPING_DURATION}ms`);
  logger.info(`⏰ Reply Delay: ${REPLY_DELAY}ms`);
});