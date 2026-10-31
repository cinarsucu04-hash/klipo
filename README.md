# Klipo

Kısa video paylaşım uygulaması (TikTok benzeri, farklı isim ve marka). Tek bir Node.js sunucusu hem API'yi hem de web arayüzünü (PWA) sunar. Aynı arayüz, `android/` klasöründeki sarmalayıcı ile APK olarak da paketlenir.

**Neler var?**
Sonsuz kaydırmalı Sana Özel / Takip / Yeni akışları · video yükleme (ilerleme çubuğu, kapak görseli) · beğeni, kaydet, paylaş · yorum, yanıt, yorum beğenisi, sabitleme · hashtag ve @bahsetme · 24 saatlik hikâyeler (görüntüleyenler, yanıt → mesaj) · birebir ve grup mesajlaşma (görsel, "görüldü", video kartları) · bildirimler · özel hesap ve takip istekleri · engelleme / şikâyet · arama, keşfet, trend etiketler · profil ziyaretçileri, izleme geçmişi, sabitlenmiş videolar · kısıtlı mod, açık/koyu tema · yönetici paneli (istatistik, şikâyetler, kullanıcılar, videolar, duyuru, bakım modu, yedek, günlük) · PWA (ana ekrana ekle, çevrimdışı sayfa) · **video düzenleyici**: videoya yazı ekleme (renk, boyut, arka plan, sürükleyerek konumlandırma) ve müzik ekleme (hazır 5 telifsiz ses + kendi yüklediğin ses, ses seviyesi ayarı) · **ses sayfası** (müziğe dokun → o sesi kullanan videolar, "Bu sesi kullan") · **İlgilenmiyorum** · **oynatma hızı** (0.5x–2x) · **anlık bildirimler** (izin penceresi, beğeni/yorum/takipçi/mesaj).

---

## 1) Render'a kurulum

1. **MongoDB Atlas** (ücretsiz M0): küme oluştur → *Database Access*'te kullanıcı ekle → *Network Access*'te `0.0.0.0/0` ekle (Render ücretsiz planda sabit IP yoktur) → *Connect → Drivers* ekranından bağlantı adresini kopyala.
2. Bu klasörün tamamını bir **GitHub deposuna** yükle (`.env` dosyasını yükleme).
3. Render'da **New → Blueprint** seç, depoyu göster. `render.yaml` servisi kendisi kurar. Sorulan değerler:

