require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');

// ✅ FIX 5: Validate token before even starting
if (!process.env.TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN is missing in .env file');
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY is missing — analyses will use fallback responses');
}

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

bot.command('start', (ctx) => {
  ctx.reply(
    '✅ <b>CyberMitra AI is Active</b>\n\n' +
    '🔍 Send or forward any suspicious message, Instagram link, or Twitter/X link.\n\n' +
    '📊 Analysis will appear here <b>and</b> on your live dashboard.',
    { parse_mode: 'HTML' }
  );
});

// ✅ FIX 6: status command so you can check if server is reachable from bot
bot.command('status', async (ctx) => {
  try {
    await axios.get(`${SERVER_URL}/events`, { timeout: 3000 });
    ctx.reply('✅ Server is online and reachable.');
  } catch {
    ctx.reply(`❌ Server unreachable at ${SERVER_URL}\nMake sure server.js is running.`);
  }
});

bot.on('message', async (ctx) => {
  try {
    // Extract text from normal message or forwarded caption
    let text = ctx.message.text || ctx.message.caption || '';

    // Handle forwarded messages — tag them so the AI knows
    if (ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_from_chat) {
      text += '\n[FORWARDED MESSAGE]';
    }

    if (!text || text.trim().length < 10) {
      return ctx.reply('⚠️ Please send a longer message (at least 10 characters) for analysis.');
    }

    console.log(`\n📨 Telegram message from @${ctx.from?.username || ctx.from?.id}: "${text.substring(0, 80)}..."`);

    // Show typing indicator while analyzing
    await ctx.sendChatAction('typing');

    const resp = await axios.post(
      `${SERVER_URL}/analyse`,
      {
        text,
        // Previously this request sent no _platform at all, so every real bot
        // message silently fell into the same "Manual" bucket as dashboard
        // test entries — indistinguishable in the feed/cache/analytics.
        // Tagging it "Telegram Bot" keeps live traffic separate.
        _platform: 'Telegram Bot',
        _telegram_user: {
          id: ctx.from?.id,
          username: ctx.from?.username,
          first_name: ctx.from?.first_name
        }
      },
      { timeout: 15000 }
    );

    const analysis = resp.data;

    // ✅ FIX 7: Emoji based on risk level for clearer Telegram replies
    const riskEmoji = {
      High: '🔴',
      Medium: '🟡',
      Low: '🟢'
    }[analysis.risk_level] || '⚪';

    const reply =
      `🚨 <b>CYBERMITRA ANALYSIS</b> 🚨\n\n` +
      `${riskEmoji} Risk Level: <b>${analysis.risk_level}</b>\n` +
      `🏷️ Type: <b>${analysis.fraud_type}</b>\n\n` +
      `💬 ${analysis.action_hindi}\n\n` +
      `<i>📊 This result is also visible on your live dashboard.</i>`;

    await ctx.reply(reply, { parse_mode: 'HTML' });

  } catch (error) {
    console.error('❌ Telegram handler error:', error.message);

    if (error.code === 'ECONNREFUSED') {
      await ctx.reply(
        '❌ <b>Server is not running.</b>\n\n' +
        'Start it first:\n<code>node server.js</code>\n\nThen try again.',
        { parse_mode: 'HTML' }
      );
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      await ctx.reply('⏱️ Analysis timed out. The server may be busy. Please try again in a moment.');
    } else {
      await ctx.reply('⚠️ Something went wrong. Please try again.');
    }
  }
});

// ✅ FIX 8: Graceful shutdown so bot stops cleanly on Ctrl+C
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch()
  .then(() => {
    console.log('🤖 Telegram Bot started successfully');
    console.log(`🔗 Server URL: ${SERVER_URL}`);
    console.log('💡 Send /start to your bot to test it\n');
  })
  .catch((err) => {
    console.error('❌ Bot failed to start:', err.message);
    if (err.message.includes('401')) {
      console.error('💡 Your TELEGRAM_TOKEN is invalid. Get a new one from @BotFather.');
    } else if (err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT')) {
      console.error('💡 Network issue. Check your internet / VPN / firewall.');
    }
    process.exit(1);
  });