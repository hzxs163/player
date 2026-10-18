package com.shibo.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.util.concurrent.atomic.AtomicReference;

/**
 * 一层壳：WebView 里跑的就是 https://hzxs163.github.io/player/ 那份页面（构建时原样打进 APK），
 * 外加两扇窗——ShiBoStore（本机磁盘，放 7.7 MB 的快照）和 ShiBoMedia（通知栏播控）。
 * 页面的数据策略本来就是「本地优先 + 后台换新」，所以首次联网下载存盘，之后断网也开得了机。
 */
public final class MainActivity extends Activity {

    // 通知栏要点播控键得回到这个界面的 WebView；界面没了就没人接（见 dispatchTransport）
    private static final AtomicReference<MainActivity> TOP = new AtomicReference<>();

    private static final int REQ_NOTIF = 7;

    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        WebView w = new WebView(this);
        web = w;
        // 和页面 --ink 同色：冷启那一下不闪白屏
        w.setBackgroundColor(0xFF0A0F14);

        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // 历史、收藏、还有断网时认版本用的 meta 都在 localStorage
        // 「按 N 随机一台」就是程序化起播，不给这条豁免就是点了没声
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setDatabaseEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        w.setWebViewClient(new ShellClient(this));
        w.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        fitSystemBars(w);
        w.addJavascriptInterface(new StoreBridge(this), "ShiBoStore");
        w.addJavascriptInterface(new MediaBridge(this), "ShiBoMedia");

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        setContentView(w, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        TOP.set(this);
        askNotificationPermission();

        if (saved != null) w.restoreState(saved);
        else w.loadUrl(ShellClient.START_URL);
    }

    /**
     * 故意不调 webView.onPause()：那会让 Chromium 挂起媒体元素，锁屏/切后台就断了，
     * 而「锁屏继续播」正是这层壳存在的理由。页面自己不会在后台暂停音频。
     */
    @Override
    protected void onPause() {
        super.onPause();
    }

    /**
     * 状态栏不再压着页面：targetSdk 35 起安卓强制铺满整屏（edge-to-edge），
     * 顶栏会直接钻到时钟和信号图标底下（真机截图实测就是这样）。
     *
     * 这里把系统栏尺寸吃成 WebView 的内边距，让出来的那条带子露出 windowBackground
     * （@color/ink，和页面底色同值），而不是让页面去猜状态栏多高。
     * 30 以下不动：那边还是框架自己留白，我们再叠一层就成了双重间距。
     *
     * 取尺寸只认 getInsets(mask)，不走两条看着更短的路：
     * - getSystemWindowInsets()：CI 实测 compileSdk 35 上它回的是 android.graphics.Insets
     *   而不是 Rect（incompatible types: Insets cannot be converted to Rect），
     *   返回类型在版本间挪过位置，拿它赌低版本设备上的实现在签名上会翻 NoSuchMethodError；
     * - getSystemWindowInsetTop()/Bottom() 那组 int 便捷方法：值里会掺进输入法高度，
     *   键盘一弹出来就被当成常驻内边距用。
     * systemBars 之外还要并上 displayCutout，否则刘海机横屏时内容会钻到缺口中。
     */
    private void fitSystemBars(WebView w) {
        if (Build.VERSION.SDK_INT < 30) return;
        getWindow().setDecorFitsSystemWindows(false);
        final int mask = android.window.WindowInsets.Type.systemBars()
                | android.window.WindowInsets.Type.displayCutout();
        w.setOnApplyWindowInsetsListener(new android.view.View.OnApplyWindowInsetsListener() {
            @Override
            public android.view.WindowInsets onApplyWindowInsets(android.view.View view, android.view.WindowInsets insets) {
                Insets r = insets.getInsets(mask);
                view.setPadding(r.left, r.top, r.right, r.bottom);
                return insets;
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        TOP.compareAndSet(this, null);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    /**
     * 通知栏/耳机键的落点。kind 只可能是 toggle/next/prev 三个字面量（服务端拼的），
     * 页面那侧 window.ShiBoNative.onTransport 把它们点到现有按钮上。
     * 界面已经没了就什么都不做：WebView 必须附着在 Activity 上，划掉任务等于停止收听。
     */
    static void dispatchTransport(String kind) {
        MainActivity a = TOP.get();
        if (a == null) return;
        final WebView w = a.web;
        if (w == null) return;
        final String js = "window.ShiBoNative&&window.ShiBoNative.onTransport('" + kind + "')";
        w.post(new Runnable() {
            @Override
            public void run() {
                w.evaluateJavascript(js, null);
            }
        });
    }
}
