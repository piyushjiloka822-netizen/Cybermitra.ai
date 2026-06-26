// ─────────────────────────────────────────────────────────
// telegram.js — Webhook-based Telegram Bot for CyberMitra AI
//
// Instead of running a separate long-polling process (which dies
// on free-tier servers), this module exports a setupTelegramWebhook()
// function that plugs into the existing Express server in server.js.
//
// Telegram pushes updates to:  POST /telegram-webhook
// Your server is already live → bot is always live.  No separate
// process needed, no sleep/spin-down issues.
//
// HOW IT WORKS:
//   1. server.js calls setupTelegramWebhook(app) once on startup.
//   2. On first run, it calls Telegram's setWebhook API to point
//      Telegram at https://YOUR_DOMAIN/telegram-webhook.
//   3. Every message Telegram receives is HTTP-POSTed to that route.
//   4. We parse it here, call /analyse internally, reply to the user.
//
// REQUIRED ENV VARS (add to .env):
//   TELEGRAM_TOKEN=<your bot token from @BotFather>
//   WEBHOOK_URL=https://your-deployed-domain.com   ← NO trailing slash
//   WEBHOOK_SECRET=any_random_string_you_choose     ← optional but recommended
// ─────────────────────────────────────────────────────────

const axios = require('axios');

const TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://cybermitra.onrender.com
const SECRET = process.env.WEBHOOK_SECRET || '';

const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// ── Low-level Telegram API helpers ──────────────────────

async function callTelegram(method, body) {
  try {
    const res = await axios.post(`${TG_API}/${method}`, body, { timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error(`❌ Telegram API ${method} failed:`, e.response?.data || e.message);
    return null;
  }
}

async function sendMessage(chatId, html) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML'
  });
}

async function sendChatAction(chatId, action = 'typing') {
  return callTelegram('sendChatAction', { chat_id: chatId, action });
}

// ── Register the webhook with Telegram ──────────────────

async function registerWebhook() {
  if (!TOKEN) {
    console.error('❌ TELEGRAM_TOKEN missing — Telegram bot disabled.');
    return;
  }
  if (!WEBHOOK_URL) {
    console.error('❌ WEBHOOK_URL missing in .env — Telegram bot disabled.');
    console.error('   Add: WEBHOOK_URL=https://your-deployed-domain.com');
    return;
  }

  const webhookEndpoint = `${WEBHOOK_URL}/telegram-webhook`;
  const body = { url: webhookEndpoint };
  if (SECRET) body.secret_token = SECRET;

  const result = await callTelegram('setWebhook', body);
  if (result?.ok) {
    console.log(`🤖 Telegram webhook registered → ${webhookEndpoint}`);
  } else {
    console.error('❌ setWebhook failed:', result);
  }
}

// ── Handle one incoming update ──────────────────────────

async function handleUpdate(update, analyseEndpoint) {
  const msg = update.message || update.channel_post;
  if (!msg) return; // ignore non-message updates (inline queries, etc.)

  const chatId = msg.chat.id;
  const from = msg.from || {};

  // /start command
  if (msg.text === '/start') {
    await sendMessage(chatId,
      '✅ <b>CyberMitra AI is Active</b>\n\n' +
      '🔍 Send or forward any suspicious message, Instagram link, or Twitter/X link.\n\n' +
      '📊 Analysis will appear here <b>and</b> on your live dashboard.'
    );
    return;
  }

  // /status command
  if (msg.text === '/status') {
    await sendMessage(chatId, '✅ Bot is online and connected via webhook.');
    return;
  }

  // Extract text (normal or forwarded caption)
  let text = msg.text || msg.caption || '';
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
    text += '\n[FORWARDED MESSAGE]';
  }

  if (!text || text.trim().length < 10) {
    await sendMessage(chatId, '⚠️ Please send a longer message (at least 10 characters) for analysis.');
    return;
  }

  console.log(`\n📨 Telegram webhook from @${from.username || from.id}: "${text.substring(0, 80)}..."`);

  await sendChatAction(chatId, 'typing');

  try {
    // Call the /analyse endpoint directly (same process — no HTTP round-trip overhead)
    const analysis = await analyseEndpoint({
      text,
      _platform: 'Telegram Bot',
      _telegram_user: {
        id: from.id,
        username: from.username,
        first_name: from.first_name
      }
    });

    const riskEmoji = { High: '🔴', Medium: '🟡', Low: '🟢' }[analysis.risk_level] || '⚪';

    await sendMessage(chatId,
      `🚨 <b>CYBERMITRA ANALYSIS</b> 🚨\n\n` +
      `${riskEmoji} Risk Level: <b>${analysis.risk_level}</b>\n` +
      `🏷️ Type: <b>${analysis.fraud_type}</b>\n\n` +
      `💬 ${analysis.action_hindi}\n\n` +
      `<i>📊 This result is also visible on your live dashboard.</i>`
    );
  } catch (err) {
    console.error('❌ Analysis error in webhook handler:', err.message);
    await sendMessage(chatId, '⚠️ Something went wrong during analysis. Please try again.');
  }
}

// ── Main export: plug into Express ──────────────────────
//
// Call this once from server.js AFTER the /analyse route is defined:
//
//   const { setupTelegramWebhook } = require('./telegram');
//   setupTelegramWebhook(app, analyseLogic);
//
// analyseLogic is the async function that takes the same body as
// POST /analyse and returns the analysis object.

function setupTelegramWebhook(app, analyseLogic) {
  if (!TOKEN) {
    console.warn('⚠️  TELEGRAM_TOKEN not set — Telegram bot disabled.');
    return;
  }

  // The route Telegram will POST to
  app.post('/telegram-webhook', async (req, res) => {
    // Validate secret header if configured
    if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
      console.warn('⚠️  Webhook request with wrong secret — ignored.');
      return res.sendStatus(403);
    }

    // Always reply 200 immediately — Telegram will retry if we don't
    res.sendStatus(200);

    // Process the update asynchronously (don't block the 200 reply)
    try {
      await handleUpdate(req.body, analyseLogic);
    } catch (err) {
      console.error('❌ Unhandled webhook error:', err.message);
    }
  });

  // Register the webhook with Telegram on server startup
  registerWebhook();

  console.log('🤖 Telegram webhook handler mounted at POST /telegram-webhook');
}

module.exports = { setupTelegramWebhook };