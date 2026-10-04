package ai.soundwave.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * What the alarms need kept: the alarms themselves, the user's "briefing
 * starts N seconds after I turn off an alarm" setting, and whether a briefing
 * is waiting to be spoken. App-private SharedPreferences — the AlarmService
 * reads it from the background, without the WebView.
 */
final class AlarmStore {
    private static final String FILE = "soundwave_alarm";
    private static final String KEY_ALARMS = "alarms";
    private static final String KEY_BRIEFING_SECONDS = "briefingSeconds";
    private static final String KEY_PENDING_BRIEFING = "pendingBriefing";
    private static final String KEY_LAST_BRIEFING = "lastBriefingAt";
    private static final String KEY_RINGING = "ringing";
    private static final String KEY_EARBUDS = "useEarbuds";

    static final int DEFAULT_BRIEFING_SECONDS = 30;
    static final int MAX_BRIEFING_SECONDS = 600;
    /** Two triggers within this window are the same briefing (the countdown and the timer). */
    static final long BRIEFING_DEDUPE_MS = 120_000;

    static final class Alarm {
        final String id;
        final long at;
        final String label;
        final int briefingAfterSeconds;

        Alarm(String id, long at, String label, int briefingAfterSeconds) {
            this.id = id;
            this.at = at;
            this.label = label == null ? "" : label;
            this.briefingAfterSeconds = briefingAfterSeconds;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("at", at);
            o.put("label", label);
            o.put("briefingAfterSeconds", briefingAfterSeconds);
            return o;
        }

        static Alarm fromJson(JSONObject o) {
            return new Alarm(
                    o.optString("id", "alarm-" + o.optLong("at", 0)),
                    o.optLong("at", 0),
                    o.optString("label", ""),
                    clampSeconds(o.optInt("briefingAfterSeconds", DEFAULT_BRIEFING_SECONDS)));
        }
    }

    private AlarmStore() {
    }

    static int clampSeconds(int seconds) {
        return Math.max(0, Math.min(MAX_BRIEFING_SECONDS, seconds));
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The alarms still to ring (old ones are dropped), soonest first. */
    static List<Alarm> alarms(Context c) {
        List<Alarm> out = new ArrayList<>();
        long now = System.currentTimeMillis();
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY_ALARMS, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Alarm a = Alarm.fromJson(o);
                if (a.at > now - 5 * 60_000L) out.add(a);
            }
        } catch (JSONException ignored) {
            // a corrupted list is no list
        }
        out.sort((a, b) -> Long.compare(a.at, b.at));
        return out;
    }

    static void save(Context c, List<Alarm> alarms) {
        JSONArray arr = new JSONArray();
        for (Alarm a : alarms) {
            try {
                arr.put(a.toJson());
            } catch (JSONException ignored) {
                // skipped
            }
        }
        prefs(c).edit().putString(KEY_ALARMS, arr.toString()).apply();
    }

    static Alarm add(Context c, long at, String label, int briefingAfterSeconds) {
        List<Alarm> list = alarms(c);
        Alarm alarm = new Alarm("alarm-" + at, at, label, clampSeconds(briefingAfterSeconds));
        list.add(alarm);
        save(c, list);
        return alarm;
    }

    static Alarm find(Context c, String id) {
        for (Alarm a : alarms(c)) {
            if (a.id.equals(id)) return a;
        }
        return null;
    }

    static boolean remove(Context c, String id) {
        List<Alarm> list = alarms(c);
        boolean removed = list.removeIf((a) -> a.id.equals(id));
        if (removed) save(c, list);
        return removed;
    }

    static int briefingSeconds(Context c) {
        return clampSeconds(prefs(c).getInt(KEY_BRIEFING_SECONDS, DEFAULT_BRIEFING_SECONDS));
    }

    static void setBriefingSeconds(Context c, int seconds) {
        prefs(c).edit().putInt(KEY_BRIEFING_SECONDS, clampSeconds(seconds)).apply();
    }

    /** An alarm was turned off: the briefing should start when the app next runs. */
    static boolean isBriefingPending(Context c) {
        return prefs(c).getBoolean(KEY_PENDING_BRIEFING, false);
    }

    static void setBriefingPending(Context c, boolean pending) {
        prefs(c).edit().putBoolean(KEY_PENDING_BRIEFING, pending).apply();
    }

    /** Ring on the Bluetooth earbuds when they're connected (on unless the person turns it off). */
    static boolean useEarbuds(Context c) {
        return prefs(c).getBoolean(KEY_EARBUDS, true);
    }

    static void setUseEarbuds(Context c, boolean on) {
        prefs(c).edit().putBoolean(KEY_EARBUDS, on).apply();
    }

    /** The alarm ringing now (so Turn off / Snooze work without an id). */
    static String ringingId(Context c) {
        String id = prefs(c).getString(KEY_RINGING, null);
        return id == null || id.isEmpty() ? null : id;
    }

    static void setRinging(Context c, String id) {
        prefs(c).edit().putString(KEY_RINGING, id == null ? "" : id).apply();
    }

    /** True when this trigger is the one that should speak (the first in a while). */
    static boolean claimBriefing(Context c) {
        long now = System.currentTimeMillis();
        long last = prefs(c).getLong(KEY_LAST_BRIEFING, 0);
        if (now - last < BRIEFING_DEDUPE_MS) return false;
        prefs(c).edit().putLong(KEY_LAST_BRIEFING, now).apply();
        return true;
    }
}
