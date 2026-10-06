package ai.soundwave.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * The plumbing between an alarm and the phone: exact alarms through
 * AlarmManager (a real alarm-clock alarm, so Android shows it in the status
 * bar and doesn't batch it away), the delay before the briefing, and starting
 * the app when the briefing is due.
 */
final class AlarmScheduler {
    static final String ACTION_ALARM = "ai.soundwave.companion.action.ALARM";
    static final String ACTION_BRIEFING = "ai.soundwave.companion.action.BRIEFING";
    static final String EXTRA_ALARM_ID = "alarmId";

    private AlarmScheduler() {
    }

    private static AlarmManager manager(Context c) {
        return (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
    }

    private static PendingIntent broadcast(Context c, String action, String alarmId, long at, int requestBase) {
        Intent intent = new Intent(c, AlarmReceiver.class);
        intent.setAction(action);
        if (alarmId != null) intent.putExtra(EXTRA_ALARM_ID, alarmId);
        if (at > 0) intent.putExtra("at", at);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, requestBase, intent, flags);
    }

    private static PendingIntent showIntent(Context c) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(c, 91, new Intent(c, MainActivity.class), flags);
    }

    /** Arms an alarm: to the second, and treated as the user's own alarm clock. */
    static void schedule(Context c, AlarmStore.Alarm alarm) {
        AlarmManager am = manager(c);
        if (am == null) return;
        PendingIntent pi = broadcast(c, ACTION_ALARM, alarm.id, alarm.at, 11);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(alarm.at, showIntent(c)), pi);
        } catch (SecurityException e) {
            // "Alarms & reminders" not granted: the alarm still rings, maybe a little late.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.at, pi);
        }
    }

    static void cancel(Context c, AlarmStore.Alarm alarm) {
        AlarmManager am = manager(c);
        if (am != null) am.cancel(broadcast(c, ACTION_ALARM, alarm.id, alarm.at, 11));
    }

    /** The briefing is due `seconds` after the alarm was turned off. */
    static void scheduleBriefing(Context c, long at) {
        AlarmManager am = manager(c);
        if (am == null) return;
        PendingIntent pi = broadcast(c, ACTION_BRIEFING, null, 0, 12);
        try {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    /**
     * The briefing is due now: remember it (in case the app has to be opened
     * later), tell a running app, open the app when Android allows it, and put
     * a notification in the shade either way.
     */
    static void startBriefing(Context c) {
        if (!AlarmStore.claimBriefing(c)) return; // the countdown and the timer are one briefing
        boolean appUp = AlarmPlugin.appInForeground();
        if (!appUp) {
            // The app isn't on screen: remember it, and say so in the shade.
            AlarmStore.setBriefingPending(c, true);
            AlarmNotifications.briefingReady(c);
        }
        AlarmPlugin.emitBriefingDue(c);
        if (appUp) return; // the app is open in front of the user: it starts the briefing itself
        try {
            Intent open = new Intent(c, MainActivity.class);
            open.setAction(Intent.ACTION_MAIN);
            open.addCategory(Intent.CATEGORY_LAUNCHER);
            open.putExtra(MainActivity.EXTRA_BRIEFING, true);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            c.startActivity(open);
        } catch (Exception ignored) {
            // Android may refuse a background activity start — the notification is there.
        }
    }

    /** The user turned the alarm off: stop it and let the briefing start after their delay. */
    static void dismiss(Context c, AlarmStore.Alarm alarm) {
        if (alarm != null) AlarmStore.remove(c, alarm.id);
        int seconds = alarm != null ? alarm.briefingAfterSeconds : AlarmStore.briefingSeconds(c);
        long at = System.currentTimeMillis() + Math.max(0, seconds) * 1000L;
        AlarmStore.setBriefingPending(c, true); // if the timer itself gets batched away
        scheduleBriefing(c, at);
    }

    /** Snooze: the same alarm, nine minutes later (the usual snooze). */
    static void snooze(Context c, AlarmStore.Alarm alarm) {
        if (alarm != null) AlarmStore.remove(c, alarm.id);
        long at = System.currentTimeMillis() + 9 * 60_000L;
        int seconds = alarm != null ? alarm.briefingAfterSeconds : AlarmStore.briefingSeconds(c);
        AlarmStore.Alarm next = AlarmStore.add(c, at, alarm != null ? alarm.label : "", seconds);
        schedule(c, next);
    }
}
