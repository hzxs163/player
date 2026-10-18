package com.shibo.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
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
    private ShellBridge shell;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        WebView w = new WebView(this);
        web = w;
        shell = new ShellBridge(this);
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
        w.addJavascriptInterface(new StoreBridge(this), "ShiBoStore");
        w.addJavascriptInterface(new MediaBridge(this), "ShiBoMedia");
        w.addJavascriptInterface(shell, "ShiBoShell");
        shell.attach(w);
        fitSystemBars(w);

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
     * 顶栏会直接钻到时钟和信号图标底下（真机截图实测就是这样，v1.0.0、v1.0.1 都没治住）。
     *
     * 两版各自的病根：
     * - v1.0.0 是 CSS 的错，padding: 8px 10px calc(8px + env(safe-area-inset-top)) 三个值的意思是
     *   「上 / 左右 / 下」，安全区被加到了 padding-bottom 上，顶栏里的字一寸都没让开；
     * - v1.0.1 把系统栏尺寸吃成 WebView 的 padding，实测仍然压着，而这台机器上没有通道能证明
     *   那次 padding 到底生没生效（监听器有没有派发、Chromium 认不认这个 padding，都是猜）。
     *
     * 所以这版换成「原生只量，页面自己让」：量到的尺寸经 ShellBridge 交给页面写成 --shell-*，
     * 由 .topbar/.transport/.drawer 加自己的 padding。这条链路每一步都能在设置抽屉里看见数值，
     * 顶栏底色还能一直铺到状态栏后面不留接缝；浏览器那边同一份 CSS 走 env()，两条取 max 不会重复让。
     *
     * 30 以下整个跳过：那边框架本来就把内容压在状态栏下面，页面再让一次就成了双重留白。
     *
     * 尺寸来源只认 getInsets(mask)（Type 常量挂在 android.view.WindowInsets 上，
     * 不是 android.window.WindowInsets——CI 实测 package android.window.WindowInsets does not exist），
     * 不走看着更短的两条：getSystemWindowInsets() 在 compileSdk 35 上回的是 Insets 而不是 Rect
     * （incompatible types: Insets cannot be converted to Rect，返回类型在版本间挪过位置，
     * 拿它赌低版本设备的实现有翻 NoSuchMethodError 的风险）；
     * getSystemWindowInsetTop()/Bottom() 那组便捷方法的值里掺输入法高度，键盘一弹出来就被当成常驻内边距。
     * systemBars 之外并上 displayCutout，否则刘海机横屏时内容会钻进缺口。
     */
    private void fitSystemBars(WebView w) {
        if (Build.VERSION.SDK_INT < 30) return;
        getWindow().setDecorFitsSystemWindows(false);
        // 先把框架自报的状态栏高度垫给页面：监听器一次都没派发（v1.0.1 疑似就是这么静默的）
        // 或者派发得太晚，页面 init 那一次拉取至少有个接近真值的数拿着。监听器一来就覆盖掉。
        shell.pushInsets(statusBarHeightPx(), 0, 0, 0);
        w.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                Insets s = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                // 量到 0 也要有状态栏高度垫底；bottom 不设下限：手势条有没有、多高因机型而异，硬垫会白吃一条空间
                shell.pushInsets(Math.max(s.top, statusBarHeightPx()), s.right, s.bottom, s.left);
                return insets;
            }
        });
    }

    /** 框架自己的状态栏高度（@android:dimen/status_bar_height），机型不认时给 0。 */
    private int statusBarHeightPx() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
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
