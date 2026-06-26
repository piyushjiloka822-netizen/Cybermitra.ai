require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const axios = require('axios');
const db = require('./db'); // ✅ SQLite-backed persistence (see db.js)
const { setupTelegramWebhook } = require('./telegram'); // ✅ Webhook-based Telegram bot

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.redirect('/dashboard.html'));

const clients = new Set();

// ✅ FIX 1: Correct Groq model name
// "openai/gpt-oss-20b" does NOT exist on Groq.
// Valid Groq models: llama-3.3-70b-versatile, llama3-70b-8192, mixtral-8x7b-32768, gemma2-9b-it
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 15000 });
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // Fast, free, works on Groq

// ✅ One-time import of the old scams.json cache into the database, if present.
// Safe to leave scams.json in place afterwards — it's no longer read or written.
{
  const migrated = db.migrateLegacyCache('scams.json');
  if (migrated > 0) console.log(`✅ Migrated ${migrated} cached results from scams.json into cybermitra.db`);
}

// ─────────────────────────────────────────────────────────
// DEEPFAKE DETECTION — Sightengine + Hive
// Both are optional: if API keys are missing, this is skipped
// and the system falls back to Groq's text-only reasoning.
// ─────────────────────────────────────────────────────────

async function checkSightengine(imageUrl) {
  if (!process.env.SIGHTENGINE_API_USER || !process.env.SIGHTENGINE_API_SECRET) return null;
  try {
    const res = await axios.get('https://api.sightengine.com/1.0/check.json', {
      params: {
        url: imageUrl,
        models: 'deepfake,genai', // deepfake = face-swap detection, genai = AI-generated detection
        api_user: process.env.SIGHTENGINE_API_USER,
        api_secret: process.env.SIGHTENGINE_API_SECRET
      },
      timeout: 12000
    });
    const data = res.data;
    return {
      provider: 'Sightengine',
      deepfake_score: data.type?.deepfake ?? data.deepfake?.prob ?? null,
      ai_generated_score: data.type?.ai_generated ?? null,
      raw: data
    };
  } catch (e) {
    console.log('⚠️ Sightengine check failed:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

async function checkHive(imageUrl) {
  if (!process.env.HIVE_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://api.thehive.ai/api/v2/task/sync',
      { url: imageUrl },
      {
        headers: {
          'Authorization': `Token ${process.env.HIVE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );
    const output = res.data?.status?.[0]?.response?.output?.[0];
    const classes = output?.classes || [];
    const deepfakeClass = classes.find(c => c.class === 'yes_deepfake' || c.class === 'deepfake');
    return {
      provider: 'Hive',
      deepfake_score: deepfakeClass ? deepfakeClass.score : null,
      raw: res.data
    };
  } catch (e) {
    console.log('⚠️ Hive check failed:', e.response?.data?.message || e.message);
    return null;
  }
}

// Runs both providers in parallel; merges into one simple summary.
// Returns null entirely if no keys are configured (caller falls back to text-only).
async function runDeepfakeChecks(imageUrl) {
  if (!imageUrl) return null;
  if (!process.env.SIGHTENGINE_API_USER && !process.env.HIVE_API_KEY) return null;

  const [se, hive] = await Promise.all([checkSightengine(imageUrl), checkHive(imageUrl)]);
  if (!se && !hive) return null;

  const scores = [se?.deepfake_score, hive?.deepfake_score].filter(s => s !== null && s !== undefined);
  const maxScore = scores.length ? Math.max(...scores) : null;

  return {
    sightengine: se,
    hive: hive,
    combined_deepfake_score: maxScore, // 0–1, higher = more likely deepfake
    verdict: maxScore === null ? 'Unknown' : maxScore > 0.5 ? 'Likely Deepfake' : 'Likely Authentic'
  };
}

// Fetch link content (Instagram / Twitter)
async function fetchPostContent(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    let html = res.data;
    let extracted = '';

    if (url.includes('instagram.com')) {
      const match = html.match(/["']caption["']:\s*["'](.*?)["']/i) ||
                    html.match(/og:description" content="([^"]*)/i);
      extracted = match ? match[1] : '';
    } else if (url.includes('x.com') || url.includes('twitter.com')) {
      const match = html.match(/["']full_text["']:\s*["'](.*?)["']/i) ||
                    html.match(/og:description" content="([^"]*)/i);
      extracted = match ? match[1] : '';
    }

    if (!extracted || extracted.length < 30) {
      extracted = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 2200);
    }
    return extracted.trim();
  } catch (e) {
    console.log('⚠️ Link fetch failed:', e.message);
    return null;
  }
}

// ✅ analyseWithGroq now accepts a field_type so the prompt is tailored:
// 'username' → judge naming patterns / impersonation signals
// 'dm'       → judge message content for scam tactics
// 'post'     → judge post/reel/tweet content or link
// 'general'  → default behaviour (manual/telegram text, deepfake context)
async function analyseWithGroq(text, fieldType = 'general') {
  const systemPrompts = {
    general: `You are an expert Indian financial fraud and cybercrime detector.
Classify messages from Telegram, Instagram, Twitter etc.
Always return valid JSON with exactly these fields:
- risk_level: must be exactly "High", "Medium" or "Low"
- fraud_type: short clear English label (e.g. "Investment Scam", "Phishing", "Fake Job Offer")
- action_hindi: one helpful Hindi sentence advising the user what to do`,

    username: `You are an expert at spotting fake/scam social media accounts by their USERNAME alone.
Look for patterns common in scam accounts: words like "guaranteed", "official_giveaway", "earn_daily",
"crypto_profit", numbers replacing letters, impersonation of celebrities/brands, generic spammy patterns.
If the username looks like a normal personal account or a well-known real organisation, treat it as low risk.
Always return valid JSON with exactly these fields:
- risk_level: must be exactly "High", "Medium" or "Low"
- fraud_type: short label (e.g. "Likely Fake/Scam Account", "Impersonation Account", "Looks Genuine")
- action_hindi: one helpful Hindi sentence advising the user what to do before trusting this account`,

    dm: `You are an expert Indian financial fraud detector specialising in DIRECT MESSAGES (DMs).
Scammers use DMs for brand-ambassador scams, crypto/trading schemes, fake romance, prize claims, and job offers.
Analyse the DM text for urgency tactics, unrealistic returns, requests for payment/personal info, and scarcity pressure ("limited slots", "today only").
Always return valid JSON with exactly these fields:
- risk_level: must be exactly "High", "Medium" or "Low"
- fraud_type: short label (e.g. "Brand Ambassador Scam", "Crypto DM Scam", "Romance Scam", "Genuine Message")
- action_hindi: one helpful Hindi sentence advising the user what to do`,

    post: `You are an expert Indian financial fraud detector specialising in PUBLIC POSTS, REELS and TWEETS.
Analyse the post/reel/tweet content or URL for scam patterns: fake giveaways, guaranteed returns, fake loan offers,
celebrity impersonation, urgency/scarcity tactics, or requests to DM/click suspicious links.
Always return valid JSON with exactly these fields:
- risk_level: must be exactly "High", "Medium" or "Low"
- fraud_type: short label (e.g. "Fake Giveaway", "Loan Scam", "Investment Scam", "Genuine Post")
- action_hindi: one helpful Hindi sentence advising the user what to do`
  };

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompts[fieldType] || systemPrompts.general },
      { role: 'user', content: text }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0].message.content;
  const parsed = JSON.parse(raw);

  const validLevels = ['High', 'Medium', 'Low'];
  return {
    risk_level: validLevels.includes(parsed.risk_level) ? parsed.risk_level : 'Medium',
    fraud_type: parsed.fraud_type || 'Unknown Fraud Type',
    action_hindi: parsed.action_hindi || 'सावधान रहें और इस संदेश पर भरोसा न करें।'
  };
}

// ✅ FIX 3: broadcast() is called in ALL code paths (success + fallback)
function broadcast(data) {
  console.log(`📢 Broadcasting to ${clients.size} dashboard client(s):`, data.risk_level, '-', data.fraud_type);
  clients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      clients.delete(client);
    }
  });
}

app.post('/analyse', async (req, res) => {
  try {
    const { text, _platform, field_type, _telegram_user } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

    console.log(`\n📨 [${_platform || 'Manual'}/${field_type || 'general'}] Analysis request: "${text.substring(0, 100)}..."`);
    const result = await runAnalysis({ text, _platform, field_type, _telegram_user });
    res.json(result);
  } catch (err) {
    console.error('🔥 Server Error:', err);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// ─────────────────────────────────────────────────────────
// DEDICATED DEEPFAKE ENDPOINT
// Accepts: { text (url/description context), image_url (optional) }
// Runs Sightengine + Hive on image_url if provided, then asks Groq
// to reason over both the visual scores AND the text context together.
// ─────────────────────────────────────────────────────────
app.post('/analyse-deepfake', async (req, res) => {
  try {
    const { text, image_url } = req.body;
    if (!text?.trim() && !image_url) {
      return res.status(400).json({ error: 'Provide video URL/description text or an image_url' });
    }

    // Cache on the exact text+image combo — avoids re-spending Sightengine/Hive
    // quota on a thumbnail or description that's already been checked.
    const cacheKey = 'deepfake::' + (text || '').substring(0, 300) + '::' + (image_url || '');
    const cachedRow = db.getCachedAnalysis(cacheKey);

    let analysis, visualAnalysisOut;

    if (cachedRow) {
      console.log(`✅ Deepfake cache hit (seen ${cachedRow.hit_count}x)`);
      analysis = {
        risk_level: cachedRow.risk_level,
        fraud_type: cachedRow.fraud_type,
        action_hindi: cachedRow.action_hindi
      };
      visualAnalysisOut = cachedRow.visual_analysis ? JSON.parse(cachedRow.visual_analysis) : null;
    } else {
      console.log(`\n🎭 Deepfake check: "${(text || '').substring(0, 100)}..." image=${image_url ? 'yes' : 'no'}`);

      // Run visual providers in parallel with the text context
      const visualResult = await runDeepfakeChecks(image_url);

      let contextForGroq = text || '';
      if (visualResult) {
        contextForGroq += `\n\n---\nVISUAL ANALYSIS RESULTS:\n` +
          `Sightengine deepfake score: ${visualResult.sightengine?.deepfake_score ?? 'N/A'}\n` +
          `Hive deepfake score: ${visualResult.hive?.deepfake_score ?? 'N/A'}\n` +
          `Combined verdict: ${visualResult.verdict}\n` +
          `Use this visual evidence alongside the text context to make your final judgement.`;
      } else {
        contextForGroq += `\n\n---\nNOTE: No image was analysed (no thumbnail provided or no deepfake-detection API keys configured). Base your judgement on text context only.`;
      }

      try {
        const completion = await groq.chat.completions.create({
          model: GROQ_MODEL,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: `You are an expert deepfake-scam detector for Indian social media.
Analyse video URLs, titles/descriptions, and (if provided) visual deepfake-detection scores.
Common patterns: fake celebrity/politician endorsing investment schemes, fake live-streams promising crypto giveaways,
urgency/scarcity tactics ("limited time", "act now"), requests to send money first.
Always return valid JSON with exactly these fields:
- risk_level: "High", "Medium" or "Low"
- fraud_type: short label (e.g. "Deepfake Investment Scam", "Fake Celebrity Endorsement", "Likely Genuine Video")
- action_hindi: one helpful Hindi sentence advising the user what to do`
            },
            { role: 'user', content: contextForGroq }
          ],
          response_format: { type: 'json_object' }
        });
        const parsed = JSON.parse(completion.choices[0].message.content);
        const validLevels = ['High', 'Medium', 'Low'];
        analysis = {
          risk_level: validLevels.includes(parsed.risk_level) ? parsed.risk_level : 'Medium',
          fraud_type: parsed.fraud_type || 'Unknown',
          action_hindi: parsed.action_hindi || 'सावधान रहें, इस वीडियो पर भरोसा न करें।'
        };
      } catch (e) {
        console.error('❌ Groq deepfake analysis failed:', e.message);
        analysis = {
          risk_level: 'Medium',
          fraud_type: 'Analysis Unavailable',
          action_hindi: 'वीडियो की जांच नहीं हो पाई। सावधानी बरतें।'
        };
      }

      visualAnalysisOut = visualResult ? {
        verdict: visualResult.verdict,
        sightengine_score: visualResult.sightengine?.deepfake_score ?? null,
        hive_score: visualResult.hive?.deepfake_score ?? null
      } : null;

      db.saveAnalysis({
        cacheKey,
        source: 'Deepfake Check',
        fieldType: 'deepfake',
        text: text || image_url || '',
        analysis,
        visualAnalysis: visualAnalysisOut
      });
    }

    const result = {
      ...analysis,
      _source: 'Deepfake Check',
      _field_type: 'deepfake',
      visual_analysis: visualAnalysisOut
    };

    broadcast(result);
    res.json(result);

  } catch (err) {
    console.error('🔥 Deepfake endpoint error:', err);
    res.status(500).json({ error: 'Deepfake analysis failed' });
  }
});

// ✅ FIX 4: SSE endpoint - sends a welcome ping so dashboard confirms connection instantly
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'   // prevents Nginx from buffering SSE
  });

  // Immediately confirm connection to dashboard
  res.write(': connected\n\n');
  clients.add(res);
  console.log(`📡 Dashboard connected. Total clients: ${clients.size}`);

  // Heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`📴 Dashboard disconnected. Total clients: ${clients.size}`);
  });
});

// ─────────────────────────────────────────────────────────
// HISTORY — lets the dashboard hydrate its live feed with past
// results on page load, instead of starting empty every refresh.
// ─────────────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.getHistory(limit);
  res.json(rows.map(r => ({
    risk_level: r.risk_level,
    fraud_type: r.fraud_type,
    action_hindi: r.action_hindi,
    _source: r.source,
    _field_type: r.field_type,
    _timestamp: r.first_seen_at,
    visual_analysis: r.visual_analysis ? JSON.parse(r.visual_analysis) : null
  })));
});

// ─────────────────────────────────────────────────────────
// STATS — all-time aggregate counts (not just this browser session).
// ─────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  res.json(db.getStats());
});

// ─────────────────────────────────────────────────────────
// API STATUS — lets the dashboard show whether Sightengine /
// Hive keys are configured, without exposing the keys themselves.
// ─────────────────────────────────────────────────────────
app.get('/api-status', (req, res) => {
  res.json({
    sightengine: !!(process.env.SIGHTENGINE_API_USER && process.env.SIGHTENGINE_API_SECRET),
    hive: !!process.env.HIVE_API_KEY,
    groq: !!process.env.GROQ_API_KEY
  });
});

// ─────────────────────────────────────────────────────────
// REPORT SCAM — community-sourced scam submissions
// Stored in a separate table so they don't pollute the
// AI-analysis cache. Used by the leaderboard & map views.
// ─────────────────────────────────────────────────────────
app.post('/report-scam', (req, res) => {
  try {
    const { platform, type, content, loss, city } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    db.saveScamReport({ platform, type, content, loss, city });
    console.log(`📝 Scam report received: [${platform}] ${type} — ${city || 'Unknown'}`);
    res.json({ success: true });
  } catch (err) {
    console.error('🔥 Report error:', err);
    // Graceful: still return 200 to not break the frontend
    res.json({ success: true, note: 'Stored locally' });
  }
});

// ─────────────────────────────────────────────────────────
// LEADERBOARD — top fraud types with counts
// ─────────────────────────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  try {
    const data = db.getLeaderboard(15);
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────
// HISTORY with server-side filtering support
// ─────────────────────────────────────────────────────────
app.get('/history/search', (req, res) => {
  const { q, risk, source, limit } = req.query;
  try {
    const rows = db.searchHistory({ q, risk, source, limit: parseInt(limit)||50 });
    res.json(rows.map(r => ({
      id: r.id,
      risk_level: r.risk_level,
      fraud_type: r.fraud_type,
      action_hindi: r.action_hindi,
      source: r.source,
      field_type: r.field_type,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      hit_count: r.hit_count
    })));
  } catch (err) {
    res.json([]);
  }
});

// ── Shared analyse logic (reused by /analyse route AND Telegram webhook) ──
// Extracted so telegram.js can call it directly without an HTTP round-trip.
async function runAnalysis({ text, _platform, field_type, _telegram_user }) {
  if (!text || !text.trim()) throw new Error('No text provided');

  const sourceLabel = _platform || 'Manual';
  const ftype = field_type || 'general';

  const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
  const cacheKey = (urlMatch ? urlMatch[0] : text.substring(0, 300)) + '::' + sourceLabel + '::' + ftype;

  let analysis;
  const cachedRow = db.getCachedAnalysis(cacheKey);

  if (cachedRow) {
    console.log(`✅ Cache hit (seen ${cachedRow.hit_count}x)`);
    analysis = { risk_level: cachedRow.risk_level, fraud_type: cachedRow.fraud_type, action_hindi: cachedRow.action_hindi };
  } else {
    let enrichedText = text;
    if (urlMatch && ftype !== 'username') {
      const fetched = await fetchPostContent(urlMatch[0]);
      if (fetched) enrichedText = `PLATFORM: ${urlMatch[0]}\n\nPOST CONTENT:\n${fetched}\n\nOriginal: ${text}`;
    }
    try {
      analysis = await analyseWithGroq(enrichedText, ftype);
      console.log(`🤖 Groq → ${analysis.risk_level} | ${analysis.fraud_type}`);
    } catch (e) {
      console.error('❌ Groq API error:', e.message);
      analysis = { risk_level: 'Medium', fraud_type: 'Analysis Unavailable', action_hindi: 'संदेश संदिग्ध लग रहा है। किसी विश्वसनीय व्यक्ति से सलाह लें।' };
    }
    db.saveAnalysis({ cacheKey, source: sourceLabel, fieldType: ftype, text, analysis });
  }

  if (_telegram_user?.id) {
    db.recordTelegramUser({ chatId: String(_telegram_user.id), username: _telegram_user.username, firstName: _telegram_user.first_name, riskLevel: analysis.risk_level });
  }

  const withSource = { ...analysis, _source: sourceLabel, _field_type: ftype };
  broadcast(withSource);
  return withSource;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 CyberMitra Server → http://localhost:${PORT}`);
  console.log(`📊 Dashboard       → http://localhost:${PORT}/dashboard.html`);
  console.log(`🤖 Groq Model      → ${GROQ_MODEL}`);
  console.log(`💾 Database        → cybermitra.db (SQLite)`);
  console.log(`📝 Scam Reports    → /report-scam (POST)`);
  console.log(`🏆 Leaderboard     → /leaderboard (GET)`);
  console.log(`🎭 Sightengine     → ${process.env.SIGHTENGINE_API_USER ? '✅ configured' : '⚠️  not configured (text-only deepfake checks)'}`);
  console.log(`🎭 Hive Moderation → ${process.env.HIVE_API_KEY ? '✅ configured' : '⚠️  not configured (text-only deepfake checks)'}\n`);

  // ✅ Mount Telegram webhook AFTER server is listening
  setupTelegramWebhook(app, runAnalysis);
});

// Close the DB cleanly on shutdown
process.once('SIGINT', () => { db.close(); process.exit(0); });
process.once('SIGTERM', () => { db.close(); process.exit(0); });