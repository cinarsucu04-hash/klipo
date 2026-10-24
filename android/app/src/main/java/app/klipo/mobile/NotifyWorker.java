package app.klipo.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Arka planda sunucudaki okunmamış sayıları sorar; artış varsa bildirim gösterir. */
public class NotifyWorker extends Worker {

    public NotifyWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        if (!Notifier.enabled(ctx) || MainActivity.visible) return Result.success();

        HttpURLConnection conn = null;
        try {
            String cookie = CookieManager.getInstance().getCookie(BuildConfig.BASE_URL);
            if (cookie == null || cookie.isEmpty()) return Result.success(); // giriş yapılmamış

            conn = (HttpURLConnection) new URL(BuildConfig.BASE_URL + "/api/counters").openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return Result.success();

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 4096) out.write(buf, 0, n);
            }
            JSONObject o = new JSONObject(out.toString("UTF-8"));
            int notifications = o.optInt("notifications", 0);
            int messages = o.optInt("messages", 0);
            int requests = o.optInt("requests", 0);

            SharedPreferences sp = Notifier.prefs(ctx);
            int lastN = sp.getInt("lastN", -1);
            int lastM = sp.getInt("lastM", -1);
            int lastR = sp.getInt("lastR", -1);
            sp.edit().putInt("lastN", notifications).putInt("lastM", messages).putInt("lastR", requests).apply();
            if (lastN < 0 || lastM < 0 || lastR < 0) return Result.success(); // ilk ölçüm: sadece başlangıç değeri

            if (messages > lastM) {
                Notifier.show(ctx, messages == 1 ? "Yeni bir mesajın var" : messages + " okunmamış mesajın var", "/#/inbox");
            } else if (requests > lastR) {
                Notifier.show(ctx, "Yeni bir takip isteğin var", "/#/requests");
            } else if (notifications > lastN) {
                int add = notifications - lastN;
                Notifier.show(ctx, add == 1 ? "Yeni bir bildirimin var" : add + " yeni bildirimin var", "/#/inbox");
            }
        } catch (Exception e) {
            // ağ hatası: bir sonraki turda tekrar denenecek
        } finally {
            if (conn != null) conn.disconnect();
        }
        return Result.success();
    }
}
