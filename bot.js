// ═══════════════════════════════════════════════════
// SOL RADAR — Telegram Signal Bot
// ═══════════════════════════════════════════════════

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '8969831057:AAHLcE0j3GRwUZ67ehoQg-1eMalOn_BpPEY';
const PREMIUM_CHAT   = process.env.PREMIUM_CHAT || '-1003914359932';
const PREMIUM_THREAD = process.env.PREMIUM_THREAD_ID ? parseInt(process.env.PREMIUM_THREAD_ID) : null;
const FREE_CHAT      = process.env.FREE_CHAT || '-1003779270396';
const FREE_THREAD    = parseInt(process.env.FREE_THREAD_ID || '20');
const WATCH_CHAT     = process.env.WATCH_CHAT || PREMIUM_CHAT;
const WATCH_THREAD   = process.env.WATCH_THREAD_ID ? parseInt(process.env.WATCH_THREAD_ID) : null;
const ADMIN_ID       = process.env.ADMIN_ID || '421411369';
const FREE_DELAY_MS  = 8 * 60 * 1000;

const fs   = require('fs');
const http = require('http');

// ── Firebase Admin (Firestore — kalıcı sinyal depolama) ──
let db = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID   || 'solradar-3e7bd',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'firebase-adminsdk-fbsvc@solradar-3e7bd.iam.gserviceaccount.com',
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      })
    });
  }
  db = admin.firestore();
  console.log('✅ Firebase Firestore connected');
} catch (e) {
  console.warn('⚠️ Firebase unavailable, falling back to local signals.json:', e.message);
}

// ── Üye veritabanı (members.json) ──
const DB_FILE = './members.json';
function loadMembers() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}
function saveMembers(dbObj) {
  fs.writeFileSync(DB_FILE, JSON.stringify(dbObj, null, 2));
}

// ── Sinyal kaydı (Firestore önce, fallback signals.json) ──
const SIGNALS_FILE = './signals.json';
function loadSignalsLocal() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); } catch { return []; }
}
function saveSignalsLocal(arr) {
  try { fs.writeFileSync(SIGNALS_FILE, JSON.stringify(arr, null, 2)); } catch {}
}

async function recordSignal(token, priceUsd, marketCap) {
  const signal = {
    address:    token.address,
    symbol:     token.symbol,
    confidence: token.confidence || 0,
    rugScore:   token.rugScore,
    trapScore:  token.trapScore,
    entryPrice: priceUsd,
    entryMC:    marketCap,
    signaledAt: Date.now(),
    maxPrice:   priceUsd,
    maxX:       1,
    lastPrice:  priceUsd,
    lastChecked: Date.now()
  };

  if (db) {
    try {
      await db.collection('signals').add(signal);
      return;
    } catch (e) { console.warn('Firestore write error:', e.message); }
  }
  // Fallback: local file
  const arr = loadSignalsLocal();
  arr.push(signal);
  if (arr.length > 200) arr.shift();
  saveSignalsLocal(arr);
}

async function loadSignals() {
  if (db) {
    try {
      const snap = await db.collection('signals').orderBy('signaledAt','desc').limit(500).get();
      return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    } catch (e) { console.warn('Firestore read error:', e.message); }
  }
  return loadSignalsLocal();
}

