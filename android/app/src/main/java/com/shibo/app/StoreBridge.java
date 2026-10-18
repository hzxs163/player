package com.shibo.app;

import android.content.Context;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Pattern;

/**
 * 页面用的本机磁盘 window.ShiBoStore：契约见 src/cache.js（read/write/remove/list）。
 *
 * 快照解压后有 7.7 MB，localStorage 装不下（Chromium 一个源约 5~10 MB），所以走文件；
 * 断网时它就是「上次那版数据」，也是 app 能在飞机模式下开屏的原因。
 *
 * 文件名会被拼成真实路径，因此这里独立再校验一次：页面侧的白名单挡不住被改过的 JS，
 * 而 addJavascriptInterface 把这个对象暴露给了这个 WebView 加载的每一个页面。
 */
final class StoreBridge {

    private static final String TAG = "ShiBoStore";
    private static final Pattern NAME = Pattern.compile("[a-z0-9._-]{1,120}");
    // 一份快照 7.7 MB，留足余量；超过这个数的读取当它是个坏文件，别把进程顶穿
    private static final long MAX_BYTES = 64L * 1024 * 1024;

    private final File dir;

    StoreBridge(Context ctx) {
        dir = new File(ctx.getFilesDir(), "shibo-store");
        if (!dir.isDirectory()) dir.mkdirs();
    }

    private File resolve(String name) {
        if (name == null || !NAME.matcher(name).matches() || name.contains("..")) return null;
        File f = new File(dir, name);
        try {
            // 白名单已经排除了 / 和 \，这层是给将来放松白名单时兜底的
            String root = dir.getCanonicalPath();
            if (!f.getCanonicalPath().startsWith(root + File.separator)) return null;
        } catch (IOException e) {
            return null;
        }
        return f;
    }

    @JavascriptInterface
    public String read(String name) {
        File f = resolve(name);
        if (f == null || !f.isFile()) return null;
        long size = f.length();
        if (size <= 0 || size > MAX_BYTES) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.min(size, 1 << 20));
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            Log.w(TAG, "read " + name + " 失败", e);
            return null;
        }
    }

    @JavascriptInterface
    public boolean write(String name, String text) {
        File f = resolve(name);
        if (f == null || text == null) return false;
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        // 先写临时文件再改名：中途被杀就只剩 .tmp，不会留一份「看着完整其实半截」的快照骗过页面
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.getFD().sync();
        } catch (IOException e) {
            Log.w(TAG, "write " + name + " 失败", e);
            tmp.delete();
            return false;
        }
        if (!tmp.renameTo(f)) {
            Log.w(TAG, "rename 到 " + name + " 失败");
            tmp.delete();
            return false;
        }
        return true;
    }

    @JavascriptInterface
    public boolean remove(String name) {
        File f = resolve(name);
        if (f == null) return false;
        return !f.exists() || f.delete();
    }

    /** JSON 字符串数组。只收白名单形状的名字，所以拼串不需要转义。 */
    @JavascriptInterface
    public String list() {
        StringBuilder sb = new StringBuilder("[");
        File[] files = dir.listFiles();
        boolean first = true;
        if (files != null) {
            Arrays.sort(files);
            for (File f : files) {
                String n = f.getName();
                if (!f.isFile() || n.endsWith(".tmp") || !NAME.matcher(n).matches() || n.contains("..")) continue;
                if (!first) sb.append(',');
                sb.append('"').append(n).append('"');
                first = false;
            }
        }
        return sb.append(']').toString();
    }
}
