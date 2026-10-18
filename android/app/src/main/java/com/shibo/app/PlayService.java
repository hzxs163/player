package com.shibo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 播着的时候挂着的前台服务：锁屏、切后台、屏幕熄掉都继续出声，通知栏给三个键。
 * 键不在这儿演播，只把动作转告页面（MainActivity.dispatchTransport）——
 * 播哪台、怎么换台、失败怎么跳过，判断都只在页面里有一份。
 */
public final class PlayService extends Service {

    public static final String ACTION_PLAY = "com.shibo.app.PLAY";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SUB = "sub";

    private static final String TAG = "PlayService";
    private static final String CHANNEL = "playback";
    private static final int NOTE_ID = 42;

    private static final String ACT_TOGGLE = "com.shibo.app.TOGGLE";
    private static final String ACT_NEXT = "com.shibo.app.NEXT";
    private static final String ACT_PREV = "com.shibo.app.PREV";

    private NotificationManager nm;
    private MediaSession session;
    private String title = "";
    private String sub = "";

    @Override
    public void onCreate() {
        super.onCreate();
        nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSession(this, "ShiBo");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MainActivity.dispatchTransport("toggle");
            }

            @Override
            public void onPause() {
                MainActivity.dispatchTransport("toggle");
            }

            @Override
            public void onSkipToNext() {
                MainActivity.dispatchTransport("next");
            }

            @Override
            public void onSkipToPrevious() {
                MainActivity.dispatchTransport("prev");
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        // START_NOT_STICKY：被系统杀掉后重启也没有「正在播的那一台」可续，不如彻底停
        if (ACT_TOGGLE.equals(action)) {
            MainActivity.dispatchTransport("toggle");
            return START_NOT_STICKY;
        }
        if (ACT_NEXT.equals(action)) {
            MainActivity.dispatchTransport("next");
            return START_NOT_STICKY;
        }
        if (ACT_PREV.equals(action)) {
            MainActivity.dispatchTransport("prev");
            return START_NOT_STICKY;
        }
        if (intent != null) {
            String t = intent.getStringExtra(EXTRA_TITLE);
            String s = intent.getStringExtra(EXTRA_SUB);
            title = t == null ? "" : t;
            sub = s == null ? "" : s;
        }
        publish();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        nm.cancel(NOTE_ID);
        session.setActive(false);
        session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 通知 + 会话元数据一起刷新（锁屏上的控制中心读的是会话，不是通知）。 */
    private void publish() {
        Notification note = build();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTE_ID, note);
            }
        } catch (RuntimeException e) {
            // 用户把「播放」这条通知渠道删了（或者禁了通知）时，startForeground/notify 会抛，
            // 而且是在这里抛——服务留着也没意义，让页面继续播，通知这条线断掉就算了
            Log.w(TAG, "进前台失败：" + e);
            stopSelf();
            return;
        }

        android.media.MediaMetadata meta = new android.media.MediaMetadata.Builder()
                .putString(android.media.MediaMetadata.METADATA_KEY_TITLE,
                        title.isEmpty() ? getString(R.string.notif_title) : title)
                .putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, sub)
                .build();
        session.setMetadata(meta);
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
        session.setActive(true);
    }

    private Notification build() {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);

        b.setContentTitle(title.isEmpty() ? getString(R.string.notif_title) : title)
                .setContentText(sub)
                // 通知栏这行带版本号：截图里能看出装的是哪一版，不必再来回问「你更新了吗」
                .setSubText(getString(R.string.app_name) + " v" + ShellBridge.versionName(this))
                .setSmallIcon(R.drawable.ic_stat_shibo)
                .setColor(0xFF58C7BD)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(R.drawable.ic_prev, getString(R.string.act_prev), tap(ACT_PREV, 1))
                .addAction(R.drawable.ic_pause, getString(R.string.act_pause), tap(ACT_TOGGLE, 2))
                .addAction(R.drawable.ic_next, getString(R.string.act_next), tap(ACT_NEXT, 3))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private PendingIntent tap(String act, int code) {
        Intent in = new Intent(this, PlayService.class);
        in.setAction(act);
        return PendingIntent.getService(this, code, in, PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
    }
}