// ── FİLTRE AYARLARI ──
const FILTERS = {
  minLiquidity: 5000,        // $8K→$5K: daha fazla token geçsin
  minChange5m: 10,           // 15→10: momentum eşiğini düşür
  maxChange5m: 90,           // 80→90: biraz daha geniş
  maxAgeMin: 90,             // 60→90: daha fazla token yakalanır
  minAgeMin: 3,              // 5→3: ilk 3dk sonra bakabilir
  requirePositiveBuyRatio: true,
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

  // /performans — performance report (admin only)
  if (text.startsWith('/performans') || text.startsWith('/performance')) {
    const parts = text.split(' ');
    const days = parseInt(parts[1]) || 7;
    const report = await buildPerformanceReport(days);
    await sendTelegram(fromId, null, report);
    return;
  }

  // /sharex [days] — X (Twitter) ready stats post
  if (text.startsWith('/sharex')) {
    const days = parseInt(text.split(' ')[1]) || 7;
    const post = await buildShareX(days);
    if (!post) { await sendTelegram(fromId, null, '📊 No signal data yet to share.'); return; }
    await sendTelegram(fromId, null, `📋 <b>Copy &amp; paste to X/Twitter:</b>\n\n<pre>${post}</pre>`);
    return;
  }

  // /help
  if (text.startsWith('/help')) {
    await sendAdmin(`📖 <b>Komutlar</b>

/addpremium @kullanıcı 30 — Üye ekle (gün sayısı)
/removepremium @kullanıcı — Üye sil
/listpremium — Tüm üyeleri listele
/checkpremium — Anında üyelik kontrolü yap
/performans [gün] — Sinyal başarı raporu (sadece sen)
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
// ── RugCheck: tek çağrı, hem skor hem holder (cache + 429 koruması) ──
const rugCache = new Map();         // addr -> {score, top1, top3, ts}
const RUG_TTL = 10 * 60 * 1000;     // 10 dk cache
let rugBlockedUntil = 0;            // 429 yedikten sonra bekleme

async function getRugData(addr) {
  // Cache kontrol
  const c = rugCache.get(addr);
  if (c && Date.now() - c.ts < RUG_TTL) return c;
  // Rate-limit bekleme süresindeyse hiç çağırma
  if (Date.now() < rugBlockedUntil) return { score: null, top1: null, top3: null, ts: Date.now(), unavailable: true };

  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${addr}/report`);
    if (r.status === 429) {
      rugBlockedUntil = Date.now() + 60 * 1000;  // 1 dk soğuma
      console.log('⚠️ RugCheck 429 — cooling 60s');
      return { score: null, top1: null, top3: null, ts: Date.now(), unavailable: true };
    }
    if (!r.ok) return { score: null, top1: null, top3: null, ts: Date.now(), unavailable: true };
    const d = await r.json();

    // Skor
    let score = null;
    if (d.score_normalised !== undefined) score = Math.max(0, Math.min(100, Math.round(d.score_normalised)));
    else if (d.score !== undefined) score = Math.max(0, Math.min(100, Math.round(d.score)));

    // Holder konsantrasyonu
    let top1 = null, top3 = null;
    const holders = d.topHolders || [];
    if (holders.length) {
      const real = holders.filter(h => !h.insider && !(h.owner && d.markets?.some(m => m.lp?.lpMint === h.address)));
      const list = (real.length ? real : holders).map(h => h.pct || 0);
      top1 = list[0] || 0;
      top3 = (list[0] || 0) + (list[1] || 0) + (list[2] || 0);
    }
    const res = { score, top1, top3, ts: Date.now() };
    rugCache.set(addr, res);
    return res;
  } catch { return { score: null, top1: null, top3: null, ts: Date.now(), unavailable: true }; }
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

// ── GÜVEN ENDEKSİ (0-100) ──
// Her kriter puan katkısı yapar. Sert eleme yerine ağırlıklı skor.
function calcConfidence(d) {
  let score = 0;
  const reasons = [];

  // RugCheck safety (max 25) — neutral if unavailable
  if (d.rugScore != null) {
    if (d.rugScore >= 90)      { score += 25; }
    else if (d.rugScore >= 80) { score += 20; }
    else if (d.rugScore >= 70) { score += 12; reasons.push('rug medium'); }
    else                       { score += 0;  reasons.push('rug low'); }
  } else { score += 16; reasons.push('rug data unavailable'); }

  // Holder concentration (max 25) — neutral if unavailable
  if (d.top1 != null) {
    if (d.top3 <= 20)      score += 25;
    else if (d.top3 <= 30) { score += 16; reasons.push('top3 medium'); }
    else if (d.top3 <= 45) { score += 6;  reasons.push('top3 high'); }
    else                   { score += 0;  reasons.push('concentration risk'); }
  } else { score += 16; }

  // Follow-through: h1 check (max 20)
  if (d.h1 > 10)      score += 20;
  else if (d.h1 > 0)  score += 14;
  else if (d.h1 > -10){ score += 5; reasons.push('h1 weak'); }
  else                { score += 0; reasons.push('h1 negative (pump faded)'); }

  // Trap score (max 15)
  if (d.trapScore >= 80)      score += 15;
  else if (d.trapScore >= 60) score += 10;
  else if (d.trapScore >= 40) { score += 5; reasons.push('trap signal'); }
  else                        { score += 0; reasons.push('trap risk'); }

  // Liquidity (max 10)
  if (d.liquidity >= 30000)      score += 10;
  else if (d.liquidity >= 15000) score += 7;
  else if (d.liquidity >= 8000)  score += 4;
  else                           { score += 0; reasons.push('low liquidity'); }

  // Volume/liquidity health (max 5)
  const vlr = d.liquidity > 0 ? d.vol1 / d.liquidity : 0;
  if (vlr >= 1 && vlr <= 6)      score += 5;
  else if (vlr >= 0.5)           score += 2;
  else                           reasons.push('low volume');

  // ── VETO: Kritik riskler tavan koyar (iyi kriterler maskelemesin) ──
  // Holder konsantrasyonu çok yüksekse, başka her şey mükemmel olsa bile ONAYLI olamaz
  if (d.top1 != null) {
    if (d.top3 > 40)       score = Math.min(score, 45);  // 3 cüzdan %40+ = dump riski, max 45 (çöp/izle sınırı)
    else if (d.top3 > 30)  score = Math.min(score, 64);  // %30-40 = en fazla İZLE (70 altı), ONAYLI olamaz
    if (d.top1 > 20)       score = Math.min(score, 45);  // tek cüzdan %20+ = tehlikeli
    else if (d.top1 > 15)  score = Math.min(score, 64);  // tek cüzdan %15-20 = en fazla İZLE
  }
  // h1 negatifse (pump söndü) ONAYLI olamaz
  if (d.h1 <= -10) score = Math.min(score, 45);
  else if (d.h1 < 0) score = Math.min(score, 64);

  return { score: Math.round(score), reasons };
}

// ── Progress bar helper ──
function bar(val, max=100, len=8){
  const f=Math.round(Math.min(val,max)/max*len);
  return '▰'.repeat(f)+'▱'.repeat(len-f);
}

function formatMessage(t) {
  const ci = t.confidence ?? 0;
  const tier = ci >= 70 ? '✅ CONFIRMED' : ci >= 50 ? '⚠️ WATCH' : '🔴 RISKY';
  const ciDot = ci >= 70 ? '🟢' : ci >= 50 ? '🟡' : '🔴';
  const rugVal = t.rugScore != null ? t.rugScore : '?';
  const mcLine = t.marketCap > 0 ? `MC: <b>${fmt(t.marketCap)}</b>  ` : '';
  const concLine = t.top1 != null ? `\n👥 Top1 <b>${t.top1.toFixed(0)}%</b>  Top3 <b>${t.top3.toFixed(0)}%</b>` : '';
  const warnLine = t.reasons?.length ? `\n⚠️ <i>${t.reasons.slice(0,2).join(' · ')}</i>` : '';
  const boostLine = t.boost > 0 ? ` 🚀×${t.boost}` : '';

  return `${tier} — <b>$${t.symbol}</b>${boostLine}

${ciDot} <b>${ci}</b>  🛡 <b>${rugVal}</b>  🎯 <b>${t.trapScore}</b>  📈 <b>+${t.change5m.toFixed(1)}%</b>

${mcLine}💧 <b>${fmt(t.liquidity)}</b>  ⏱ <b>${t.ageMin}min</b>${concLine}${warnLine}

<code>${t.address}</code>
<a href="https://jup.ag/swap/So11111111111111111111111111111111111111112-${t.address}?referrer=ACmAkQLb71nqH4TcbKC6CEHJJz2qPvUAGXJjP8zahfTy&feeBps=30">⚡ Buy</a>  ·  <a href="https://dexscreener.com/solana/${t.address}">📊 Chart</a>

<i>DYOR · Not financial advice</i>`;
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
      const h1        = p.priceChange?.h1 || 0;
      const vol1      = p.volume?.h1 || 0;
      const buys      = p.txns?.m5?.buys || 0;
      const sells     = p.txns?.m5?.sells || 0;
      const created   = p.pairCreatedAt;
      const ageMin    = created ? Math.floor((Date.now() - created) / 60000) : 999;
      const trapScore = calcTrapScore(p);

      // ── ÖN ELEME (sadece çöp/spam, gerisi skorlanır) ──
      if (liq < 3000) continue;                        // çok düşük likidite = çöp
      if (m5 < FILTERS.minChange5m) continue;          // momentum yok
      if (m5 > FILTERS.maxChange5m) continue;          // aşırı pump = geç kaldın
      if (ageMin > FILTERS.maxAgeMin) continue;        // çok eski
      if (ageMin < FILTERS.minAgeMin) continue;        // ilk dakikalar manipülatif
      if (buys <= sells) continue;                     // satış baskısı

      // ── Veri topla (tek RugCheck çağrısı) ──
      const rug = await getRugData(addr);
      const rugScore = rug.score;
      const conc = (rug.top1 != null) ? { top1: rug.top1, top3: rug.top3 } : null;

      // ── GÜVEN ENDEKSİ HESAPLA ──
      const { score: confidence, reasons } = calcConfidence({
        rugScore, trapScore, h1, liquidity: liq, vol1,
        top1: conc?.top1 ?? null, top3: conc?.top3 ?? null
      });

      // <40 = çöp, hiç gönderme
      if (confidence < 40) { seen.add(addr); continue; }

      seen.add(addr);
      // Sembol: önce DexScreener baseToken (güvenilir), sonra header — URL/uzun metin gelirse temizle
      let symbol = p.baseToken?.symbol || tk.header || '???';
      if (/^https?:|\/|\s/.test(symbol) || symbol.length > 15) symbol = p.baseToken?.symbol || '???';
      symbol = symbol.replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 15) || '???';
      const token = {
        address: addr,
        symbol,
        liquidity: liq, change5m: m5, ageMin, trapScore,
        rugScore: rugScore ?? '?',
        boost: boostedSet[addr] || 0,
        marketCap: p.marketCap || p.fdv || 0,
        top1: conc?.top1 ?? null,
        top3: conc?.top3 ?? null,
        confidence,
        reasons
      };
      const msg = formatMessage(token);

      // Performans takibi için kaydet
      const entryPrice = p.priceUsd ? parseFloat(p.priceUsd) : 0;
      const entryMC = p.marketCap || p.fdv || 0;
      await recordSignal(token, entryPrice, entryMC);

      // ── İKİ KADEMELİ YÖNLENDİRME ──
      if (confidence >= 70) {
        // CONFIRMED → Premium channel (instant) + Free group (delayed)
        await sendTelegram(PREMIUM_CHAT, PREMIUM_THREAD, '⭐ <b>[PREMIUM]</b>\n\n' + msg);
        console.log(`✅ CONFIRMED (${confidence}): $${token.symbol}`);
        setTimeout(async () => {
          await sendTelegram(FREE_CHAT, FREE_THREAD, msg + '\n\n💎 <i>Premium members saw this 8 min early. Join: @Solradarapp</i>');
        }, FREE_DELAY_MS);
      } else {
        // WATCH (50-69) → Premium channel only, higher risk label
        await sendTelegram(WATCH_CHAT, WATCH_THREAD, '👀 <b>[WATCHLIST — higher risk]</b>\n\n' + msg);
        console.log(`⚠️ WATCH (${confidence}): $${token.symbol}`);
      }
    }

    if (seen.size > 500) seen.clear();
  } catch (e) {
    console.error('Tarama hatası:', e.message);
  }
}

