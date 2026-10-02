package ai.soundwave.companion;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.widget.Toast;

/**
 * The ringing alarm: a foreground service so Android doesn't kill it while the
 * sound plays, with the alarm screen (AlarmActivity) and a notification that
 * has Turn off / Snooze on it. Turning it off hands over to
 * AlarmScheduler.dismiss — the briefing starts after the user's delay.
 */
public class AlarmService extends Service {
    static final String ACTION_RING = "ai.soundwave.companion.action.RING";
    static final String ACTION_DISMISS = "ai.soundwave.companion.action.DISMISS";
    static final String ACTION_SNOOZE = "ai.soundwave.companion.action.SNOOZE";

    private MediaPlayer player;
    private Ringtone ringtone;
    private int volumeBefore = -1;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private boolean ringing = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_RING;
        String id = intent != null ? intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) : null;
        if (ACTION_DISMISS.equals(action)) {
            dismiss(alarmFor(id));
            return START_NOT_STICKY;
        }
        if (ACTION_SNOOZE.equals(action)) {
            snooze(alarmFor(id));
            return START_NOT_STICKY;
        }
        ring(alarmFor(id));
        return START_NOT_STICKY;
    }

    private AlarmStore.Alarm alarmFor(String id) {
        String wanted = id != null ? id : AlarmStore.ringingId(this);
        return wanted == null ? null : AlarmStore.find(this, wanted);
    }

    // ── Ringing ─────────────────────────────────────────────────────────────

    private void ring(AlarmStore.Alarm alarm) {
        AlarmStore.setRinging(this, alarm == null ? null : alarm.id);
        startForeground(AlarmNotifications.RINGING_ID, AlarmNotifications.ringing(this, alarm));
        if (ringing) return;
        ringing = true;
        acquireWakeLock();
        playAlarm();
        vibrate();
        // Usually the full-screen intent opens the alarm screen; this is the same thing from here.
        try {
            Intent screen = new Intent(this, AlarmActivity.class);
            screen.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (alarm != null) screen.putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.id);
            startActivity(screen);
        } catch (Exception ignored) {
            // Android may refuse a background activity start: the notification is there.
        }
        // An unanswered alarm shouldn't ring forever: the sound stops after 5 minutes.
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (ringing) stopRinging();
        }, 5 * 60_000L);
    }

    /**
     * The alarm sound: the phone's alarm tone, on the connected Bluetooth
     * earbuds when the person wants it there, with the alarm volume turned up
     * for the ring. If the platform won't play it that way, the plain ringtone
     * still rings — an alarm is never silent.
     */
    private void playAlarm() {
        Uri uri = AlarmAudio.toneUri();
        if (uri == null) return;
        volumeBefore = AlarmAudio.raiseVolume(this);
        try {
            player = AlarmAudio.start(this, uri, AlarmStore.useEarbuds(this));
        } catch (Exception e) {
            playRingtoneFallback(uri);
        }
    }

    private void playRingtoneFallback(Uri uri) {
        try {
            ringtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (ringtone == null) return;
            ringtone.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone.setLooping(true);
            ringtone.play();
        } catch (Exception ignored) {
            // a phone without an alarm sound still shows the alarm screen
        }
    }

    private void vibrate() {
        try {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            vibrator = v;
            long[] pattern = { 0, 700, 700 };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(pattern, 0));
            else v.vibrate(pattern, 0);
        } catch (Exception ignored) {
            // no vibration
        }
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Soundwave:Alarm");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(10 * 60_000L);
        } catch (Exception ignored) {
            // the alarm still rings while the phone is awake
        }
    }

    private void stopRinging() {
        ringing = false;
        try {
            if (player != null) {
                if (player.isPlaying()) player.stop();
                player.release();
            }
        } catch (Exception ignored) {
            // already stopped
        }
        player = null;
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        } catch (Exception ignored) {
            // already stopped
        }
        ringtone = null;
        AlarmAudio.restoreVolume(this, volumeBefore);
        volumeBefore = -1;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
            // already stopped
        }
        vibrator = null;
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // already released
        }
        wakeLock = null;
    }

    // ── Off / snooze ────────────────────────────────────────────────────────

    private void dismiss(AlarmStore.Alarm alarm) {
        stopRinging();
        AlarmStore.setRinging(this, null);
        AlarmNotifications.cancel(this, AlarmNotifications.RINGING_ID);
        AlarmScheduler.dismiss(this, alarm);
        int seconds = alarm != null ? alarm.briefingAfterSeconds : AlarmStore.briefingSeconds(this);
        toast(seconds <= 0 ? "Good morning — your briefing is starting." : "Good morning — your briefing starts in " + seconds + " seconds.");
        stopForegroundCompat();
        stopSelf();
    }

    private void snooze(AlarmStore.Alarm alarm) {
        stopRinging();
        AlarmStore.setRinging(this, null);
        AlarmNotifications.cancel(this, AlarmNotifications.RINGING_ID);
        AlarmScheduler.snooze(this, alarm);
        toast("Snoozed — it will ring again in 9 minutes.");
        stopForegroundCompat();
        stopSelf();
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    private void toast(String message) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show();
            } catch (Exception ignored) {
                // no toast on this device
            }
        });
    }

    @Override
    public void onDestroy() {
        stopRinging();
        super.onDestroy();
    }
}
