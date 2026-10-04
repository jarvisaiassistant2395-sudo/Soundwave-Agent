package ai.soundwave.companion;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * The Soundwave voices on the phone itself, for when the PC is off: Microsoft's
 * neural voices through the same service and protocol the PC uses
 * (server/src/lib/edgeTts.ts). A WebView can't open this WebSocket — the
 * service wants an Origin header and a cookie a web page isn't allowed to set
 * — so it's done here, natively: synthesize({ text, voice, rate }) → { audio:
 * base64 MP3, mime }. Keep the constants in step with edgeTts.ts.
 */
@CapacitorPlugin(name = "EdgeTts")
public class EdgeTtsPlugin extends Plugin {
    private static final String TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    private static final String CHROMIUM_FULL_VERSION = "143.0.3650.75";
    private static final String CHROMIUM_MAJOR = "143";
    private static final String WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
    private static final String ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
    private static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
        + CHROMIUM_MAJOR + ".0.0.0 Safari/537.36 Edg/" + CHROMIUM_MAJOR + ".0.0.0";
    private static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
    private static final long WIN_EPOCH_SECONDS = 11644473600L;
    private static final Pattern VOICE_ID = Pattern.compile("^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9-]*Neural$");
    private static final Pattern RATE = Pattern.compile("^[+-]\\d{1,2}%$");

    /** Seconds to add to the phone's clock (learned from the service's Date header on a 403). */
    private static volatile double clockSkewSeconds = 0;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build();
    private final SecureRandom random = new SecureRandom();

    /** The service refused the WebSocket upgrade (e.g. 403 when the clock is off). */
    static final class HandshakeException extends Exception {
        final int status;
        final String serverDate;

        HandshakeException(int status, String serverDate) {
            super("Microsoft's voice service refused the connection (HTTP " + status + ").");
            this.status = status;
            this.serverDate = serverDate;
        }
    }

    @PluginMethod
    public void synthesize(final PluginCall call) {
        final String text = call.getString("text", "");
        String voice = call.getString("voice", "en-US-GuyNeural");
        String rate = call.getString("rate", "-5%");
        final String base = call.getString("url", WSS_URL);
        if (text == null || text.trim().isEmpty()) {
            call.reject("Nothing to say.");
            return;
        }
        if (voice == null || !VOICE_ID.matcher(voice).matches()) voice = "en-US-GuyNeural";
        if (rate == null || !RATE.matcher(rate).matches()) rate = "-5%";
        final String finalVoice = voice;
        final String finalRate = rate;
        new Thread(() -> {
            try {
                byte[] mp3 = synthesizeWithRetry(text, finalVoice, finalRate, base);
                JSObject ret = new JSObject();
                ret.put("audio", Base64.encodeToString(mp3, Base64.NO_WRAP));
                ret.put("mime", "audio/mpeg");
                ret.put("bytes", mp3.length);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Microsoft's voice service didn't answer.");
            }
        }, "soundwave-edge-tts").start();
    }

    private byte[] synthesizeWithRetry(String text, String voice, String rate, String base) throws Exception {
        try {
            return synthesizeOnce(text, voice, rate, base);
        } catch (HandshakeException e) {
            // A 403 usually means the phone's clock is off (the token is time-based): retry with the service's clock.
            if (e.status == 403 && adjustClockSkew(e.serverDate)) return synthesizeOnce(text, voice, rate, base);
            throw e;
        }
    }

