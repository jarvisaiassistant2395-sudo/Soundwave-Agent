package ai.soundwave.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;

/**
 * The alarm's notifications: the ringing one (with Snooze / Turn off, and a
 * full-screen intent so the alarm screen comes up over the lock screen) and
 * the "your briefing is ready" one for when Android won't let the app open by
 * itself. Channels exist on Android 8+.
 */
final class AlarmNotifications {
    static final int RINGING_ID = 1;
    static final int BRIEFING_ID = 2;
    private static final String CHANNEL_ALARM = "soundwave_alarm";
    private static final String CHANNEL_BRIEFING = "soundwave_briefing";

    private AlarmNotifications() {
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ALARM) == null) {
            NotificationChannel alarm = new NotificationChannel(CHANNEL_ALARM, "Alarms", NotificationManager.IMPORTANCE_HIGH);
            alarm.setDescription("Alarms the agent sets for you");
            alarm.setSound(null, null); // the ringtone is played by AlarmService, not the channel
            alarm.enableVibration(true);
            alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(alarm);
        }
        if (nm.getNotificationChannel(CHANNEL_BRIEFING) == null) {
            NotificationChannel briefing = new NotificationChannel(CHANNEL_BRIEFING, "Morning briefing", NotificationManager.IMPORTANCE_HIGH);
            briefing.setDescription("Your briefing after an alarm is turned off");
            nm.createNotificationChannel(briefing);
        }
    }

    private static PendingIntent service(Context c, String action, String alarmId, int request) {
        Intent intent = new Intent(c, AlarmService.class);
        intent.setAction(action);
        if (alarmId != null) intent.putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return PendingIntent.getForegroundService(c, request, intent, flags);
        return PendingIntent.getService(c, request, intent, flags);
    }

    private static PendingIntent screen(Context c, AlarmStore.Alarm alarm) {
        Intent intent = new Intent(c, AlarmActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (alarm != null) intent.putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.id);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(c, 92, intent, flags);
    }

    private static Notification.Builder builder(Context c, String channel, int priority) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return new Notification.Builder(c, channel);
        Notification.Builder b = new Notification.Builder(c);
        b.setPriority(priority);
        return b;
    }

    /** The ringing alarm: Snooze and Turn off right on the notification. */
    static Notification ringing(Context c, AlarmStore.Alarm alarm) {
        ensureChannels(c);
        PendingIntent full = screen(c, alarm);
        String title = alarm == null || alarm.label.isEmpty()
                ? "⏰ Alarm"
                : "⏰ " + alarm.label;
        String text = alarm == null ? "Soundwave alarm" : "Set for " + android.text.format.DateFormat.getTimeFormat(c).format(alarm.at);
        Notification.Builder b = builder(c, CHANNEL_ALARM, Notification.PRIORITY_MAX)
                .setSmallIcon(R.drawable.ic_alarm)
                .setContentTitle(title)
                .setContentText(text)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setShowWhen(false)
                .setContentIntent(full)
                .setFullScreenIntent(full, true)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_alarm), "Turn off", service(c, AlarmService.ACTION_DISMISS, alarm == null ? null : alarm.id, 21)).build())
                .addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_alarm), "Snooze 9 min", service(c, AlarmService.ACTION_SNOOZE, alarm == null ? null : alarm.id, 22)).build());
        return b.build();
    }

    /** Android wouldn't open the app by itself: tap to hear the briefing. */
    static void briefingReady(Context c) {
        ensureChannels(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Intent open = new Intent(c, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.addCategory(Intent.CATEGORY_LAUNCHER);
        open.putExtra(MainActivity.EXTRA_BRIEFING, true);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(c, 93, open, flags);
        Notification n = builder(c, CHANNEL_BRIEFING, Notification.PRIORITY_HIGH)
                .setSmallIcon(R.drawable.ic_alarm)
                .setContentTitle("☀️ Your briefing is ready")
                .setContentText("Tap to hear it")
                .setCategory(Notification.CATEGORY_STATUS)
                .setAutoCancel(true)
                .setContentIntent(tap)
                .build();
        nm.notify(BRIEFING_ID, n);
    }

    static void cancel(Context c, int id) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(id);
    }

    static void cancelAll(Context c) {
        cancel(c, RINGING_ID);
        cancel(c, BRIEFING_ID);
    }
}
