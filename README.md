# SOL RADAR — Telegram Sinyal Botu

Radar filtresinden geçen tokenleri otomatik Telegram'a atar.
**Premium kanala anında, Free kanala 8 dakika gecikmeli** → FOMO yaratır, premium'a dönüşüm sağlar.

Hiç bağımlılık yok, saf Node.js. Railway/Render'da 7/24 çalışır.

---

## ADIM 1 — Telegram Bot Oluştur

1. Telegram'da **@BotFather**'a yaz
2. `/newbot` → isim ve kullanıcı adı ver
3. Sana verdiği **token**'ı kopyala (`123456:ABC-DEF...`)

---

## ADIM 2 — İki Kanal Aç

1. Telegram'da 2 kanal oluştur:
   - **SOL RADAR Premium** (premium üyeler)
   - **SOL RADAR Free** (herkese açık)
2. Botu her iki kanala **admin** yap (mesaj atabilmesi için)
3. Kanal ID'lerini al:
   - Kanala bir mesaj at
   - `https://api.telegram.org/bot<TOKEN>/getUpdates` aç
   - `"chat":{"id":-100xxxxx}` → bu ID'yi kopyala

---

## ADIM 3 — Railway'e Deploy

1. https://railway.app → New Project
2. Bu klasörü yükle (veya GitHub'a koy, bağla)
3. **Variables** ekle:
   ```
   TELEGRAM_BOT_TOKEN = 123456:ABC-DEF...
   PREMIUM_CHAT_ID = -1001111111111
   FREE_CHAT_ID = -1002222222222
   ```
4. Deploy otomatik başlar
5. Loglardan "🚀 başladı" mesajını gör

---

## Filtre Ayarları

`bot.js` içinde `FILTERS` objesi — uygulamadaki ile aynı:

```js
const FILTERS = {
  minLiquidity: 5000,     // min likidite
  minRugScore: 80,        // min güvenlik skoru
  minHolders: 100,        // (şu an pasif, DexScreener vermiyor)
  minChange5m: 20,        // min 5dk değişim %
  maxAgeMin: 30,          // max token yaşı (dk)
  requirePositiveBuyRatio: true,
  maxTrapDanger: 40,      // bu altı tuzak skoru = atlanır
};
```

İstediğin gibi ayarla. Daha az ama kaliteli sinyal için sıkı tut (strateji: "yüksek kalite seçicilik").

---

## Gecikme Mantığı (önemli)

`FREE_DELAY_MS = 8 dakika`

- Premium üye: token'ı **anında** görür
- Free üye: **8 dakika sonra** görür + "Premium 8dk önce gördü" notu

Bu fark, hiç emek istemeden premium'a dönüşüm yaratır. Süreyi değiştirebilirsin.

---

## Maliyet

- Railway: $5/ay ücretsiz kredi (bu bot için fazlasıyla yeter)
- Telegram API: tamamen ücretsiz
- DexScreener + RugCheck API: ücretsiz

---

## İpuçları

- Free kanalı herkese açık tut → organik büyüme (insanlar paylaşır)
- Premium kanala sadece ödeme yapanları al (Stripe webhook ile otomatik davet linki üretilebilir — sonraki adım)
- Çok sinyal = spam algısı. Filtreleri sıkı tut, günde 5-15 kaliteli sinyal ideal.