    private byte[] synthesizeOnce(final String text, final String voice, final String rate, String base) throws Exception {
        String connectionId = UUID.randomUUID().toString().replace("-", "");
        String url = base + "?TrustedClientToken=" + TRUSTED_CLIENT_TOKEN
            + "&ConnectionId=" + connectionId
            + "&Sec-MS-GEC=" + secMsGec()
            + "&Sec-MS-GEC-Version=1-" + CHROMIUM_FULL_VERSION;
        Request request = new Request.Builder()
            .url(url)
            .header("Origin", ORIGIN)
            .header("User-Agent", USER_AGENT)
            .header("Pragma", "no-cache")
            .header("Cache-Control", "no-cache")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cookie", "muid=" + randomHex(16) + ";")
            .build();

        final ByteArrayOutputStream audio = new ByteArrayOutputStream();
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicReference<Exception> failure = new AtomicReference<>();
        final String timestamp = edgeTimestamp(new Date());

        WebSocket socket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                ws.send("X-Timestamp:" + timestamp + "\r\n"
                    + "Content-Type:application/json; charset=utf-8\r\n"
                    + "Path:speech.config\r\n\r\n"
                    + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{"
                    + "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},"
                    + "\"outputFormat\":\"" + OUTPUT_FORMAT + "\"}}}}\r\n");
                ws.send("X-RequestId:" + UUID.randomUUID().toString().replace("-", "") + "\r\n"
                    + "Content-Type:application/ssml+xml\r\n"
                    + "X-Timestamp:" + timestamp + "Z\r\n"
                    + "Path:ssml\r\n\r\n"
                    + ssml(text, voice, rate));
            }

            @Override
            public void onMessage(WebSocket ws, String message) {
                if (message.contains("Path:turn.end")) {
                    done.countDown();
                    ws.close(1000, null);
                }
            }

            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                byte[] b = bytes.toByteArray();
                if (b.length < 2) return;
                int headerLength = ((b[0] & 0xff) << 8) | (b[1] & 0xff);
                if (2 + headerLength > b.length) return;
                String headers = new String(b, 2, headerLength, StandardCharsets.UTF_8);
                if (!headers.contains("Path:audio")) return;
                synchronized (audio) {
                    audio.write(b, 2 + headerLength, b.length - 2 - headerLength);
                }
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (response != null && response.code() != 101) {
                    failure.set(new HandshakeException(response.code(), response.header("Date")));
                } else {
                    failure.set(new Exception("Couldn't reach Microsoft's voice service: " + (t.getMessage() != null ? t.getMessage() : t.toString())));
                }
                done.countDown();
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                done.countDown();
            }
        });

        if (!done.await(45, TimeUnit.SECONDS)) {
            socket.cancel();
            throw new Exception("Microsoft's voice service didn't answer in time.");
        }
        synchronized (audio) {
            if (audio.size() > 0) return audio.toByteArray();
        }
        if (failure.get() != null) throw failure.get();
        throw new Exception("No audio came back for the voice " + voice + ".");
    }

    /** Sec-MS-GEC: SHA-256 of (Windows file-time ticks rounded down to 5 minutes + client token). */
    private static String secMsGec() throws Exception {
        long seconds = (long) Math.floor(System.currentTimeMillis() / 1000.0 + clockSkewSeconds) + WIN_EPOCH_SECONDS;
        long ticks = seconds * 10_000_000L;
        long rounded = ticks - (ticks % 3_000_000_000L);
        byte[] hash = MessageDigest.getInstance("SHA-256").digest((rounded + TRUSTED_CLIENT_TOKEN).getBytes(StandardCharsets.US_ASCII));
        StringBuilder hex = new StringBuilder();
        for (byte x : hash) hex.append(String.format(Locale.US, "%02X", x));
        return hex.toString();
    }

    private static boolean adjustClockSkew(String serverDate) {
        if (serverDate == null) return false;
        try {
            SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
            Date server = f.parse(serverDate);
            if (server == null) return false;
            clockSkewSeconds = (server.getTime() - System.currentTimeMillis()) / 1000.0;
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** "Sun Sep 28 2026 01:07:42 GMT+0000 (Coordinated Universal Time)" — the format Edge sends. */
    private static String edgeTimestamp(Date d) {
        SimpleDateFormat f = new SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(d) + " GMT+0000 (Coordinated Universal Time)";
    }

    private String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        StringBuilder hex = new StringBuilder();
        for (byte x : b) hex.append(String.format(Locale.US, "%02X", x));
        return hex.toString();
    }

    private static String ssml(String text, String voice, String rate) {
        String lang = "en-US";
        Matcher m = Pattern.compile("^[a-z]{2,3}-[A-Z]{2,3}").matcher(voice);
        if (m.find()) lang = m.group();
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'>"
            + "<voice name='" + longVoiceName(voice) + "'>"
            + "<prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>"
            + withSentencePauses(escapeXml(text))
            + "</prosody></voice></speak>";
    }

    /**
     * A small pause at every sentence end — the same trick the PC's voice uses
     * (server/src/lib/edgeTts.ts, withSentencePauses) so the phone's offline
     * speech sounds like the same narrator.
     */
    static String withSentencePauses(String escaped) {
        return escaped.replaceAll("([.!?])\\s+(?=[^<])", "$1 <break time=\"170ms\"/> ");
    }

    /** "en-US-GuyNeural" → "Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)". */
    static String longVoiceName(String voice) {
        Matcher m = Pattern.compile("^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$").matcher(voice);
        if (!m.matches()) return voice;
        String region = m.group(2);
        String name = m.group(3);
        int dash = name.indexOf('-');
        if (dash != -1) {
            region = region + "-" + name.substring(0, dash);
            name = name.substring(dash + 1);
        }
        return "Microsoft Server Speech Text to Speech Voice (" + m.group(1) + "-" + region + ", " + name + ")";
    }

    private static String escapeXml(String text) {
        return text
            .replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", " ")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;");
    }
}