// ── Sinyal performansını güncelle (her saat) ──
async function updateSignalPerformance() {
  const signals = await loadSignals();
  if (!signals.length) return;

  const active = signals.filter(s => Date.now() - s.signaledAt < 7 * 24 * 60 * 60 * 1000);
  const addrs = [...new Set(active.map(s => s.address))];

  for (const chunk of [addrs.slice(0, 30), addrs.slice(30, 60)]) {
    if (!chunk.length) continue;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
      if (!r.ok) continue;
      const data = await r.json();
      const priceMap = {};
      (data.pairs || []).forEach(p => {
        const a = p.baseToken?.address;
        if (a && p.priceUsd) priceMap[a] = parseFloat(p.priceUsd);
      });

      for (const s of active) {
        const cur = priceMap[s.address];
        if (!cur || s.entryPrice <= 0) continue;
        const newMaxX = cur > (s.maxPrice || 0) ? +(cur / s.entryPrice).toFixed(2) : s.maxX;
        const updated = {
          lastPrice: cur, lastChecked: Date.now(),
          maxPrice: Math.max(s.maxPrice || 0, cur), maxX: newMaxX
        };
        if (db && s._id) {
          try { await db.collection('signals').doc(s._id).update(updated); } catch {}
        } else {
          Object.assign(s, updated);
        }
      }
    } catch {}
  }

  if (!db) saveSignalsLocal(signals); // fallback only
  console.log(`📊 Performance updated: ${active.length} active signals`);
}