| Değişken | Açıklama |
|---|---|
| `MONGO_URL` | Atlas bağlantı adresi (zorunlu) |
| `SESSION_SECRET` | Render otomatik üretir; elle verirsen en az 32 karakter olsun |
| `ADMIN_USERNAMES` | Yönetici olacak kullanıcı adları, virgülle (varsayılan `admin`). Bu adla **ilk kaydolan** yönetici olur |
| `DB_NAME` | Veritabanı adı (varsayılan `klipo`) |
| `STORAGE` | `gridfs` (varsayılan, dosyalar MongoDB'de) veya `disk` (Render kalıcı disk bağlıysa) |
| `MAX_VIDEO_MB` / `MAX_IMAGE_MB` | Yükleme sınırları (60 / 8) |
| `MAX_AUDIO_MB` | Yüklenen müzik sınırı (8) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | İsteğe bağlı; verilmezse anahtarlar otomatik üretilip veritabanına kaydedilir |
| `MAX_ACCOUNTS_PER_IP` | Aynı ağdan açılabilecek hesap sayısı (3). Yönetim panelinden de değiştirilir |
| `GOOGLE_CLIENT_ID` | İsteğe bağlı: "Google ile devam et" için (aşağıya bak) |
| `KEEP_ALIVE` | `0` yaparsan kendi kendine ping atmayı kapatır |

4. Dağıtım bitince `https://ADIN.onrender.com/healthz` adresi `{"ok":true,"db":true,…}` döndürmeli.
5. **Yönetici hesabı:** siteyi açar açmaz *Kayıt ol* → kullanıcı adı `admin` (kendi şifrenle). Ek kod istenmez; bu adla ilk kaydolan kişi yönetici olur, bu yüzden bunu **linki kimseye vermeden önce** yap. Sonra *Ayarlar → Yönetim paneli*.

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

**Play Store olmadan dağıtım (ücretsiz)**
1. İş akışından çıkan `Klipo.apk` dosyasını depodaki `public/` klasörüne yükle (GitHub: `public` klasörüne gir → *Add file → Upload files*).
2. Render yeniden kurulunca `https://ADIN.onrender.com/indir.html` sayfası hazırdır: Android için indirme düğmesi, iPhone için "Ana Ekrana Ekle" anlatımı içerir. Linki WhatsApp, Instagram biyografisi vb. yerlerde paylaş. Giriş ekranında da "Uygulamayı indir" bağlantısı görünür.
3. Web arayüzü sunucudan geldiği için sunucu/arayüz güncellemelerinde APK'yı yeniden dağıtmana gerek yoktur. APK yalnızca uygulama adresi veya Android kodu değişirse yenilenir.

**Google Play'e yüklemek istersen (şu an yapılmadı)**
- Play Console hesabı tek seferlik ücretlidir (kayıt ekranında güncel tutar yazar). Kişisel hesaplarda yayına çıkmadan önce **en az 12 test kullanıcısının 14 gün kesintisiz** kapalı testte kalması gerekir.
- Play, 31 Ağustos 2026'dan beri yeni uygulamaların **Android 16 (API 36)** hedeflemesini ister. Bu proje şu an API 34'e göre ayarlıdır; Play'e gitmeden önce `android/` klasörü güncellenmelidir (Android Gradle eklentisi 8.13 + Gradle 8.13 + ekrandan ekrana çizim düzenlemesi).
- Yüklenecek `.aab` dosyası **release anahtarıyla** imzalanmalıdır; debug anahtarı Play'de reddedilir. Anahtarı sakla, kaybolursa güncelleme çıkaramazsın.
- Gizlilik politikası adresi, veri güvenliği formu, içerik derecelendirmesi ve hesap silme bilgisi gerekir. Yalnızca siteyi saran uygulamalar "asgari işlevsellik" gerekçesiyle reddedilebilir; bu bir risk olarak kalır.

## Düzenleyici ve bildirimler (bilmen gerekenler)

- Yazı ve müzik videonun dosyasına **işlenmez**; yüklenen video olduğu gibi saklanır, yazı/müzik oynatırken Klipo içinde üstüne bindirilir. Bu yüzden indirilen/başka yerde paylaşılan videoda yazı ve müzik görünmez. Kendi yüklediğin müziğin telif sorumluluğu sana aittir.
- iPhone'da videonun kendi ses seviyesi ayarı çalışmaz (iOS izin vermez).
- Web bildirimleri tarayıcıda ve Ana Ekrana eklenen PWA'da çalışır; iPhone'da yalnızca Ana Ekrana ekledikten sonra. **APK içindeki WebView Web Push desteklemez**; APK'da bildirimler yerel olarak ~15 dakikada bir kontrol edilir (gecikmeli gelir). Bunun için APK'yı yeniden derleyip yeniden kurmak gerekir.
- Bu bildirim ve Android kodu gerçek servislerle/derlemeyle denenmedi.

## Güvenlik özellikleri

- **Küfür / tehdit filtresi:** yorum, video açıklaması, videoya eklenen yazılar, mesajlar, hikâye açıklaması, biyografi, görünen ad, kullanıcı adı ve ses adlarında çalışır. Türkçe ve İngilizce küfürleri, harf aralı (s.i.k) ve rakamlı (s1k) yazımları yakalar; "şikayet", "sıkışık", "götürdü" gibi masum kelimelere takılmaz. Yorumlarda telefon/IBAN paylaşımı ve yeni hesapların (ilk 24 saat) bağlantı eklemesi de engellenir. 24 saatte yeterince ihlal toplayan hesap otomatik geçici askıya alınır (1 saat → 1 gün → 7 gün → 30 gün). Yönetici panelinde *Güvenlik* sekmesinden özel yasaklı kelime ekleyebilir ve takılanları görebilirsin. **Videonun görüntüsü/sesi taranmaz**; bunun için şikayet sistemi vardır: aynı videoyu 5 farklı kişi şikayet ederse video yönetici bakana kadar otomatik gizlenir.
- **Ağ başına hesap sınırı:** aynı IP'den en fazla 3 hesap açılabilir (IPv6'da /64 ağı tek sayılır). IP adresleri düz yazı olarak değil, geri döndürülemez özet olarak saklanır; panelde yalnızca son 5 hanesi görünür. **Dikkat:** aynı Wi-Fi'yi paylaşan aile/okul ya da mobil operatörlerin ortak IP'sini kullananlar bu sınıra takılabilir; çok şikayet gelirse *Güvenlik* sekmesinden sayıyı artır.
- **Hesap türü:** kayıtta ve Ayarlar'da *Gerçek hesap* / *RP hesabı* seçilir; RP hesapların profilinde etiket görünür.
- **Banlar:** yönetici *Kullanıcılar* sekmesinden 1/7/30 gün ya da süresiz askıya alabilir; istersen aynı anda kişinin IP'sini de yasaklar (siteye giremez, yeni hesap açamaz). IP yasakları *Güvenlik* sekmesinde kullanıcı adı ya da elle IP ile eklenir/kaldırılır. Yöneticiler ve kendi IP'n yasaklanamaz. Süreli askı dolunca hesap kendiliğinden açılır.
- **Giriş güvenliği:** 5 hatalı şifreden sonra hesap 15 dakika kilitlenir; yeni şifreler en az 8 karakter, harf+rakam olmalı ve yaygın şifreler reddedilir; şifre değişince diğer cihazlardaki oturumlar kapanır; *Ayarlar → Tüm cihazlardan çıkış yap*.
- **Google ile devam et (isteğe bağlı):** [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → *OAuth istemci kimliği* → tür *Web uygulaması*; *Yetkili JavaScript kaynakları*na Render adresini (`https://ADIN.onrender.com`) ekle; çıkan **İstemci Kimliği**ni Render'da `GOOGLE_CLIENT_ID` olarak gir. Ayarlanmazsa düğme görünmez. Google'dan açılan hesap otomatik kullanıcı adı alır, ilk girişte kendi adını seçer. Android uygulamasında (Google, gömülü tarayıcıdan girişe izin vermediği için) giriş sistem tarayıcısında yapılır ve uygulamaya otomatik döner; bunun için APK'nın yeniden derlenmesi gerekir.

## E-posta doğrulaması, captcha ve şifre sıfırlama

- **Kayıt:** kullanıcı Gmail adresini yazar, e-postasına **6 haneli kod** gelir (10 dakika geçerli, 5 deneme, 60 sn'de bir yeniden gönderme). Kod her kayıt için rastgele üretilir; kimseyle aynı olmaz, veritabanında düz yazı olarak tutulmaz. Aynı Gmail'in nokta/`+etiket` varyantlarıyla ikinci hesap açılamaz. Varsayılan olarak yalnızca `gmail.com` kabul edilir (`ALLOWED_EMAIL_DOMAINS` ile değiştirilir).
- **Captcha:** kayıt, giriş (3 hatadan sonra), şifre sıfırlama ve kod isteme ekranlarında resimli güvenlik kodu istenir. Kendi içinde çalışır, ek hesap gerekmez; basit bir koruma olduğundan gelişmiş botlara karşı tam çözüm değildir.
- **Şifremi unuttum:** giriş ekranından e-postaya gelen kodla yeni şifre belirlenir; diğer cihazların oturumları kapanır. **E-postası olmayan eski hesaplar** bu özelliği kullanamaz (henüz "e-posta ekle" ekranı yok).
- **E-posta gönderimi (Render ücretsiz plan SMTP'yi engeller, bu yüzden hepsi HTTPS API'dir).** Birini seç, Render → Environment'a gir:
  - **Brevo (en kolayı):** brevo.com'da ücretsiz hesap (günde 300 e-posta) → *SMTP & API → API keys* → `BREVO_API_KEY`, ayrıca `MAIL_FROM` (doğrulanmış gönderen adres). Alan adın yoksa gönderen olarak Gmail adresini kullanırsan mesajlar **spam'e düşebilir ya da reddedilebilir**.
  - **Gmail API (alan adı gerekmez, en güvenilir):** Google Cloud'da Gmail API'yi açıp OAuth istemcisi ve *refresh token* üret; `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `MAIL_FROM` (aynı Gmail). Kurulumu telefondan zordur.
  - **Resend:** kendi alan adın varsa `RESEND_API_KEY` + `MAIL_FROM`.
  - Hiçbiri ayarlı değilse kayıt **e-posta doğrulaması olmadan**, yalnızca captcha ile çalışmaya devam eder. `EMAIL_VERIFY=0` doğrulamayı bilerek kapatır.

## TikTok'taki özellikler

- **Düet:** videonun `⋯` menüsünden *Düet yap*; kendi videon özgün videonun yanında yan yana oynar. Düet için özgün video herkese açık olmalı ve sahibi izin vermiş olmalı (yüklerken / *Düzenle*'den kapatılır). Düet videosu tekrar düet yapılamaz; özgün video silinirse düet normal video olarak kalır.
- **Filtreler:** yüklerken 7 filtre (canlı, sıcak, soğuk, siyah-beyaz, nostalji, dramatik, parlak). Yazı ve müzik gibi **dosyaya işlenmez**, oynatırken uygulanır.
- **Arkadaşlar akışı:** karşılıklı takipleştiğin kişilerin videoları (ana ekranda *Arkadaşlar* sekmesi).
- **Temiz ekran:** videoya basılı tut, arayüz kaybolur; dokununca geri gelir.
- **Otomatik kaydır:** `⋯` menüsünden aç/kapat; video bitince sıradakine geçer.
- **İndirme izni:** videoyu sahibi *Düzenle*'den indirmeye kapatabilir. İndirilen dosya orijinal videodur (yazı/müzik/filtre içermez). Bu izin yalnızca arayüzde engellenir; teknik olarak dosyaya erişimi olan biri yine alabilir.
- **Yaratıcı analizi:** *Ayarlar → Yaratıcı analizi*: toplam izlenme/beğeni/yorum/paylaşım/takipçi, son 7 günün grafikleri ve en çok izlenen 5 video.
- Canlı yayın yoktur.

## "Workspace suspended / free bandwidth" (Render bant genişliği)

Render'ın ücretsiz (Hobby) çalışma alanında **giden internet trafiği (bant genişliği) 5 GB/ay** ile sınırlı; aşılırsa çalışma alanı **askıya alınır** ve site hiç açılmaz ("Workspace suspended. You've used the 5 GB of free bandwidth…"). Bu, MongoDB depolamasıyla ilgisizdir. Kısa video akışı en büyük trafik kaynağıdır.

- **Askıdayken ne olur:** Render panelinde servis *Suspended* görünür; yeni dağıtım ve "Rollback" çalışmaz (`could not roll back`). Seçenekler: (a) ay başında ücretsiz hakkın yenilenmesini beklemek (süre için Render'ın Billing/uyarı yazısına bak), (b) uyarıdaki **Remove usage limits** ile kart ekleyip aşan trafiği GB başına ücretle ödemek (güncel fiyatı Render gösterir), (c) başka bir barındırmaya geçmek.
- **Bu sürümde trafiği azaltan değişiklikler:**
  - Dış depo (S3) açıkken **herkese açık videolar Render'dan geçmeden doğrudan depodan oynar** (Render yalnızca küçük bir yönlendirme yapar). Kapatmak için `S3_REDIRECT=0`. Özel/takipçilere açık videolar, görseller ve sesler yine Render üzerinden akar.
  - Ana ekranda artık yalnızca izlenen video tam yüklenir; komşu videolar sadece üst bilgi yükler (eskiden ±2 video önden yükleniyordu).
- Dış depoda **çıkış (egress) ücretsiz** olan bir servis seç (Filebase, Cloudflare R2). Backblaze B2'de ücretsiz çıkış, depolamanın 3 katıyla sınırlıdır.
- Dosyaları MongoDB'den dış depoya kopyalarken Render'dan çıkan trafik (videoların toplam boyutu kadar) bir kez harcanır.

## Depolama doldu mu? (Atlas 512 MB)

Videolar varsayılan olarak MongoDB Atlas ücretsiz kümesinde (512 MB) saklanır. Dolunca Atlas yazmayı reddeder (`over your space quota`). Klipo bunu şöyle yönetir; **hiçbir hesap, video, yorum otomatik silinmez**:

- **Yönetim paneli → Depolama:** doluluk yüzdesi, MongoDB'deki / dış depodaki dosya sayıları, en büyük koleksiyonlar, bağlantı denemesi ve taşıma araçları. Genel sekmede %70'ten sonra uyarı çıkar.
- **Koruma:** doluluk `DB_GUARD_PCT` (varsayılan %92) eşiğini aşınca **yeni yüklemeler** nazik bir mesajla durdurulur; izleme, beğeni, yorum ve oturumlar için yer kalır. Mevcut içerik etkilenmez. `DB_QUOTA_MB` kotayı belirtir (varsayılan 512).
- **Dış depo (önerilen çözüm):** S3 uyumlu ücretsiz bir depo bağla; yeni videolar oraya gider, MongoDB dolmaz.
  1. Bir S3 uyumlu depoda hesap aç: **Filebase** (5 GB ücretsiz, sitesinde "kart gerekmez" yazıyor), Cloudflare **R2** (10 GB ücretsiz, genelde kart/PayPal ister) ya da Backblaze **B2** (10 GB ücretsiz, kart istenebilir). Koşulları sitesinden doğrula. Bir *bucket* oluştur (herkese açık yapma) ve okuma+yazma yetkili bir S3 API anahtarı üret.
  2. Render → Environment: `S3_ENDPOINT` (Filebase: `https://s3.filebase.io`, R2: `https://<hesap-kimliği>.r2.cloudflarestorage.com`, B2: `https://s3.<bölge>.backblazeb2.com`), `S3_BUCKET`, `S3_KEY_ID`, `S3_SECRET` (R2 ve Filebase'de ayrıca `S3_REGION=auto`). Hepsi doluysa yeni yüklemeler otomatik dış depoya gider.
  3. Panelde **Bağlantıyı dene** → **Kopyala** (MongoDB'deki dosyaları dış depoya kopyalar, **hiçbir şey silinmez**) → **MongoDB'de yer aç** (kopyası bayt bayt doğrulanan dosyaların MongoDB'deki nüshasını kaldırır; videolar dış depodan oynar; doğrulanamayan dosyaya dokunulmaz; onay için `EVET` yazılır).
- **Uygulama açılmıyorsa:** Atlas dolunca yazmayı reddeder; eski sürümde bu, uygulamanın hiç açılmamasına yol açıyordu. Bu sürümde oturumlar depolama doluyken geçici olarak bellekte tutulur (sunucu yeniden başlayınca girişin düşer), açılışta dizin hataları yok sayılır, izleme/arama kayıtları yazılamasa da akış çalışır. Yani yönetici girip panele ulaşabilir; yeni içerik yüklemek/beğenmek gibi yazma işlemleri ise yer açılana kadar "depolama dolu" mesajı verir.
- **Panele yine de giremiyorsan:** Render'da `S3_*` değişkenlerinin yanına `STORAGE_MIGRATE=copy+free` ekle; sunucu açılışta kopyalar, doğrular, yer açar (günlüklerde `[depolama]` satırlarını izle). Bitince değişkeni sil. Yalnızca kopyalamak istersen `STORAGE_MIGRATE=copy`.
- **Sahipsiz dosyalar:** yarım kalan yüklemelerin MongoDB'de bıraktığı, hiçbir videoya bağlı olmayan (1 saatten eski) dosyalar panelde sayılır; *Sahipsiz dosyaları temizle* yalnızca onları siler.
- Yüklemeleri küçültmek için `MAX_VIDEO_MB` değerini düşürebilirsin (varsayılan 60).
- Render'ın kalıcı diski (ücretli plan) alternatifi: `STORAGE=disk` ve `UPLOAD_DIR` (diskin bağlandığı yol).

## 4) Klasör yapısı

```
server.js            Express uygulaması, Render ayarları, başlatma
lib/                 yapılandırma, veritabanı, depolama (GridFS/disk/S3 + Range), dış depo istemcisi, taşıma araçları, e-posta/captcha, servisler, ara katmanlar
routes/              auth, videos, stories, users, me, explore, chats, reports, admin
public/              arayüz (SPA), PWA dosyaları, ikonlar
android/             WebView sarmalayıcı proje (Gradle wrapper dahil)
.github/workflows/   APK/AAB derleme iş akışı
render.yaml          Render blueprint
scripts/             check.js (denetim), make-icons.py (ikon üretimi)
```

## 5) Güvenlik özeti

Oturum çerezi `httpOnly` + `sameSite=lax` (+ HTTPS'te `secure`), tüm yazma isteklerinde CSRF belirteci, giriş/kayıt/yükleme için hız sınırları, helmet CSP (satır içi betik yok), yükleme dosyalarının içerik imzasıyla doğrulanması, özel/engelli/gizli içerik için `/media` erişim denetimi, yönetici adının ilk kaydolan kişiye verilmesi (bu adı sen hemen al), askıya alınan hesapların oturumunun düşürülmesi.

## 6) Doğrulama durumu (dürüst not)

- Arayüz, gerçek tarayıcıda (headless Chromium) sunucuyu taklit eden bir test sunucusuyla uçtan uca denendi: 78/78 kontrol geçti (giriş/kayıt, akış, çift dokunuşla beğeni, yorum, hikâye, mesajlaşma, yükleme, ayarlar, yönetici paneli, CSRF yenileme, bakım modu…); ayrıca e-posta/captcha (14), yeni TikTok özellikleri (32) ve depolama paneli (20) için ayrı arayüz testleri geçti.
- Dış depo istemcisi AWS'nin yayımladığı imza test vektörleriyle doğrulandı; kopyalama/doğrulama/boşaltma, doluluk koruması ve Atlas `over your space quota` hatası yerel sahte S3 sunucusu ve sahte GridFS ile 48 kontrolde denendi. **Gerçek R2/B2 ve gerçek Atlas ile denenmedi**; ilk kullanımda panelde *Bağlantıyı dene* ve küçük bir *Kopyala* denemesi yap.
- Sunucu kodu bu ortamda **gerçek MongoDB ile çalıştırılmadı** (paket indirme engelliydi); sözdizimi, içe/dışa aktarma tutarlılığı ve elle inceleme ile denetlendi. İlk Render dağıtımında günlüklere (Logs) bakmanı ve `/healthz` ile bir kayıt/giriş/yükleme denemesi yapmanı öneririm.
- Android projesi derlenmedi (yukarıya bakın); ilk derlemede küçük bir Gradle/AGP uyarısı çıkarsa iş akışı günlüğü nedenini gösterir.
