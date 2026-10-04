package ai.soundwave.companion;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** The app was opened so the briefing can start talking (AlarmScheduler / AlarmActivity). */
    static final String EXTRA_BRIEFING = "soundwave_briefing";
    /** The alarm's Turn off / Snooze, without the alarm screen (the notification, and the tests). */
    static final String EXTRA_ALARM_ACTION = "soundwave_alarm";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The Soundwave voices on the phone itself (when the PC is off).
        registerPlugin(EdgeTtsPlugin.class);
        // Alarms the agent sets, and the briefing after one is turned off.
        registerPlugin(AlarmPlugin.class);
        super.onCreate(savedInstanceState);
        AlarmNotifications.ensureChannels(this);
        handleIntent(getIntent());
    }

    // Capacitor's BridgeActivity declares these public (its override is not
    // protected), so these have to be public too.
    @Override
    public void onResume() {
        super.onResume();
        AlarmPlugin.setAppOnScreen(true);
    }

    @Override
    public void onPause() {
        AlarmPlugin.setAppOnScreen(false);
        super.onPause();
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** `soundwave_alarm=dismiss|snooze` works like the notification's buttons; `briefing` starts the briefing. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(EXTRA_ALARM_ACTION);
        if ("dismiss".equals(action) || "snooze".equals(action)) {
            Intent service = new Intent(this, AlarmService.class)
                    .setAction("dismiss".equals(action) ? AlarmService.ACTION_DISMISS : AlarmService.ACTION_SNOOZE);
            String id = AlarmStore.ringingId(this);
            if (id != null) service.putExtra(AlarmScheduler.EXTRA_ALARM_ID, id);
            startService(service);
        }
        if (intent.getBooleanExtra(EXTRA_BRIEFING, false)) {
            // The phone app is opening (or already open): the briefing is due.
            AlarmPlugin.emitBriefingDue(this);
        }
    }
}
