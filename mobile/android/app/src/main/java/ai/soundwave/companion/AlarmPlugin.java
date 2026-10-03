package ai.soundwave.companion;

import android.Manifest;
import android.app.Activity;
import android.media.AudioManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Alarms on this phone, set by the agent (mobile/src/lib/alarm.ts is the app's
 * side). schedule → a real alarm-clock alarm through AlarmManager; the phone
 * rings with its own alarm screen, and when it's turned off the morning
 * briefing starts after the user's delay. The alarms live in SharedPreferences
 * (AlarmStore) and are re-armed after a reboot (AlarmReceiver), so they work
 * with the app closed and the PC off.
 */
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {
    private static final int NOTIFICATION_REQUEST = 7301;
    private static AlarmPlugin instance;
    private static volatile boolean appOnScreen = false;

    /** MainActivity tells us in onResume/onPause: the app is (or isn't) on screen. */
    static void setAppOnScreen(boolean onScreen) {
        appOnScreen = onScreen;
    }

    /** True while the app is on screen — then the briefing can start without a notification. */
    static boolean appInForeground() {
        return appOnScreen;
    }

    @Override
    public void load() {
        instance = this;
        AlarmNotifications.ensureChannels(getContext());
    }

    /** The system (or the alarm service) says the briefing is due: tell the app, if it's running. */
    static void emitBriefingDue(android.content.Context context) {
        AlarmPlugin plugin = instance;
        if (plugin == null) return;
        try {
            Activity activity = plugin.getActivity();
            if (activity == null) return;
            activity.runOnUiThread(() -> {
                try {
                    plugin.notifyListeners("briefingDue", new JSObject());
                } catch (Exception ignored) {
                    // the app is gone: the pending flag covers it
                }
            });
        } catch (Exception ignored) {
            // same
        }
    }

    private static JSObject json(AlarmStore.Alarm alarm) {
        JSObject o = new JSObject();
        o.put("id", alarm.id);
        o.put("at", alarm.at);
        o.put("label", alarm.label);
        o.put("briefingAfterSeconds", alarm.briefingAfterSeconds);
        return o;
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        Long at = call.getLong("at");
        if (at == null || at <= 0) {
            call.reject("No alarm time.");
            return;
        }
        String label = call.getString("label", "");
        Integer seconds = call.getInt("briefingAfterSeconds");
        int delay = seconds == null ? AlarmStore.briefingSeconds(getContext()) : AlarmStore.clampSeconds(seconds);
        AlarmStore.Alarm alarm = AlarmStore.add(getContext(), at, label == null ? "" : label, delay);
        AlarmScheduler.schedule(getContext(), alarm);
        call.resolve(json(alarm));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        AlarmStore.Alarm alarm = id == null ? null : AlarmStore.find(getContext(), id);
        boolean cancelled = false;
        if (alarm != null) {
            AlarmScheduler.cancel(getContext(), alarm);
            cancelled = AlarmStore.remove(getContext(), id);
        }
        JSObject result = new JSObject();
        result.put("cancelled", cancelled);
        call.resolve(result);
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray alarms = new JSArray();
        for (AlarmStore.Alarm alarm : AlarmStore.alarms(getContext())) {
            try {
                alarms.put(json(alarm));
            } catch (Exception ignored) {
                // org.json's checked exception; an alarm we can't serialize is skipped
            }
        }
        JSObject result = new JSObject();
        result.put("alarms", alarms);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getBriefingDelay(PluginCall call) {
        JSObject result = new JSObject();
        result.put("seconds", AlarmStore.briefingSeconds(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void setBriefingDelay(PluginCall call) {
        Integer seconds = call.getInt("seconds");
        int value = AlarmStore.clampSeconds(seconds == null ? AlarmStore.DEFAULT_BRIEFING_SECONDS : seconds);
        AlarmStore.setBriefingSeconds(getContext(), value);
        JSObject result = new JSObject();
        result.put("seconds", value);
        call.resolve(result);
    }

    /** True once when an alarm was turned off and the briefing is waiting to be spoken. */
    @PluginMethod
    public void consumePendingBriefing(PluginCall call) {
        boolean due = AlarmStore.isBriefingPending(getContext());
        if (due) AlarmStore.setBriefingPending(getContext(), false);
        JSObject result = new JSObject();
        result.put("due", due);
        call.resolve(result);
    }

    /** Where the alarm will ring right now: the earbuds' name (or none) and the preference. */
    @PluginMethod
    public void audioOutput(PluginCall call) {
        JSObject result = new JSObject();
        String earbuds = AlarmAudio.earbudsName(getContext());
        if (earbuds != null) result.put("bluetooth", earbuds);
        // A Bluetooth output that sits in someone's ears being *connected* is not
        // the same as it being a usable audio route — say both, so the app can be
        // honest instead of promising the sound is in the earbuds.
        result.put("earbudsConnected", AlarmAudio.earbuds(getContext()) != null);
        result.put("useEarbuds", AlarmStore.useEarbuds(getContext()));
        // Where the last ring really went (the alarm screen reads this too).
        String lastRoute = AlarmAudio.routeLabel();
        if (lastRoute != null) result.put("lastRoute", lastRoute);
        call.resolve(result);
    }

    /** Ring on the Bluetooth earbuds when they're connected (the person can turn it off). */
    @PluginMethod
    public void setUseEarbuds(PluginCall call) {
        Boolean wanted = call.getBoolean("enabled");
        boolean on = wanted == null || wanted;
        AlarmStore.setUseEarbuds(getContext(), on);
        JSObject result = new JSObject();
        result.put("useEarbuds", on);
        call.resolve(result);
    }

    /**
     * The media volume the briefing will be spoken at. The alarm raises its own
     * (alarm) stream, so an alarm can ring while the media stream — the one the
     * briefing's voice uses — sits at zero: the person then sees the briefing
     * "speaking" and hears nothing.
     */
    @PluginMethod
    public void mediaVolume(PluginCall call) {
        JSObject result = new JSObject();
        AudioManager am = (AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        int volume = -1;
        int max = -1;
        try {
            if (am != null) {
                volume = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            }
        } catch (Exception ignored) {
            // unknown: the app says nothing about the volume
        }
        result.put("volume", volume);
        result.put("max", max);
        result.put("silent", volume == 0);
        call.resolve(result);
    }

    /**
     * Turns the media volume up when it is at zero, for a briefing the person
     * asked to hear right now (they turned an alarm off, or tapped to hear it).
     * Returns the level to put back (-1: untouched — it wasn't silent).
     */
    @PluginMethod
    public void raiseMediaVolume(PluginCall call) {
        JSObject result = new JSObject();
        int previous = -1;
        AudioManager am = (AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        try {
            if (am != null) {
                int now = am.getStreamVolume(AudioManager.STREAM_MUSIC);
                int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                if (now == 0 && max > 0) {
                    previous = 0;
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, Math.round(max * 0.35f)), 0);
                }
            }
        } catch (Exception ignored) {
            previous = -1;
        }
        result.put("previous", previous);
        call.resolve(result);
    }

    /** Puts the media volume back the way the person had it. */
    @PluginMethod
    public void restoreMediaVolume(PluginCall call) {
        Integer previous = call.getInt("previous");
        JSObject result = new JSObject();
        boolean restored = false;
        AudioManager am = (AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        try {
            if (am != null && previous != null && previous >= 0 && am.getStreamVolume(AudioManager.STREAM_MUSIC) != previous) {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, previous, 0);
                restored = true;
            }
        } catch (Exception ignored) {
            // nothing to put back
        }
        result.put("restored", restored);
        call.resolve(result);
    }

    @PluginMethod
    public void notificationsAllowed(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", allowed());
        call.resolve(result);
    }

    /**
     * Android 13+ asks the person. The answer comes back on its own; the app
     * re-reads the state when it returns to the front — `asked` says the dialog
     * was opened.
     */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", allowed());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !allowed() && getActivity() != null) {
            result.put("asked", true);
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_REQUEST);
        }
        call.resolve(result);
    }

    private boolean allowed() {
        try {
            return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        } catch (Exception e) {
            return true;
        }
    }
}
