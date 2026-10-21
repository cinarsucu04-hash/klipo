# Klipo

Kısa video paylaşım uygulaması (TikTok benzeri, farklı isim ve marka). Tek bir Node.js sunucusu hem API'yi hem de web arayüzünü (PWA) sunar. Aynı arayüz, `android/` klasöründeki sarmalayıcı ile APK olarak da paketlenir.

**Neler var?**
Sonsuz kaydırmalı Sana Özel / Takip / Yeni akışları · video yükleme (ilerleme çubuğu, kapak görseli) · beğeni, kaydet, paylaş · yorum, yanıt, yorum beğenisi, sabitleme · hashtag ve @bahsetme · 24 saatlik hikâyeler (görüntüleyenler, yanıt → mesaj) · birebir ve grup mesajlaşma (görsel, "görüldü", video kartları) · bildirimler · özel hesap ve takip istekleri · engelleme / şikâyet · arama, keşfet, trend etiketler · profil ziyaretçileri, izleme geçmişi, sabitlenmiş videolar · kısıtlı mod, açık/koyu tema · yönetici paneli (istatistik, şikâyetler, kullanıcılar, videolar, duyuru, bakım modu, yedek, günlük) · PWA (ana ekrana ekle, çevrimdışı sayfa).

---

## 1) Render'a kurulum

1. **MongoDB Atlas** (ücretsiz M0): küme oluştur → *Database Access*'te kullanıcı ekle → *Network Access*'te `0.0.0.0/0` ekle (Render ücretsiz planda sabit IP yoktur) → *Connect → Drivers* ekranından bağlantı adresini kopyala.
2. Bu klasörün tamamını bir **GitHub deposuna** yükle (`.env` dosyasını yükleme).
3. Render'da **New → Blueprint** seç, depoyu göster. `render.yaml` servisi kendisi kurar. Sorulan değerler:

