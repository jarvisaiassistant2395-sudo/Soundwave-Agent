package ai.soundwave.companion;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.IOException;

/**
 * The sound of a ringing alarm. Android's own routing often sends alarm audio
 * to the phone's speaker even with earbuds connected, so when the person wants
 * it (Settings → Alarm & the briefing, on by default) the Bluetooth output is
 * chosen explicitly — and then checked: some phones accept the request and
 * still play nothing, which is the one thing an alarm must never do. If the
 * earbuds don't really take the sound, it rings on the phone instead and says
 * where it's ringing. The alarm volume is turned up while it rings and put back
 * when it's turned off.
 */
final class AlarmAudio {
    /** Where the alarm is really ringing right now, for the alarm screen. */
    private static volatile String routeLabel = null;
    /** The focus request to give back when the ringing stops. */
    private static AudioFocusRequest focusRequest;

    private AlarmAudio() {
    }

    /** The tone to ring with: the phone's alarm sound, else its ringtone, else a notification. */
    static Uri toneUri() {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = Settings.System.DEFAULT_NOTIFICATION_URI;
        return uri;
    }

    /** Bluetooth outputs that sit in someone's ears: earbuds, a headset, a hearing aid. */
    private static boolean inEars(int type) {
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || type == AudioDeviceInfo.TYPE_HEARING_AID
                || type == AudioDeviceInfo.TYPE_BLE_HEADSET
                || type == AudioDeviceInfo.TYPE_BLE_SPEAKER;
    }

    /** The connected Bluetooth earbuds to ring on, or null when none are. */
    static AudioDeviceInfo earbuds(Context c) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return null;
        try {
            for (AudioDeviceInfo device : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (device.isSink() && inEars(device.getType())) return device;
            }
        } catch (Exception ignored) {
            // no devices to look at
        }
        return null;
    }

    /** What the earbuds call themselves ("Pixel Buds Pro"), or null when none are connected. */
    static String earbudsName(Context c) {
        AudioDeviceInfo device = earbuds(c);
        if (device == null) return null;
        CharSequence product = device.getProductName();
        String name = product == null ? "" : product.toString().trim();
        return name.isEmpty() ? "Bluetooth audio" : name;
    }

    /** Where the alarm is ringing now ("Pixel Buds Pro", "this phone"), or null before it rings. */
    static String routeLabel() {
        return routeLabel;
    }

    /**
     * Asks Android to hand the alarm the audio route (a transient gain, like the
     * phone's own clock): without focus, a phone that is busy playing something
     * else — music in those same earbuds — can keep the alarm off the route.
     */
    @SuppressWarnings("deprecation")
    private static void requestFocus(Context c) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ALARM)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build())
                        .setWillPauseWhenDucked(false)
                        .build();
                focusRequest = request;
                am.requestAudioFocus(request);
            } else {
                am.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            }
        } catch (Exception ignored) {
            // no focus: the alarm still rings, it just can't push other sound aside
        }
    }

    private static void abandonFocus(Context c) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
            else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) am.abandonAudioFocus(null);
        } catch (Exception ignored) {
            // nothing to give back
        }
        focusRequest = null;
    }

    private static MediaPlayer build(Context c, Uri uri, AudioDeviceInfo device) throws IOException {
        MediaPlayer player = new MediaPlayer();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        // Some phones read the preferred output at configure time, others at
        // play time: ask for it in both places (and add the alternative for
        // Android 12+ that only accepts it after prepare).
        if (device != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                player.setPreferredDevice(device);
            } catch (Exception ignored) {
                // not taken before prepare: tried again below
            }
        }
        player.setDataSource(c, uri);
        player.setLooping(true);
        player.prepare();
        if (device != null) {
            try {
                player.setPreferredDevice(device);
            } catch (Exception ignored) {
                // the framework keeps its own route
            }
        }
        return player;
    }

    /** Waits for the sound to really start coming out (a started player advances its position). */
    private static boolean reallyPlaying(MediaPlayer player) {
        for (int i = 0; i < 6; i++) {
            try {
                if (player.isPlaying() && player.getCurrentPosition() > 0) return true;
            } catch (Exception ignored) {
                return false;
            }
            try {
                Thread.sleep(150);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return false;
    }

    private static void quiet(MediaPlayer player) {
        try {
            if (player.isPlaying()) player.stop();
        } catch (Exception ignored) {
            // already stopped
        }
        try {
            player.release();
        } catch (Exception ignored) {
            // already released
        }
    }

    /**
     * Starts the alarm sound — looping until it's stopped — on the earbuds when
     * asked to and they're there. USAGE_ALARM keeps it on the alarm volume and
     * lets it ring through Do Not Disturb, like the phone's own clock.
     *
     * The sound is verified, not assumed: if choosing the earbuds leaves the
     * player silent (which happens on phones that accept the request and then
     * play nothing), the alarm is restarted on the phone's own output — an
     * alarm is never silent, and `routeLabel()` says where it ended up.
     */
    static MediaPlayer start(Context c, Uri uri, boolean onEarbuds) throws IOException {
        requestFocus(c);
        AudioDeviceInfo device = onEarbuds ? earbuds(c) : null;
        String name = null;
        if (device != null) {
            CharSequence product = device.getProductName();
            name = product == null || product.toString().trim().isEmpty() ? "Bluetooth audio" : product.toString().trim();
        }

        MediaPlayer player = build(c, uri, device);
        player.start();
        if (device != null && !reallyPlaying(player)) {
            // The earbuds didn't take it: ring on the phone, and say so.
            quiet(player);
            routeLabel = null;
            player = build(c, uri, null);
            player.start();
            if (reallyPlaying(player)) {
                routeLabel = name + " wouldn't take the sound, so this is the phone";
            } else {
                routeLabel = "this phone";
            }
            return player;
        }
        if (device != null) routeLabel = name;
        else routeLabel = null; // the phone's own output
        return player;
    }

    /** Stops the alarm sound, gives the audio focus back and forgets the route. */
    static void stop(Context c, MediaPlayer player) {
        if (player != null) quiet(player);
        abandonFocus(c);
        routeLabel = null;
    }

    /**
     * Turns the alarm volume up so the ring can wake someone who is asleep.
     * Returns the level to put back afterwards (-1: nothing to restore).
     */
    static int raiseVolume(Context c) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return -1;
        try {
            int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
            int now = am.getStreamVolume(AudioManager.STREAM_ALARM);
            int want = Math.max(now, Math.round(max * 0.7f));
            if (want > now) am.setStreamVolume(AudioManager.STREAM_ALARM, want, 0);
            return now;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Puts the alarm volume back the way the person had it. */
    static void restoreVolume(Context c, int previous) {
        if (previous < 0) return;
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            if (am.getStreamVolume(AudioManager.STREAM_ALARM) != previous) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0);
            }
        } catch (Exception ignored) {
            // nothing to put back
        }
    }
}
