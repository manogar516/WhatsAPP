const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');
const puppeteer = require('puppeteer');

// Phone number for pairing code authentication (Country code + Number, no + sign)
const PHONE_NUMBER = '919585970086';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JDiIPdvDtcig_mAYvHEx5n6Wj64MW6DuqXQvLRtmXJGA' });

const BOT_NAME = 'Anononymous_friend';

const ALLOWED = new Set([
  '919791810520@c.us',
  '919585974726@c.us',
  '94704330895538@lid',
]);

// Updated models to fix the 404 API error
const MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-flash-latest',
];
const RETRIES_PER_MODEL = 2;

const TRIGGER = /^\/agal\s+/i;
const COOLDOWN_MS = 5000;
const EDIT_INTERVAL_MS = 1500;
const INACTIVITY_MS = 10 * 60 * 1000;
const GIF_DIR = path.join(__dirname, 'gifs');

const GREETINGS = [
  'Hai Agalya 👋 ',
  'Vanakkam 🙏',
  'Hai Hello',
  'Hai 👋',
  'Hello 😄',
];

// Updated system prompt: Prioritizes Tamil & Tanglish over Hindi
const SYSTEM_PROMPT =
  'Your name is Anononymous_frriend. You are a funny, playful friend chatting on WhatsApp. ' +
  'Your main goal is to make people laugh with jokes, light roasts, puns and witty comebacks, ' +
  'but whenever someone asks a real question, you ALWAYS give a correct, helpful answer first, ' +
  'then add a bit of humor on top. Never dodge a question just to joke. ' +
  'Keep the roasts friendly, never hurtful, and never about sensitive things. ' +
  'LANGUAGE RULE: Start the conversation in clear English. ' +
  'Thereafter, ALWAYS dynamically mirror and reply in the EXACT language/dialect the user writes in ' +
  '(e.g., reply in Tanglish if they use Tanglish, English if they use English, pure Tamil if they use Tamil script, etc.). ' +
  'Never default or force Tanglish if the user is typing in standard English. ' +
  'Keep replies short and easy to read on a phone (under 100 words) with a few emojis. ' +
  'If someone sincerely asks whether you are an AI, admit it honestly, with a joke.';
const lastReply = {};
const lastActivity = {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function randomGifPath() {
  try {
    const files = fs.readdirSync(GIF_DIR).filter(f => /\.(webp|gif|mp4|webm)$/i.test(f));
    if (!files.length) return null;
    return path.join(GIF_DIR, pick(files));
  } catch {
    return null;
  }
}

async function sendGreetingGif(chatId) {
  const greetingText = `${pick(GREETINGS)}`;
  const file = randomGifPath();

  if (!file) {
    console.log('No GIFs found in', GIF_DIR, '- sending text only');
    await client.sendMessage(chatId, greetingText).catch(() => {});
    return;
  }

  try {
    const media = MessageMedia.fromFilePath(file);
    const ext = path.extname(file).toLowerCase();

    // MP4/GIF files support text captions in a SINGLE message
    if (ext === '.mp4' || ext === '.webm' || ext === '.gif') {
      await client.sendMessage(chatId, media, {
        sendVideoAsGif: true,
        caption: greetingText,
      });
      console.log('Sent video GIF with caption in 1 message:', path.basename(file));
    } else {
      // .webp stickers cannot carry captions on WhatsApp
      await client.sendMessage(chatId, media, {
        sendMediaAsSticker: true,
        stickerAuthor: BOT_NAME,
        stickerName: 'Vanakkam',
      });
      console.log('Sent .webp sticker (convert to .mp4/.gif for single message with text):', path.basename(file));
      await sleep(300);
      await client.sendMessage(chatId, greetingText).catch(() => {});
    }
  } catch (err) {
    console.error('Media send failed:', err.message ? err.message.split('\n')[0] : err);
    await client.sendMessage(chatId, greetingText).catch(() => {});
  }
}

async function startStream(question) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
      try {
        const stream = await ai.models.generateContentStream({
          model,
          contents: question,
          config: { systemInstruction: SYSTEM_PROMPT },
        });
        console.log(`Using model: ${model}`);
        return stream;
      } catch (err) {
        lastErr = err;
        console.log(`[${model}] attempt ${attempt} failed (${err.status})`);
        if (![429, 500, 503].includes(err.status)) break;
        await sleep(800 * attempt);
      }
    }
  }
  throw lastErr;
}

console.log('Starting bot...');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

// Phone number pairing code authentication with DOM load delay
let pairingCodeRequested = false;

client.on('qr', async () => {
  if (pairingCodeRequested) return;
  pairingCodeRequested = true;

  setTimeout(async () => {
    try {
      const code = await client.requestPairingCode(PHONE_NUMBER);
      console.log('\n==================================================');
      console.log(`🔑 YOUR WHATSAPP PAIRING CODE: ${code}`);
      console.log('==================================================\n');
    } catch (err) {
      console.error('Failed to generate pairing code:', err.message || err);
      pairingCodeRequested = false;
    }
  }, 3000);
});

client.on('authenticated', () => console.log('Authenticated 🔐'));
client.on('auth_failure', m => console.log('Auth failure:', m));
client.on('ready', () => console.log('Bot ready ✅'));
client.on('disconnected', r => console.log('Disconnected:', r));

client.on('message_create', async msg => {
  try {
    const text = (msg.body || '').trim();
    if (!TRIGGER.test(text)) return;

    const chatId = msg.fromMe ? msg.to : msg.from;
    console.log('Trigger seen. Chat ID:', chatId);

    if (chatId.endsWith('@g.us')) return;
    if (!ALLOWED.has(chatId)) {
      console.log('Blocked: add this ID to ALLOWED ->', chatId);
      return;
    }

    const now = Date.now();
    if (now - (lastReply[chatId] || 0) < COOLDOWN_MS) return;
    lastReply[chatId] = now;

    const idle = now - (lastActivity[chatId] || 0) > INACTIVITY_MS;
    lastActivity[chatId] = now;
    if (idle) await sendGreetingGif(chatId);

    const question = text.replace(TRIGGER, '');
    const label = `*${BOT_NAME}:* `;

    try {
      const stream = await startStream(question);

      let full = '';
      for await (const chunk of stream) {
        full += chunk.text || '';
      }

      const finalText = label + (full.trim() || '...');
      await client.sendMessage(chatId, finalText);
    } catch (err) {
      console.error('REPLY ERROR:', err.status || '', err.message?.slice(0, 200));
      const errText = label + 'AI is busy right now, try again in a minute 😴';
      await client.sendMessage(chatId, errText).catch(() => {});
    }

    lastActivity[chatId] = Date.now();
  } catch (err) {
    console.error('HANDLER ERROR:', err);
  }
});

process.on('unhandledRejection', e => console.error('Unhandled:', e));

client.initialize().catch(err => console.error('INIT ERROR:', err));

// HTTP server to satisfy Render Web Service port check
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WhatsApp Bot is live! 🚀\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Port binding server running on port ${PORT}`);
});