| Değişken | Açıklama |
|---|---|
| `MONGO_URL` | Atlas bağlantı adresi (zorunlu) |
| `ADMIN_SETUP_CODE` | Yönetici hesabı açarken girilecek gizli kod (zorunlu, kendin belirle) |
| `SESSION_SECRET` | Render otomatik üretir; elle verirsen en az 32 karakter olsun |
| `ADMIN_USERNAMES` | Yönetici olabilecek kullanıcı adları, virgülle (varsayılan `admin`) |
| `DB_NAME` | Veritabanı adı (varsayılan `klipo`) |
| `STORAGE` | `gridfs` (varsayılan, dosyalar MongoDB'de) veya `disk` (Render kalıcı disk bağlıysa) |
| `MAX_VIDEO_MB` / `MAX_IMAGE_MB` | Yükleme sınırları (60 / 8) |
| `KEEP_ALIVE` | `0` yaparsan kendi kendine ping atmayı kapatır |

4. Dağıtım bitince `https://ADIN.onrender.com/healthz` adresi `{"ok":true,"db":true,…}` döndürmeli.
5. **Yönetici hesabı:** uygulamada *Kayıt ol* → kullanıcı adı `admin` → açılan kutuya `ADMIN_SETUP_CODE` değerini gir. Sonra *Ayarlar → Yönetim paneli*.

**Bilmen gerekenler**
- Render ücretsiz planı 15 dk hareketsizlikte uyur; ilk açılış 30–60 sn sürebilir. Sunucu portu hemen açar ve veritabanına arka planda bağlanır; bu sürede "başlatılıyor" cevabı verir.
- `STORAGE=gridfs` ile videolar Atlas'ın içine yazılır. Ücretsiz M0 kümesi 512 MB'tır; yani yüzlerce video değil, birkaç on video sığar. Gerçek kullanım için ücretli Atlas/Render diski ya da ayrı bir nesne depolama (S3/R2) gerekir (bu sürümde nesne depolama bağlantısı yok).
- Render'ın ücretsiz diski kalıcı değildir; bu yüzden varsayılan `gridfs`'tir.

## 2) Yerelde çalıştırma

```bash
cp .env.example .env      # değerleri doldur
npm install
npm run dev               # http://localhost:3000
npm run check             # bağımlılıksız sözdizimi / içe-dışa aktarma denetimi
```
Node 18+ gerekir. Yerelde MongoDB için Atlas adresi ya da yerel `mongod` kullanabilirsin.

## 3) APK üretme

Android SDK ve Gradle indirmeleri bu geliştirme ortamından erişilebilir değildi; bu yüzden **APK burada derlenemedi**. Proje hazır, aşağıdakilerden biriyle birkaç dakikada derlenir:

**A. GitHub Actions (bilgisayara bir şey kurmadan)**
1. Klasörü GitHub'a yükle (Render için zaten yükledin).
2. *Actions → Android APK → Run workflow*; kutuya Render adresini yaz (`https://ADIN.onrender.com`).
3. İş bitince sayfanın altındaki **Klipo-android** çıktısını indir: içinde `Klipo.apk` (telefona kurulum) ve `Klipo.aab` (Google Play) bulunur.
   Adresi her seferinde yazmamak için *Settings → Secrets and variables → Actions → Variables* altına `KLIPO_URL` ekleyebilirsin.

**B. Android Studio:** `android/` klasörünü aç, `android/gradle.properties` içindeki `klipoUrl` değerini kendi Render adresinle değiştir, *Build → Build APK(s)*.

**C. Kod gerektirmeden:** Telefonda Chrome ile siteyi aç → *Ana ekrana ekle* (PWA). Ya da siteyi [PWABuilder](https://www.pwabuilder.com) ile paketle.

**Telefona kurulum:** APK'yı indirip aç, "bilinmeyen kaynaklardan yüklemeye izin ver" uyarısını onayla.

**Google Play'e yüklemek istersen**
- Kendi imza anahtarını üret ve depo *Secrets* bölümüne `KEYSTORE_BASE64` (anahtar dosyasının base64'ü), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` olarak ekle; iş akışı bunları otomatik kullanır. Anahtar yoksa APK "debug" anahtarıyla imzalanır: telefona kurulur ama Play'e yüklenemez. Anahtarı kaybetme, güncellemeler aynı anahtarla yapılmalıdır.
- Play, `.aab` ister ve kullanıcı içeriği olan uygulamalarda şikâyet/engelleme araçları, gizlilik politikası ve içerik denetimi ister (bunların uygulama içi karşılığı var; gizlilik politikası metnini senin yazman gerekir). Yalnızca web sitesini saran uygulamalar "asgari işlevsellik" gerekçesiyle reddedilebilir; bu bir risk olarak kalır.
- Uygulama adı/paket adı: **Klipo** / `app.klipo.mobile` (`android/app/build.gradle`'dan değiştirilebilir).

## 4) Klasör yapısı

```
server.js            Express uygulaması, Render ayarları, başlatma
lib/                 yapılandırma, veritabanı, depolama (GridFS/disk + Range), servisler, ara katmanlar
routes/              auth, videos, stories, users, me, explore, chats, reports, admin
public/              arayüz (SPA), PWA dosyaları, ikonlar
android/             WebView sarmalayıcı proje (Gradle wrapper dahil)
.github/workflows/   APK/AAB derleme iş akışı
render.yaml          Render blueprint
scripts/             check.js (denetim), make-icons.py (ikon üretimi)
```

## 5) Güvenlik özeti

Oturum çerezi `httpOnly` + `sameSite=lax` (+ HTTPS'te `secure`), tüm yazma isteklerinde CSRF belirteci, giriş/kayıt/yükleme için hız sınırları, helmet CSP (satır içi betik yok), yükleme dosyalarının içerik imzasıyla doğrulanması, özel/engelli/gizli içerik için `/media` erişim denetimi, yönetici hesabının yalnızca gizli kodla açılması, askıya alınan hesapların oturumunun düşürülmesi.

## 6) Doğrulama durumu (dürüst not)

- Arayüz, gerçek tarayıcıda (headless Chromium) sunucuyu taklit eden bir test sunucusuyla uçtan uca denendi: 45/45 kontrol geçti (giriş/kayıt, akış, çift dokunuşla beğeni, yorum, hikâye, mesajlaşma, yükleme, ayarlar, yönetici paneli, CSRF yenileme, bakım modu…).
- Sunucu kodu bu ortamda **gerçek MongoDB ile çalıştırılmadı** (paket indirme engelliydi); sözdizimi, içe/dışa aktarma tutarlılığı ve elle inceleme ile denetlendi. İlk Render dağıtımında günlüklere (Logs) bakmanı ve `/healthz` ile bir kayıt/giriş/yükleme denemesi yapmanı öneririm.
- Android projesi derlenmedi (yukarıya bakın); ilk derlemede küçük bir Gradle/AGP uyarısı çıkarsa iş akışı günlüğü nedenini gösterir.
