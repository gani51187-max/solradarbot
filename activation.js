// ═══════════════════════════════════════════════════════════════
// SOL RADAR — Otomatik Aktivasyon Modülü
// bot.js'e eklenecek. İki yerde değişiklik lazım (aşağıda belirtildi)
// ═══════════════════════════════════════════════════════════════

// ── SOLANA USDC ÖDEME DOĞRULAMA ──
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYMENT_WALLET = 'EgPHRTm3NnfJc4Xv3KwsLd8nUWqZpqkjUxgxo5Wz4rWR';
const REQUIRED_USDC = 9;
const SOL_RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

async function verifyUSDCPayment(txHash) {
  try {
    const res = await fetch(SOL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
      })
    });
    const data = await res.json();
    const tx = data.result;

    if (!tx)        return { ok: false, err: '❌ İşlem bulunamadı. Hash doğru mu? Henüz onaylanmadı olabilir, 1-2 dk bekle.' };
    if (tx.meta?.err) return { ok: false, err: '❌ İşlem blockchain\'de başarısız olarak işaretli.' };

    // Bizim cüzdanımıza gelen USDC miktarını hesapla
    const pre  = tx.meta?.preTokenBalances  || [];
    const post = tx.meta?.postTokenBalances || [];

    let receivedUSDC = 0;
    for (const bal of post) {
      if (bal.mint !== USDC_MINT) continue;
      if (bal.owner !== PAYMENT_WALLET) continue;
      const preBal = pre.find(p => p.accountIndex === bal.accountIndex);
      const preAmt = preBal ? parseFloat(preBal.uiTokenAmount?.uiAmount || 0) : 0;
      const postAmt = parseFloat(bal.uiTokenAmount?.uiAmount || 0);
      receivedUSDC += Math.max(0, postAmt - preAmt);
    }

    if (receivedUSDC < REQUIRED_USDC - 0.1) {
      return { ok: false, err: `❌ Yetersiz USDC. Gelen: ${receivedUSDC.toFixed(2)} USDC — Gereken: ${REQUIRED_USDC} USDC` };
    }

    return { ok: true, amount: receivedUSDC };
  } catch (e) {
    return { ok: false, err: '❌ RPC bağlantı hatası: ' + e.message };
  }
}

// ── AKTİVASYON KOMUTU ──
// Bu fonksiyonu mevcut bot.js'teki mesaj handler'ına ekle.
// Örnek: if (text.startsWith('/activate')) { ... }
async function handleActivate(fromId, text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    return sendTelegram(fromId, null,
      `⚡ <b>Aktivasyon Kullanımı:</b>\n\n<code>/activate email@gmail.com TX_HASH</code>\n\n` +
      `Örnek:\n<code>/activate ali@gmail.com 5Kj8x...abc</code>\n\n` +
      `<i>TX Hash = Solana Explorer'da işlem bağlantısından alınan kod</i>`
    );
  }

  const email   = parts[1].toLowerCase().trim();
  const txHash  = parts[2].trim();
  const statusMsg = await sendTelegram(fromId, null, '⏳ İşlem doğrulanıyor...');

  // 1. Email formatı kontrol
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendTelegram(fromId, null, '❌ Geçersiz email formatı.');
  }

  // 2. TX hash format kontrol (Solana base58, ~87 karakter)
  if (txHash.length < 43 || txHash.length > 90) {
    return sendTelegram(fromId, null, '❌ Geçersiz TX hash formatı. Solana Explorer\'dan tam hash\'i kopyala.');
  }

  // 3. Daha önce kullanılmış mı?
  if (db) {
    const usedSnap = await db.collection('used_tx').doc(txHash).get().catch(() => null);
    if (usedSnap?.exists) {
      return sendTelegram(fromId, null, '❌ Bu işlem zaten kullanılmış. Her TX yalnızca bir aktivasyon için geçerlidir.');
    }
  }

  // 4. Solana TX doğrula
  const verify = await verifyUSDCPayment(txHash);
  if (!verify.ok) {
    return sendTelegram(fromId, null, verify.err + '\n\n<i>Sorun devam ederse @Solradarapp\'e yaz.</i>');
  }

  // 5. Firebase Auth'ta emaile göre kullanıcı bul
  let uid;
  try {
    const admin = require('firebase-admin');
    const userRecord = await admin.auth().getUserByEmail(email);
    uid = userRecord.uid;
  } catch (e) {
    return sendTelegram(fromId, null,
      `❌ Bu email ile kayıtlı hesap bulunamadı: <code>${email}</code>\n\n` +
      `Önce <a href="https://solradar-3e7bd.web.app">solradar-3e7bd.web.app</a>'den kayıt ol, sonra aktive et.`
    );
  }

  // 6. Firestore'da plan güncelle
  try {
    await db.collection('users').doc(uid).set({
      plan: 'pro',
      email,
      activatedAt: Date.now(),
      activatedByTx: txHash,
      activatedByTelegramId: fromId
    }, { merge: true });

    // TX'i kullanılmış olarak işaretle
    await db.collection('used_tx').doc(txHash).set({
      email, uid, activatedAt: Date.now(), fromTelegramId: fromId
    });
  } catch (e) {
    return sendTelegram(fromId, null, '❌ Veritabanı hatası. Lütfen @Solradarapp\'e yaz: ' + e.message);
  }

  // 7. Kullanıcıya onay gönder
  await sendTelegram(fromId, null,
    `✅ <b>Aktivasyon Tamamlandı!</b>\n\n` +
    `📧 Hesap: <code>${email}</code>\n` +
    `💎 Plan: <b>PRO</b>\n` +
    `💵 Ödeme: ${verify.amount.toFixed(2)} USDC onaylandı\n\n` +
    `🔗 <a href="https://solradar-3e7bd.web.app/radar">SOL RADAR'a giriş yap</a>\n\n` +
    `<i>Sorularınız için @Solradarapp</i>`
  );

  // 8. Yöneticiye bildir
  if (ADMIN_ID) {
    await sendTelegram(ADMIN_ID, null,
      `🔔 <b>Yeni PRO Üye!</b>\n\n` +
      `📧 ${email}\n` +
      `💵 ${verify.amount.toFixed(2)} USDC\n` +
      `🔑 TX: <code>${txHash.slice(0,20)}...</code>`
    );
  }
}

module.exports = { handleActivate };

/*
 * ══════════════════════════════════════════════════════
 * KURULUM — bot.js'e nasıl eklenir:
 * ══════════════════════════════════════════════════════
 *
 * 1. Bu dosyayı solradar-telegram-bot/ klasörüne koy
 *
 * 2. bot.js'in en üstüne ekle:
 *    const { handleActivate } = require('./activation');
 *
 * 3. Mesaj handler'ında /activate komutunu ekle:
 *    (diğer if/else komutlarının yanına)
 *
 *    if (text.startsWith('/activate')) {
 *      await handleActivate(fromId, text);
 *      return;
 *    }
 *
 * 4. /help mesajına ekle:
 *    /activate email tx_hash — PRO aktivasyon
 *
 * 5. GitHub'a push → Railway auto-deploy
 *
 * ══════════════════════════════════════════════════════
 * KULLANICI AKIŞI:
 * ══════════════════════════════════════════════════════
 * 1. Kullanıcı 9 USDC gönderir (EgPHRTm3...rWR adresine)
 * 2. Solana Explorer'dan TX hash'i kopyalar
 * 3. Bota yazar: /activate email@mail.com TX_HASH
 * 4. Bot 3-4 saniyede doğrular ve aktive eder
 * 5. Kullanıcı hemen radar'a girebilir
 */
