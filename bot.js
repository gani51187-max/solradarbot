// ═══════════════════════════════════════════════════
// SOL RADAR — Telegram Sinyal Botu
// Premium/Free thread desteği + Üyelik yönetimi
// ═══════════════════════════════════════════════════

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '8969831057:AAHLcE0j3GRwUZ67ehoQg-1eMalOn_BpPEY';
const CHAT_ID        = process.env.CHAT_ID || '-1003779270396';
const PREMIUM_THREAD = parseInt(process.env.PREMIUM_THREAD_ID || '4');
const FREE_THREAD    = parseInt(process.env.FREE_THREAD_ID    || '20');
const ADMIN_ID       = process.env.ADMIN_ID || '';  // Senin Telegram kullanıcı ID'n
const FREE_DELAY_MS  = 8 * 60 * 1000;

const fs   = require('fs');
const http = require('http');

// ── Üye veritabanı (members.json) ──
const DB_FILE = './members.json';
function loadMembers() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
  catch { return {}; }
}
function saveMembers(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── FİLTRE AYARLARI ──
const FILTERS = {
  minLiquidity: 5000,
  minRugScore: 80,
  minHolders: 100,
  minChange5m: 20,
  maxAgeMin: 30,
  requirePositiveBuyRatio: true,
  maxTrapDanger: 40,
};

const seen = new Set();

// ── Telegram mesaj gönder ──
async function sendTelegram(chatId, threadId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (threadId) body.message_thread_id = threadId;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Admin'e özel mesaj
async function sendAdmin(text) {
  if (!ADMIN_ID) return;
  await sendTelegram(ADMIN_ID, null, text);
}

// ── Üyelik kontrol (her gün 00:00) ──
function checkMemberships() {
  const db = loadMembers();
  const now = Date.now();
  const messages = [];

  for (const [username, info] of Object.entries(db)) {
    const daysLeft = Math.ceil((info.expiresAt - now) / (1000 * 60 * 60 * 24));

    if (daysLeft <= 0) {
      messages.push(`❌ <b>Üyelik Bitti:</b> @${username}\nBitiş: ${new Date(info.expiresAt).toLocaleDateString('tr-TR')}`);
    } else if (daysLeft <= 3) {
      messages.push(`⚠️ <b>Üyelik Bitiyor:</b> @${username}\n<b>${daysLeft} gün</b> kaldı (${new Date(info.expiresAt).toLocaleDateString('tr-TR')})`);
    }
  }

  if (messages.length > 0) {
    sendAdmin('📋 <b>Günlük Üyelik Raporu</b>\n\n' + messages.join('\n\n'));
  }
}

// Her gün 00:00'da çalıştır
function scheduleDailyCheck() {
  const now = new Date();
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  const msUntilMidnight = next - now;
  setTimeout(() => {
    checkMemberships();
    setInterval(checkMemberships, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// ── Komut işle ──
async function handleCommand(msg) {
  const text    = msg.text || '';
  const fromId  = String(msg.from?.id);
  const isAdmin = !ADMIN_ID || fromId === String(ADMIN_ID);

  if (!isAdmin) return;

  // /addpremium @kullanıcı 30
  if (text.startsWith('/addpremium')) {
    const parts = text.split(' ');
    const username = (parts[1] || '').replace('@', '');
    const days     = parseInt(parts[2]) || 30;
    if (!username) {
      await sendAdmin('⚠️ Kullanım: /addpremium @kullanıcı 30');
      return;
    }
    const db = loadMembers();
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    db[username] = { expiresAt, addedAt: Date.now(), days };
    saveMembers(db);
    await sendAdmin(`✅ <b>@${username}</b> eklendi\nSüre: <b>${days} gün</b>\nBitiş: <b>${new Date(expiresAt).toLocaleDateString('tr-TR')}</b>`);
    return;
  }

  // /removepremium @kullanıcı
  if (text.startsWith('/removepremium')) {
    const username = (text.split(' ')[1] || '').replace('@', '');
    if (!username) {
      await sendAdmin('⚠️ Kullanım: /removepremium @kullanıcı');
      return;
    }
    const db = loadMembers();
    if (db[username]) {
      delete db[username];
      saveMembers(db);
      await sendAdmin(`🗑 <b>@${username}</b> silindi`);
    } else {
      await sendAdmin(`⚠️ @${username} bulunamadı`);
    }
    return;
  }

  // /listpremium
  if (text.startsWith('/listpremium')) {
    const db = loadMembers();
    const entries = Object.entries(db);
    if (!entries.length) {
      await sendAdmin('📋 Kayıtlı premium üye yok.');
      return;
    }
    const now = Date.now();
    const list = entries.map(([u, info]) => {
      const daysLeft = Math.ceil((info.expiresAt - now) / (1000 * 60 * 60 * 24));
      const status = daysLeft <= 0 ? '❌ Bitti' : daysLeft <= 3 ? `⚠️ ${daysLeft}g kaldı` : `✅ ${daysLeft}g kaldı`;
      return `• @${u} — ${status} (${new Date(info.expiresAt).toLocaleDateString('tr-TR')})`;
    }).join('\n');
    await sendAdmin(`📋 <b>Premium Üyeler (${entries.length})</b>\n\n${list}`);
    return;
  }

  // /checkpremium
  if (text.startsWith('/checkpremium')) {
    checkMemberships();
    await sendAdmin('🔍 Üyelik kontrolü yapıldı.');
    return;
  }

  // /help
  if (text.startsWith('/help')) {
    await sendAdmin(`📖 <b>Komutlar</b>

/addpremium @kullanıcı 30 — Üye ekle (gün sayısı)
/removepremium @kullanıcı — Üye sil
/listpremium — Tüm üyeleri listele
/checkpremium — Anında üyelik kontrolü yap
/help — Bu mesaj`);
  }
}

// ── Telegram güncellemelerini dinle (polling) ──
let lastUpdateId = 0;
async function pollUpdates() {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    if (!r.ok) return;
    const data = await r.json();
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      if (update.message?.text?.startsWith('/')) {
        await handleCommand(update.message);
      }
    }
  } catch {}
  setTimeout(pollUpdates, 2000);
}

// ── RugCheck skoru ──
async function getRugScore(addr) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${addr}/report/summary`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.score !== undefined) return Math.max(0, Math.min(100, Math.round(d.score)));
    if (d.risks) {
      const danger = d.risks.filter(x => x.level === 'danger' || x.level === 'error').length;
      const warn   = d.risks.filter(x => x.level === 'warn'   || x.level === 'warning').length;
      return Math.max(0, 100 - danger * 25 - warn * 10);
    }
    return 50;
  } catch { return null; }
}

// ── Tuzak skoru ──
function calcTrapScore(p) {
  let score = 100;
  const m5    = p?.priceChange?.m5 ?? 0, h1 = p?.priceChange?.h1 ?? 0;
  const vol5  = p?.volume?.m5 ?? 0,      vol1 = p?.volume?.h1 ?? 0;
  const buys5 = p?.txns?.m5?.buys ?? 0,  sells5 = p?.txns?.m5?.sells ?? 0;
  const liq   = p?.liquidity?.usd ?? 0;
  if (m5 > 25 && h1 < 5)                     score -= 30;
  if (m5 > 15 && h1 < -10)                   score -= 30;
  const avg = vol1 / 12;
  if (m5 > 0 && avg > 0 && vol5 < avg * 0.5) score -= 15;
  if (m5 > 10 && sells5 > buys5 * 1.3)       score -= 15;
  if (Math.abs(m5) > 30 && liq > 0 && liq < 30000) score -= 30;
  return Math.max(0, Math.min(100, score));
}

const fmt = n => {
  if (!n && n !== 0) return '—';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};

function formatMessage(t) {
  const boostLine = t.boost > 0 ? `\n🚀 <b>DexScreener Boosted</b> (x${t.boost})` : '';
  return `🎯 <b>RADAR SIGNAL — $${t.symbol}</b>${boostLine}

🛡 Safety: <b>${t.rugScore}/100</b>
🎯 Trap score: <b>${t.trapScore}/100</b> ${t.trapScore >= 70 ? '✅' : '⚠️'}
💧 Liquidity: <b>${fmt(t.liquidity)}</b>
📈 5min: <b>+${t.change5m.toFixed(1)}%</b>
⏱ Age: <b>${t.ageMin}min</b>

<code>${t.address}</code>

⚡ <a href="https://jup.ag/swap/SOL-${t.address}?referrer=ACmAkQLb71nqH4TcbKC6CEHJJz2qPvUAGXJjP8zahfTy&feeBps=30">Buy on Jupiter</a> | 📊 <a href="https://dexscreener.com/solana/${t.address}">Chart</a>

<i>⚠ Not financial advice. DYOR.</i>`;
}

// ── Boost'lu tokenleri çek (bonus sinyal) ──
async function getBoostedSet() {
  const boosted = {};
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if (r.ok) {
      const data = await r.json();
      (Array.isArray(data) ? data : data.data || []).forEach(b => {
        if (b.chainId === 'solana' && b.tokenAddress) {
          boosted[b.tokenAddress] = b.totalAmount || b.amount || 1;
        }
      });
    }
  } catch {}
  return boosted;
}

// ── Ana tarama döngüsü ──
async function scanAndPost() {
  try {
    const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    if (!r.ok) return;
    const data = await r.json();
    const solTokens = data.filter(t => t.chainId === 'solana').slice(0, 30);

    // Boost'lu tokenler (bonus rozet için)
    const boostedSet = await getBoostedSet();

    const addrs = solTokens.map(t => t.tokenAddress).filter(Boolean);
    const pairMap = {};
    for (const chunk of [addrs.slice(0, 15), addrs.slice(15, 30)]) {
      if (!chunk.length) continue;
      try {
        const pr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
        if (pr.ok) {
          const pd = await pr.json();
          (pd.pairs || []).forEach(p => {
            const a = p.baseToken?.address;
            if (!a) return;
            if (!pairMap[a] || (pairMap[a].liquidity?.usd || 0) < (p.liquidity?.usd || 0)) pairMap[a] = p;
          });
        }
      } catch {}
    }

    for (const tk of solTokens) {
      const addr = tk.tokenAddress;
      if (!addr || seen.has(addr)) continue;
      const p = pairMap[addr];
      if (!p) continue;

      const liq       = p.liquidity?.usd || 0;
      const m5        = p.priceChange?.m5 || 0;
      const buys      = p.txns?.m5?.buys || 0;
      const sells     = p.txns?.m5?.sells || 0;
      const created   = p.pairCreatedAt;
      const ageMin    = created ? Math.floor((Date.now() - created) / 60000) : 999;
      const trapScore = calcTrapScore(p);

      if (liq < FILTERS.minLiquidity) continue;
      if (m5 < FILTERS.minChange5m) continue;
      if (ageMin > FILTERS.maxAgeMin) continue;
      if (FILTERS.requirePositiveBuyRatio && buys <= sells) continue;
      if (trapScore < FILTERS.maxTrapDanger) continue;

      const rugScore = await getRugScore(addr);
      if (rugScore !== null && rugScore < FILTERS.minRugScore) continue;

      seen.add(addr);
      const token = {
        address: addr,
        symbol: tk.header || p.baseToken?.symbol || '???',
        liquidity: liq, change5m: m5, ageMin, trapScore,
        rugScore: rugScore ?? '?',
        boost: boostedSet[addr] || 0
      };
      const msg = formatMessage(token);

      // Premium: anında
      await sendTelegram(CHAT_ID, PREMIUM_THREAD, '⭐ <b>[PREMIUM — INSTANT]</b>\n\n' + msg);
      console.log(`✅ Premium: $${token.symbol}`);

      // Free: 8 dk gecikmeli
      setTimeout(async () => {
        await sendTelegram(CHAT_ID, FREE_THREAD, msg + '\n\n💎 <i>Premium members saw this 8 minutes ago.</i>');
        console.log(`✅ Free (gecikmeli): $${token.symbol}`);
      }, FREE_DELAY_MS);
    }

    if (seen.size > 500) seen.clear();
  } catch (e) {
    console.error('Tarama hatası:', e.message);
  }
}

// ── Başlat ──
console.log('🚀 SOL RADAR bot başlatıldı');
console.log(`Chat: ${CHAT_ID} | Premium: ${PREMIUM_THREAD} | Free: ${FREE_THREAD}`);

pollUpdates();
scheduleDailyCheck();
scanAndPost();
setInterval(scanAndPost, 60 * 1000);

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('SOL RADAR running ✓');
}).listen(process.env.PORT || 3000);
