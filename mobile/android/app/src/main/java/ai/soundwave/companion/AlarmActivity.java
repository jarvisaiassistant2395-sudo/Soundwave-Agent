package ai.soundwave.companion;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

/**
 * The alarm screen: the time, the label, Snooze and Turn off. Turn off starts
 * the countdown the user chose ("your briefing starts in N seconds"), and then
 * opens the app so the briefing starts talking — the app is on screen here, so
 * Android allows it.
 */
public class AlarmActivity extends AppCompatActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlarmStore.Alarm alarm;
    private int secondsLeft = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String id = getIntent() != null ? getIntent().getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) : null;
        if (id == null) id = AlarmStore.ringingId(this);
        alarm = id == null ? null : AlarmStore.find(this, id);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        setContentView(R.layout.activity_alarm);

        long at = alarm != null ? alarm.at : System.currentTimeMillis();
        ((TextView) findViewById(R.id.alarm_time)).setText(android.text.format.DateFormat.getTimeFormat(this).format(at));
        ((TextView) findViewById(R.id.alarm_label)).setText(alarm == null || alarm.label.isEmpty() ? "Soundwave alarm" : alarm.label);
        findViewById(R.id.alarm_dismiss).setOnClickListener((v) -> dismiss());
        findViewById(R.id.alarm_snooze).setOnClickListener((v) -> snooze());

        // The service rings; if this screen was opened some other way, this starts it.
        startService(new Intent(this, AlarmService.class).setAction(AlarmService.ACTION_RING)
                .putExtra(AlarmScheduler.EXTRA_ALARM_ID, id));
    }

    private void dismiss() {
        startService(new Intent(this, AlarmService.class).setAction(AlarmService.ACTION_DISMISS)
                .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm == null ? null : alarm.id));
        int seconds = alarm != null ? alarm.briefingAfterSeconds : AlarmStore.briefingSeconds(this);
        if (seconds <= 0) {
            openBriefing();
            return;
        }
        secondsLeft = seconds;
        findViewById(R.id.alarm_buttons).setVisibility(View.GONE);
        findViewById(R.id.alarm_countdown).setVisibility(View.VISIBLE);
        tick();
    }

    private void tick() {
        TextView countdown = findViewById(R.id.alarm_countdown);
        countdown.setText(secondsLeft <= 1 ? "Starting your briefing…" : "Your briefing starts in " + secondsLeft + " seconds");
        if (secondsLeft <= 0) {
            openBriefing();
            return;
        }
        secondsLeft--;
        handler.postDelayed(this::tick, 1000);
    }

    private void openBriefing() {
        handler.removeCallbacksAndMessages(null);
        try {
            Intent open = new Intent(this, MainActivity.class);
            open.setAction(Intent.ACTION_MAIN);
            open.addCategory(Intent.CATEGORY_LAUNCHER);
            open.putExtra(MainActivity.EXTRA_BRIEFING, true);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(open);
        } catch (Exception ignored) {
            // The notification in the shade opens it instead.
        }
        finish();
    }

    private void snooze() {
        startService(new Intent(this, AlarmService.class).setAction(AlarmService.ACTION_SNOOZE)
                .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm == null ? null : alarm.id));
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
