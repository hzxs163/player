package com.shibo.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;

/**
 * window.ShiBoMedia：页面状态机每落定一次就发一遍（见 src/native-bridge.js）。
 * playing=false 就撤掉前台服务——暂停意味着用户听完了，没必要占着通知和进程。
 */
final class MediaBridge {

    private static final String TAG = "MediaBridge";
    private final Context ctx;

    MediaBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    @JavascriptInterface
    public void setPlaying(boolean playing, String title, String sub) {
        Intent in = new Intent(ctx, PlayService.class);
        try {
            if (playing) {
                in.setAction(PlayService.ACTION_PLAY);
                in.putExtra(PlayService.EXTRA_TITLE, title == null ? "" : title);
                in.putExtra(PlayService.EXTRA_SUB, sub == null ? "" : sub);
                // 8.0 起后台服务会被冻结，媒体播放必须走前台服务这条道；
                // 系统要求调用后 5 秒内进前台，PlayService.onStartCommand 第一件事就是它
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(in);
                else ctx.startService(in);
            } else {
                ctx.stopService(in);
            }
        } catch (RuntimeException e) {
            // 12 起「界面不在前台时拉前台服务」会直接抛；这不该把播放的那一侧带崩
            Log.w(TAG, "起停前台服务失败：" + e);
        }
    }
}
