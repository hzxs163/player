package com.shibo.app;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 壳内的两件事：把 APK 里那份页面当 https 站点喂给 WebView，以及不让这层壳变成随便乱跑的浏览器。
 *
 * 为什么不用 file:///android_asset/ 直接开：ES module 在 file:// 下按 CORS 处理，
 * import 会直接失败，页面一行 JS 都跑不起来。给一个虚拟 https 源既是安全上下文
 * （页面的 http 升级判断、fetch 都按线上那套走），又和 ShiBoStore 同一个源。
 *
 * 数据请求不在这儿拦：host 不是虚拟源的（Pages 的快照、上报镜像）照常走真实网络，
 * Pages 发了 Access-Control-Allow-Origin: *，跨源取数据是通的。
 */
final class ShellClient extends WebViewClient {

    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/assets/www/index.html";
    private static final String PREFIX = "/assets/";

    private static final String TAG = "ShellClient";

    private final Context ctx;

    ShellClient(Context ctx) {
        this.ctx = ctx;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !HOST.equals(uri.getHost())) return null;
        if (!"GET".equals(request.getMethod())) return empty(405, "method not allowed");

        String path = uri.getPath();
        if (path == null || !path.startsWith(PREFIX)) return empty(404, "not found");
        // /assets/<x> 直接映射到资产里的 <x>：页面放在 www/ 下，所以它发来的相对请求
        // （/assets/www/src/main.js）解出来就是 www/src/main.js。顺手把目录穿越挡在解码这一步
        String rel = decode(path.substring(PREFIX.length()));
        if (rel == null) return empty(403, "forbidden");

        String asset = rel;
        InputStream in = null;
        try {
            in = ctx.getAssets().open(asset);
        } catch (Exception e) {
            Log.w(TAG, "资产读不到：" + asset);
            return empty(404, "not found");
        }
        Map<String, String> headers = new HashMap<>();
        // 装在 APK 里的文件跟着版本走，不留缓存：覆盖安装后 reload 必须看见新代码
        headers.put("Cache-Control", "no-store");
        WebResourceResponse res = new WebResourceResponse(mime(rel), "utf-8", 200, "OK", headers, in);
        return res;
    }

    /** 只做正斜杠分段，拒绝 .. 和绝对路径；返回 null 表示这请求不该被应答。 */
    private static String decode(String raw) {
        if (raw == null || raw.isEmpty() || raw.startsWith("/")) return null;
        StringBuilder out = new StringBuilder();
        for (String seg : raw.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) return null;
            if (out.length() > 0) out.append('/');
            out.append(seg);
        }
        String s = out.toString();
        return s.isEmpty() ? "index.html" : s;
    }

    private static WebResourceResponse empty(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason,
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "html": return "text/html";
            case "css": return "text/css";
            case "js": case "mjs": return "text/javascript";
            case "json": return "application/json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "webp": return "image/webp";
            case "woff2": return "font/woff2";
            case "ico": return "image/x-icon";
            // .gz 必须按原始字节给（Pages 也是 application/octet-stream），页面自己用
            // DecompressionStream 解；写成 gzip 会让两边行为不一致
            case "gz": return "application/octet-stream";
            default: return "application/octet-stream";
        }
    }

    /**
     * 壳内只认自己的页面。其余 http(s) 交外部浏览器，自定义协议一律不吃
     * （不然一条 javascript:/intent:/file: 链接就能借这个 WebView 越出去）。
     */
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null) return true;
        if ("https".equals(uri.getScheme()) && HOST.equals(uri.getHost())) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
            openExternal(uri);
            return true;
        }
        Log.w(TAG, "拦下可疑跳转：" + scheme);
        return true;
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "没有能处理这个链接的应用");
        }
    }
}
