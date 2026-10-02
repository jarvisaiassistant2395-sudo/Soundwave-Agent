package ai.soundwave.companion;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.Settings;

import java.io.IOException;

/**
 * The sound of a ringing alarm. Android's own routing often sends alarm audio
 * to the phone's speaker even with earbuds connected, so when the person wants
 * it (Settings → Alarm & the briefing, on by default) the Bluetooth output is
 * chosen explicitly. The alarm volume is turned up while it rings and put back
 * when it's turned off — an alarm people sleep through is no alarm.
 */
final class AlarmAudio {
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

    /**
     * Starts the alarm sound — looping until it's stopped — on the earbuds when
     * asked to and they're there. USAGE_ALARM keeps it on the alarm volume and
     * lets it ring through Do Not Disturb, like the phone's own clock.
     */
    static MediaPlayer start(Context c, Uri uri, boolean onEarbuds) throws IOException {
        MediaPlayer player = new MediaPlayer();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        player.setDataSource(c, uri);
        player.setLooping(true);
        player.prepare();
        if (onEarbuds) {
            AudioDeviceInfo earbuds = earbuds(c);
            if (earbuds != null) {
                try {
                    // After prepare(): the route is picked with a ready player.
                    player.setPreferredDevice(earbuds);
                } catch (Exception ignored) {
                    // Android wouldn't take it: the sound plays wherever Android sends it
                }
            }
        }
        player.start();
        return player;
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