// ── Performans özeti ──
async function buildPerformanceReport(days = 7) {
  const signals = await loadSignals();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = signals.filter(s => s.signaledAt >= cutoff && s.entryPrice > 0);

  if (!recent.length) return `📊 No tracked signals in the last ${days} days.`;

  const total = recent.length;
  const winners = recent.filter(s => s.maxX >= 2).length;
  const bigWins = recent.filter(s => s.maxX >= 5).length;
  const avgMaxX = (recent.reduce((sum, s) => sum + s.maxX, 0) / total).toFixed(2);
  const best = recent.reduce((a, b) => b.maxX > a.maxX ? b : a, recent[0]);
  const stillUp = recent.filter(s => s.lastPrice > s.entryPrice).length;
  const winRate = ((winners / total) * 100).toFixed(0);

  const top5 = [...recent].sort((a, b) => b.maxX - a.maxX).slice(0, 5)
    .map(s => `  • $${s.symbol}: <b>${s.maxX}x</b> (entry $${s.entryPrice < 0.0001 ? s.entryPrice.toExponential(1) : s.entryPrice.toFixed(6)})`)
    .join('\n');

  return `📊 <b>PERFORMANCE REPORT — Last ${days} days</b>
<i>(only visible to you)</i>

Total signals: <b>${total}</b>
2x+ winners:  <b>${winners}</b> (${winRate}%)
5x+ winners:  <b>${bigWins}</b>
Avg peak:      <b>${avgMaxX}x</b>
Currently up: <b>${stillUp}/${total}</b>

🏆 Best: <b>$${best.symbol} ${best.maxX}x</b>

<b>Top 5:</b>
${top5}

<i>Note: maxX = peak after signal. Actual user results may differ.</i>`;
}

