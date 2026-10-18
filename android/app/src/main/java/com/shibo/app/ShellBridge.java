package com.shibo.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * window.ShiBoShell：壳向页面交代两件事——自己是哪个版本，以及系统栏吃掉了多少地方。
 *
 * 为什么不把系统栏尺寸直接吃成 WebView 的 padding（v1.0.1 就是这么干的）：那条路在真机上
 * 没解决「顶栏压在状态栏底下」，而这台机器上没有日志通道能证明 padding 到底生没生效。
 * 交给页面加 padding 的三条好处是可以在截图里验的：顶栏底色一直铺到状态栏后面（不留接缝）、
 * 数值能在设置抽屉里读出来（下次判断是哪一环坏了只用一张截图）、浏览器里同一份 CSS
 * 走 env(safe-area-inset-*) 也照样成立。
 *
 * 版本号的用处同上：没有它，「装了新版还不行」和「根本没装上」在截图里长得一模一样。
 */
final class ShellBridge {

    private final Context ctx;
    private final float density;

    // 量到的尺寸存成 CSS px（逻辑像素）：页面只认 px，不该去猜这台机器 1px 等于几个设备像素
    private volatile int top;
    private volatile int right;
    private volatile int bottom;
    private volatile int left;

    private volatile WebView web;

    ShellBridge(Context ctx) {
        this.ctx = ctx;
        this.density = ctx.getResources().getDisplayMetrics().density;
    }

    void attach(WebView w) {
        web = w;
    }

    /** 页面启动时自己来拉一次（推送可能赶在 window.ShiBoNative 挂上之前就发了）。 */
    @JavascriptInterface
    public String insets() {
        return top + " " + right + " " + bottom + " " + left;
    }

    @JavascriptInterface
    public String version() {
        return versionName(ctx);
    }

    /**
     * 原生侧每量到一次系统栏尺寸就走这里：先存着，再喊页面重读一遍。
     * 喊的是无参的 onInsets()，值只从 insets() 这一个口子出——避免同一个数字有两条来源，
     * 推送丢了也无所谓（页面 init 时那一次拉取一定看得见这里存的值）。
     */
    void pushInsets(int topPx, int rightPx, int bottomPx, int leftPx) {
        top = cssPx(topPx);
        right = cssPx(rightPx);
        bottom = cssPx(bottomPx);
        left = cssPx(leftPx);

        final WebView w = web;
        if (w == null) return;
        w.post(new Runnable() {
            @Override
            public void run() {
                w.evaluateJavascript(
                        "window.ShiBoNative&&window.ShiBoNative.onInsets&&window.ShiBoNative.onInsets()", null);
            }
        });
    }

    private int cssPx(int px) {
        if (px <= 0 || density <= 0f) return 0;
        return (int) Math.ceil(px / density);
    }

    static String versionName(Context ctx) {
        try {
            String v = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }
}
