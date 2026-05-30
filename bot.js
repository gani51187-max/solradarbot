// ═══════════════════════════════════════════════════
// SOL RADAR — Telegram Sinyal Botu
// Premium/Free thread desteği + Üyelik yönetimi
// ═══════════════════════════════════════════════════

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '8969831057:AAHLcE0j3GRwUZ67ehoQg-1eMalOn_BpPEY';
// Premium: ayrı kapalı kanal | Free: mevcut grup (Topics'li)
const PREMIUM_CHAT   = process.env.PREMIUM_CHAT || '-1003914359932';  // SolRadar Premium kanalı
const PREMIUM_THREAD = process.env.PREMIUM_THREAD_ID ? parseInt(process.env.PREMIUM_THREAD_ID) : null; // kanal = thread yok
const FREE_CHAT      = process.env.FREE_CHAT || '-1003779270396';     // SolRadar grubu
const FREE_THREAD    = parseInt(process.env.FREE_THREAD_ID || '20');  // Free başlığı
const WATCH_CHAT     = process.env.WATCH_CHAT || PREMIUM_CHAT;        // İzle sinyalleri → premium kanal
const WATCH_THREAD   = process.env.WATCH_THREAD_ID ? parseInt(process.env.WATCH_THREAD_ID) : null;
const ADMIN_ID       = process.env.ADMIN_ID || '421411369';          // Gani'nin Telegram ID'si
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

// ── Sinyal performans takibi (signals.json) ──
const SIGNALS_FILE = './signals.json';
function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); }
  catch { return []; }
}
function saveSignals(arr) {
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(arr, null, 2));
}
// Yeni sinyal kaydet
function recordSignal(token, priceUsd, marketCap) {
  const signals = loadSignals();
  signals.push({
    address: token.address,
    symbol: token.symbol,
    entryPrice: priceUsd,
    entryMC: marketCap,
    rugScore: token.rugScore,
    trapScore: token.trapScore,
    boost: token.boost,
    signaledAt: Date.now(),
    maxPrice: priceUsd,      // gördüğümüz en yüksek fiyat
    maxX: 1,                 // max kaç X yaptı
    lastPrice: priceUsd,
    lastCheck: Date.now()
  });
  // Son 200 sinyali tut
  if (signals.length > 200) signals.shift();
  saveSignals(signals);
}

