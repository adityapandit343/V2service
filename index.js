import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import qrcode from 'qrcode';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
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

// टाइपिंग और रिप्लाई की देरी (सेकंड में)
const TYPING_DURATION = parseInt(process.env.TYPING_DURATION) || 2000;  // 2 सेकंड टाइपिंग
const PAUSE_DURATION = parseInt(process.env.PAUSE_DURATION) || 1000;   // 1 सेकंड पॉज़
const REPLY_DELAY = parseInt(process.env.REPLY_DELAY) || 3000;         // 3 सेकंड टोटल देरी

// Session directory बनाएं
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

// सभी sessions store करें
const sessions = new Map();

// ========== HELPER FUNCTIONS ==========

// देरी के लिए function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// टाइपिंग इंडिकेटर दिखाने के लिए
async function showTyping(socket, jid) {
  try {
    await socket.sendPresenceUpdate('composing', jid);  // टाइपिंग शुरू
    await delay(TYPING_DURATION);                       // टाइपिंग दिखाएं
    await socket.sendPresenceUpdate('paused', jid);     // टाइपिंग बंद
    await delay(PAUSE_DURATION);                        // थोड़ा रुकें
  } catch (error) {
    logger.warn({ error: error.message }, 'Typing indicator failed');
  }
}

// API Key check middleware
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }
  next();
}

// Status notify करें
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
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsAppBot', 'Chrome', '1.0.0']
  });

  // Session store करें
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

    // QR Code generate हुआ
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

    // Connection close हुआ
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      if (reason === DisconnectReason.loggedOut) {
        logger.info({ sessionId }, 'Session logged out');
        const session = sessions.get(sessionId);
        if (session) session.status = 'disconnected';
        notifyStatus(sessionId, 'disconnected');
      } else if (reason !== DisconnectReason.connectionReplaced) {
        logger.info({ sessionId }, 'Reconnecting...');
        setTimeout(() => {
          startSession(sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl);
        }, 3000);
      }
    }

    // Connected!
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

  // Credentials save करें
  sock.ev.on('creds.update', saveCreds);

  // ========== MESSAGE HANDLER WITH TYPING SIMULATION ==========
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'connected') return;

    for (const msg of messages) {
      // Skip if message is from me or no content
      if (msg.key.fromMe || !msg.message) continue;

      // Message text extract करें
      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || '';
      
      if (!text) continue;

      const senderJid = msg.key.remoteJid;
      const senderPhone = senderJid.replace('@s.whatsapp.net', '');

      logger.info({ sessionId, from: senderPhone, text }, 'Message received');

      try {
        // ⭐ Step 1: Show typing indicator
        await showTyping(sock, senderJid);
        
        // ⭐ Step 2: Wait before reply (3 seconds)
        await delay(REPLY_DELAY);

        // ⭐ Step 3: Call your .NET webhook
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

        // ⭐ Step 4: Send reply
        const reply = response.data?.answer || response.data?.reply || response.data?.message;
        if (reply) {
          await sock.sendMessage(senderJid, { text: reply });
          logger.info({ sessionId, to: senderPhone }, 'Reply sent after typing simulation');
        }

      } catch (error) {
        logger.error({ error: error.message, sessionId }, 'Failed to process message');
        
        // Optional: Send error message to user
        if (error.code === 'ECONNABORTED') {
          await sock.sendMessage(senderJid, { 
            text: '⏰ Server is busy. Please try again in a moment.' 
          });
        }
      }
    }
  });

  return sessions.get(sessionId);
}

// ========== API ROUTES ==========

// 1. Session शुरू करें
app.post('/sessions/start', requireApiKey, async (req, res) => {
  const { sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl } = req.body;
  
  if (!sessionId || !tenantPhoneNumber || !callbackUrl) {
    return res.status(400).json({ 
      error: 'Missing required fields: sessionId, tenantPhoneNumber, callbackUrl' 
    });
  }

  // Old session delete करें अगर है
  const existing = sessions.get(sessionId);
  if (existing?.socket) {
    try { await existing.socket.logout(); } catch {}
    sessions.delete(sessionId);
  }

  try {
    await startSession(sessionId, tenantPhoneNumber, callbackUrl, statusCallbackUrl);
    
    // थोड़ा wait करें QR code के लिए
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

// 2. Session status check करें
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

// 3. Session disconnect करें
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

// 4. Manually message भेजें
app.post('/messages/send', requireApiKey, async (req, res) => {
  const { sessionId, to, message } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  const jid = `${to.replace('+', '')}@s.whatsapp.net`;
  
  try {
    // Typing indicator दिखाएं पहले
    await showTyping(session.socket, jid);
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Health check
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