package ai.soundwave.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Everything the system wakes us for: an alarm going off (ring), the briefing
 * timer after the alarm was turned off, and a reboot or app update (the alarms
 * are re-armed — Android forgets them otherwise).
 */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) return;

        if (AlarmScheduler.ACTION_ALARM.equals(action)) {
            String id = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
            Intent service = new Intent(context, AlarmService.class).setAction(AlarmService.ACTION_RING);
            if (id != null) service.putExtra(AlarmScheduler.EXTRA_ALARM_ID, id);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service);
            else context.startService(service);
            return;
        }

        if (AlarmScheduler.ACTION_BRIEFING.equals(action)) {
            AlarmScheduler.startBriefing(context);
            return;
        }

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            for (AlarmStore.Alarm alarm : AlarmStore.alarms(context)) {
                if (alarm.at > System.currentTimeMillis()) AlarmScheduler.schedule(context, alarm);
                else AlarmStore.remove(context, alarm.id);
            }
        }
    }
}