// ── FİLTRE AYARLARI ──
const FILTERS = {
  minLiquidity: 8000,        // $5K→$8K: tek satış fiyatı az oynatsın (araştırma: <$8K riskli)
  minRugScore: 85,           // 80→85: daha güvenli
  minHolders: 100,
  minChange5m: 15,           // 20→15: aşırı pump anını kovalama, daha sakin giriş
  maxChange5m: 80,           // YENİ: %80+ 5dk = zaten pump olmuş, geç kalmışsın, atla
  maxAgeMin: 60,             // 30→60: biraz olgunlaşsın (ilk dakika curve buyer dump'ı geçsin)
  minAgeMin: 5,              // YENİ: ilk 5dk en manipülatif, atla
  requirePositiveBuyRatio: true,
  maxTrapDanger: 50,         // 40→50: daha temiz yapı iste
  // ── Sürdürülebilirlik (pump-dump filtresi) ──
  maxTopHolderPct: 15,       // YENİ: en büyük holder %15'ten fazlaysa = insider riski, atla
  maxTop3Pct: 30,            // YENİ: ilk 3 holder toplam %30+ = dump riski, atla
  minVolLiqRatio: 0.5,       // YENİ: hacim/likidite oranı (sahte hacim filtresi)
  maxVolLiqRatio: 8,         // YENİ: aşırı hacim/likidite = manipülasyon
  requireH1Positive: true,   // YENİ: 1 saatlik de pozitif olsun (follow-through teyidi)
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

  // /performans — sinyal başarı takibi (sadece admin)
  if (text.startsWith('/performans') || text.startsWith('/performance')) {
    const parts = text.split(' ');
    const days = parseInt(parts[1]) || 7;
    const report = buildPerformanceReport(days);
    // Komutu yazana özelden cevap ver (ADMIN_ID boş olsa bile çalışır)
    await sendTelegram(fromId, null, report);
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

// ── Holder konsantrasyonu (pump-dump filtresi) ──
// RugCheck full report'tan ilk cüzdanların yüzdesini al
async function getHolderConcentration(addr) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${addr}/report`);
    if (!r.ok) return null;
    const d = await r.json();
    const holders = d.topHolders || [];
    if (!holders.length) return null;
    // Likidite havuzu/kilitli cüzdanları atla (genelde insider değil)
    const real = holders.filter(h => !h.insider && !(h.owner && d.markets?.some(m => m.lp?.lpMint === h.address)));
    const list = (real.length ? real : holders).map(h => h.pct || 0);
    const top1 = list[0] || 0;
    const top3 = (list[0] || 0) + (list[1] || 0) + (list[2] || 0);
    return { top1, top3 };
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

// ── GÜVEN ENDEKSİ (0-100) ──
// Her kriter puan katkısı yapar. Sert eleme yerine ağırlıklı skor.
function calcConfidence(d) {
  let score = 0;
  const reasons = [];

  // RugCheck güvenlik (max 25)
  if (d.rugScore != null) {
    if (d.rugScore >= 90)      { score += 25; }
    else if (d.rugScore >= 80) { score += 20; }
    else if (d.rugScore >= 70) { score += 12; reasons.push('rug orta'); }
    else                       { score += 0;  reasons.push('rug düşük'); }
  } else { score += 10; }

  // Holder konsantrasyonu (max 25) — en kritik dump göstergesi
  if (d.top1 != null) {
    if (d.top3 <= 20)      score += 25;
    else if (d.top3 <= 30) { score += 16; reasons.push('top3 orta'); }
    else if (d.top3 <= 45) { score += 6;  reasons.push('top3 yüksek'); }
    else                   { score += 0;  reasons.push('konsantrasyon riski'); }
  } else { score += 12; }

  // Follow-through: h1 teyidi (max 20)
  if (d.h1 > 10)      score += 20;
  else if (d.h1 > 0)  score += 14;
  else if (d.h1 > -10){ score += 5; reasons.push('h1 zayıf'); }
  else                { score += 0; reasons.push('h1 negatif (pump söndü)'); }

  // Tuzak skoru (max 15)
  if (d.trapScore >= 80)      score += 15;
  else if (d.trapScore >= 60) score += 10;
  else if (d.trapScore >= 40) { score += 5; reasons.push('tuzak sinyali'); }
  else                        { score += 0; reasons.push('tuzak riski'); }

  // Likidite (max 10)
  if (d.liquidity >= 30000)      score += 10;
  else if (d.liquidity >= 15000) score += 7;
  else if (d.liquidity >= 8000)  score += 4;
  else                           { score += 0; reasons.push('düşük likidite'); }

  // Hacim/likidite sağlığı (max 5)
  const vlr = d.liquidity > 0 ? d.vol1 / d.liquidity : 0;
  if (vlr >= 1 && vlr <= 6)      score += 5;
  else if (vlr >= 0.5)           score += 2;
  else                           reasons.push('hacim zayıf');

  return { score: Math.round(score), reasons };
}

function formatMessage(t) {
  const boostLine = t.boost > 0 ? `\n🚀 <b>DexScreener Boosted</b> (x${t.boost})` : '';
  const mcLine = t.marketCap > 0 ? `\n💰 Market Cap: <b>${fmt(t.marketCap)}</b>` : '';
  const concLine = (t.top1 != null) ? `\n👥 Top holder: <b>${t.top1.toFixed(1)}%</b> | Top 3: <b>${t.top3.toFixed(1)}%</b>` : '';
  // Güven endeksi başlık
  const ci = t.confidence ?? 0;
  const tier = ci >= 70 ? '✅ ONAYLI' : ci >= 50 ? '⚠️ İZLE' : '🔴 RİSKLİ';
  const ciBar = ci >= 70 ? '🟢' : ci >= 50 ? '🟡' : '🔴';
  const warnLine = (t.reasons && t.reasons.length) ? `\n⚠️ <i>${t.reasons.join(' · ')}</i>` : '';

  return `${tier} — $${t.symbol}${boostLine}
${ciBar} <b>Güven: ${ci}/100</b>

🛡 Safety: <b>${t.rugScore}/100</b> | 🎯 Trap: <b>${t.trapScore}/100</b>${mcLine}
💧 Liq: <b>${fmt(t.liquidity)}</b> | 📈 5dk: <b>+${t.change5m.toFixed(1)}%</b> | ⏱ <b>${t.ageMin}dk</b>${concLine}${warnLine}

<code>${t.address}</code>

⚡ <a href="https://jup.ag/swap/SOL-${t.address}?referrer=ACmAkQLb71nqH4TcbKC6CEHJJz2qPvUAGXJjP8zahfTy&feeBps=30">Al (Jupiter)</a> | 📊 <a href="https://dexscreener.com/solana/${t.address}">Chart</a>

<i>⚠ Yatırım tavsiyesi değil. DYOR.</i>`;
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

      // ── Veri topla ──
      const rugScore = await getRugScore(addr);
      const conc = await getHolderConcentration(addr);

      // ── GÜVEN ENDEKSİ HESAPLA ──
      const { score: confidence, reasons } = calcConfidence({
        rugScore, trapScore, h1, liquidity: liq, vol1,
        top1: conc?.top1 ?? null, top3: conc?.top3 ?? null
      });

      // <50 = çöp, hiç gönderme
      if (confidence < 50) { seen.add(addr); continue; }

      seen.add(addr);
      const token = {
        address: addr,
        symbol: tk.header || p.baseToken?.symbol || '???',
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
      recordSignal(token, entryPrice, entryMC);

      // ── İKİ KADEMELİ YÖNLENDİRME ──
      if (confidence >= 70) {
        // ONAYLI → Premium kanal (anında) + Free grup (gecikmeli)
        await sendTelegram(PREMIUM_CHAT, PREMIUM_THREAD, '⭐ <b>[PREMIUM]</b>\n\n' + msg);
        console.log(`✅ ONAYLI (${confidence}): $${token.symbol}`);
        setTimeout(async () => {
          await sendTelegram(FREE_CHAT, FREE_THREAD, msg + '\n\n💎 <i>Premium 8 dk önce gördü. Üyelik için: @gani188</i>');
        }, FREE_DELAY_MS);
      } else {
        // İZLE (50-69) → sadece Premium kanal, riskli etiketiyle
        await sendTelegram(WATCH_CHAT, WATCH_THREAD, '👀 <b>[İZLEME — riskli olabilir]</b>\n\n' + msg);
        console.log(`⚠️ İZLE (${confidence}): $${token.symbol}`);
      }
    }

    if (seen.size > 500) seen.clear();
  } catch (e) {
    console.error('Tarama hatası:', e.message);
  }
}

// ── Sinyal performansını güncelle (her saat) ──
async function updateSignalPerformance() {
  const signals = loadSignals();
  if (!signals.length) return;

  // Sadece son 7 günün sinyallerini takip et (eskiler dondurulur)
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
      signals.forEach(s => {
        const cur = priceMap[s.address];
        if (cur && s.entryPrice > 0) {
          s.lastPrice = cur;
          s.lastCheck = Date.now();
          if (cur > s.maxPrice) {
            s.maxPrice = cur;
            s.maxX = +(cur / s.entryPrice).toFixed(2);
          }
        }
      });
    } catch {}
  }
  saveSignals(signals);
  console.log(`📊 Performans güncellendi: ${active.length} aktif sinyal`);
}

// ── Performans özeti oluştur ──
function buildPerformanceReport(days = 7) {
  const signals = loadSignals();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = signals.filter(s => s.signaledAt >= cutoff && s.entryPrice > 0);

  if (!recent.length) return `📊 Son ${days} günde takip edilen sinyal yok.`;

  const total = recent.length;
  const winners = recent.filter(s => s.maxX >= 2).length;      // 2x+ yapanlar
  const bigWins = recent.filter(s => s.maxX >= 5).length;      // 5x+ yapanlar
  const avgMaxX = (recent.reduce((sum, s) => sum + s.maxX, 0) / total).toFixed(2);
  const best = recent.reduce((a, b) => b.maxX > a.maxX ? b : a, recent[0]);

  // Şu an pozitif/negatif
  const stillUp = recent.filter(s => s.lastPrice > s.entryPrice).length;
  const winRate = ((winners / total) * 100).toFixed(0);

  // En iyi 5
  const top5 = [...recent].sort((a, b) => b.maxX - a.maxX).slice(0, 5)
    .map(s => `  • $${s.symbol}: <b>${s.maxX}x</b> (giriş $${s.entryPrice < 0.0001 ? s.entryPrice.toExponential(1) : s.entryPrice.toFixed(6)})`)
    .join('\n');

  return `📊 <b>PERFORMANS — Son ${days} gün</b>
<i>(sadece sen görüyorsun)</i>

Toplam sinyal: <b>${total}</b>
2x+ yapan: <b>${winners}</b> (%${winRate})
5x+ yapan: <b>${bigWins}</b>
Ortalama max: <b>${avgMaxX}x</b>
Şu an pozitif: <b>${stillUp}/${total}</b>

🏆 En iyi: <b>$${best.symbol} ${best.maxX}x</b>

<b>Top 5:</b>
${top5}

<i>Not: maxX = sinyal sonrası gördüğü en yüksek nokta. Gerçek kullanıcı bunu yakalamamış olabilir.</i>`;
}

// ── Başlat ──
console.log('🚀 SOL RADAR bot başlatıldı');
console.log(`Premium kanal: ${PREMIUM_CHAT} | Free grup: ${FREE_CHAT} (thread ${FREE_THREAD})`);

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