// ── /sharex — X'te paylaşmak için hazır istatistik ──
async function buildShareX(days = 7) {
  const signals = await loadSignals();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = signals.filter(s => s.signaledAt >= cutoff && s.entryPrice > 0);
  if (!recent.length) return null;

  const total = recent.length;
  const winners = recent.filter(s => s.maxX >= 2).length;
  const bigWins = recent.filter(s => s.maxX >= 5).length;
  const avgMaxX = (recent.reduce((sum, s) => sum + s.maxX, 0) / total).toFixed(1);
  const best = recent.reduce((a, b) => b.maxX > a.maxX ? b : a, recent[0]);
  const winRate = ((winners / total) * 100).toFixed(0);

  return `🎯 SOL RADAR — Last ${days}d performance

✅ ${total} signals sent
📈 2x+ winners: ${winners} (${winRate}%)
🚀 5x+ winners: ${bigWins}
📊 Avg peak: ${avgMaxX}x
🏆 Best: $${best.symbol} ${best.maxX}x

Free signals 👇
t.me/SolRadar

#Solana #memecoin #crypto`;
}

// ── Başlat ──
console.log('🚀 SOL RADAR bot started');
console.log(`Premium channel: ${PREMIUM_CHAT} | Free group: ${FREE_CHAT} (thread ${FREE_THREAD})`);

pollUpdates();
scheduleDailyCheck();
scanAndPost();
setInterval(scanAndPost, 60 * 1000);
setInterval(updateSignalPerformance, 60 * 60 * 1000); // her saat performans güncelle
setTimeout(updateSignalPerformance, 5 * 60 * 1000);    // ilk güncelleme 5dk sonra

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('SOL RADAR running ✓');
}).listen(process.env.PORT || 3000);
