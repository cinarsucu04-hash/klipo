package app.klipo.mobile;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Klipo Android sarmalayıcısı: Render üzerindeki web uygulamasını tam ekran WebView içinde açar.
 * Oturum çerezleri kalıcıdır, dosya/video seçimi, geri tuşu ve paylaşılan bağlantılar desteklenir.
 */
public class MainActivity extends AppCompatActivity {

    private static final String BG = "#0A0A0F";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private String baseHost;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        baseHost = Uri.parse(BuildConfig.BASE_URL).getHost();

        // Dosya seçici sonucu (video/fotoğraf yükleme)
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (filePathCallback == null) return;
                    Uri[] uris = WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData());
                    filePathCallback.onReceiveValue(uris);
                    filePathCallback = null;
                });

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(android.graphics.Color.parseColor(BG));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(webView);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // videolar kullanıcı dokunuşu beklemeden oynasın
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " KlipoApp/" + BuildConfig.VERSION_NAME);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternallyIfNeeded(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOffline(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // WebView süreci bellek yüzünden kapandıysa uygulamayı sessizce yeniden başlat
                recreate();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;

                Intent intent = params.createIntent();
                String[] types = params.getAcceptTypes();
                // <input capture> + video → doğrudan kamera uygulamasını aç
                if (params.isCaptureEnabled() && types != null && types.length > 0 && types[0] != null && types[0].startsWith("video")) {
                    intent = new Intent(MediaStore.ACTION_VIDEO_CAPTURE);
                }
                try {
                    fileChooserLauncher.launch(intent);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Dosya seçici açılamadı", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // Yönetici yedeği gibi indirmeler
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                req.addRequestHeader("User-Agent", userAgent);
                req.setMimeType(mimeType);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mimeType));
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "İndiriliyor…", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "İndirme başlatılamadı", Toast.LENGTH_SHORT).show();
            }
        });

        // Geri tuşu: önce web uygulaması (açık pencere / önceki sayfa), son çare arka plana at
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript(
                        "(function(){try{return !!(window.K&&window.K.handleBack&&window.K.handleBack());}catch(e){return false;}})()",
                        value -> {
                            if (!"true".equals(value)) moveTaskToBack(true);
                        });
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            String start = BuildConfig.BASE_URL;
            Uri deep = deepLink(getIntent());
            if (deep != null) start = deep.toString();
            webView.loadUrl(start);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri deep = deepLink(intent);
        if (deep != null && webView != null) webView.loadUrl(deep.toString());
    }

    /** Yalnızca kendi alan adımıza ait https bağlantılarını kabul eder. */
    private Uri deepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null || data.getHost() == null || !data.getHost().equalsIgnoreCase(baseHost)) return null;
        if (!"https".equalsIgnoreCase(data.getScheme())) return null;
        return data;
    }

    /** Kendi sitemiz dışındaki bağlantılar tarayıcıda / ilgili uygulamada açılır. */
    private boolean openExternallyIfNeeded(Uri uri) {
        String scheme = uri.getScheme();
        if ("file".equals(scheme)) return false; // yerel çevrimdışı sayfa
        if (("https".equals(scheme) || "http".equals(scheme)) && uri.getHost() != null && uri.getHost().equalsIgnoreCase(baseHost)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // açacak uygulama yok; sessizce yoksay
        }
        return true;
    }

    private void showOffline(WebView view) {
        view.loadUrl("file:///android_asset/offline.html?u=" + Uri.encode(BuildConfig.BASE_URL));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        if (webView != null) webView.onPause(); // arka planda video/ses çalmasın
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
