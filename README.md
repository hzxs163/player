# 拾波 · 随机电台收信台

打开就随机给你调到一个还在播的电台，可按国家 / 语言 / 风格 / 协议筛选，带收听历史和收藏。
纯静态站点，没有后端：电台数据来自 [radio-browser-snapshot](https://github.com/hzxs163/radio-browser-snapshot) 的每日快照。

线上地址：<https://hzxs163.github.io/player/>

## 数据从哪来

每天 CI 从 Radio Browser 官方 API 拉全量 CSV（69072 行），剔除官方判定已失效的台后产出前端数据集三件产物：

| 文件 | 内容 | 实测体量 |
| --- | --- | --- |
| `stations.web.json.gz` | 首行表头 JSON + 其后每行一条 NDJSON，12 列；`cc`/`country`/`lang`/`codec`/`tags` 存字典下标 | 2,145,514 B（未压缩 7,761,034 B），62022 行 |
| `stations.ids.json.gz` | 与主表逐行对齐的 `stationuuid` 数组，用于点击上报 | 1,198,162 B |
| `meta_web.json` | 行数、字典大小、sha256；播放器靠 `web_rows > 0` 判断这个源可用 | <1 KB |

页面按顺序探测数据源，第一个读得到 `meta_web.json` 的为准：

- 本地开发：`./data/`（只有 `localhost` / `127.0.0.1` 才会把这一项列进候选，线上不会白吃一个 404）
- 线上：`https://hzxs163.github.io/radio-browser-snapshot/`

## 本地跑

```bash
node scripts/serve.mjs        # http://127.0.0.1:8123，带与 Pages 一致的 CORS 头
node test/run.mjs             # 116 条断言，跑在真实快照上
```

`data/` 不进 git（3 MB 且每天变），要跑测试就从快照仓库取最新一份：

```bash
base=https://hzxs163.github.io/radio-browser-snapshot
mkdir -p data
for f in stations.web.json.gz stations.ids.json.gz meta_web.json; do
  curl -L -o data/$f $base/$f
done
```

## 结构

```
index.html            骨架与无障碍标签，无模板引擎
styles.css            设计令牌 + 三档断点（桌面双栏 / 平板单列 / 手机）
src/core.js           纯逻辑：解码、筛选、加权随机、坐标清洗、国家级统计
src/cache.js          本机快照缓存：按 generated_at 分版本、校验、后台换新、清旧版
src/native-bridge.js  安卓宿主的接缝（ShiBoMedia / ShiBoNative），浏览器里全程哑火
src/listview.js       虚拟列表（只渲染视口内的行）
src/radio.js          播放地址决策、镜像选择、点击上报
src/hlsplay.js        hls.js 接管 .m3u8
src/store.js          历史 / 收藏的 localStorage 编解码
src/main.js           装配层：状态机、事件、载入流程
vendor/               hls.js light 构建（MIT，许可证同目录）
android/              安卓套壳工程（见文末「安卓壳」）
scripts/sync-www.mjs  把 Pages 那份站点原样打进 APK 的 assets/www
scripts/verify-apk.mjs 校验 APK：页面字节、dex 里的类、签名证书
```

## 几个踩过就知道的坑

- **Chromium 播 `.m3u8` 不报错，只是永远不 `playing`**。所以 m3u8 一律走 hls.js（MSE），只有 `canPlayType()` 返回 `probably` 的（Safari）才交给原生 `<audio>`。
- **`http://127.0.0.1` 也算安全上下文**，页面里的 http 流会被当成混合内容拦掉。判断用 `self.isSecureContext`，不能用 `location.protocol === 'https:'`。
- **经纬度是电台自己填的**，实测有 100.5°N、−273°W 这种越界值，解码时统一打回「无坐标」，否则国家质心被拉偏、当地时间算出负数。
- **快照每天重排**，所以收藏和历史存 `stationuuid` 而不是数组下标；下标只在当天有效。
- 数据是 `.gz` 直发（不设 `Content-Encoding`），浏览器用 `DecompressionStream` 解，这样进度条量的是真实下载字节。

## 部署

`.github/workflows/deploy-pages.yml`：push 到 `main` 触发，挑出运行时的文件（不含 `data/`、`test/`、`scripts/`）作为 Pages 产物发布，线上根路径就是 `index.html`。

Pages 站点本身要先用 REST 建成 workflow 构建方式（`POST /repos/hzxs163/player/pages`，body `{"build_type":"workflow"}`）：`configure-pages` 的 `enablement` 用 GITHUB_TOKEN 建站点会被账号设置挡掉，报 `Resource not accessible by integration`。建好之后每次 push 自动发版，不用再碰开关。

## 安卓壳

`android/` 是一个零第三方依赖的 Gradle 工程（纯 Java + 框架 API，没有 androidx），把上面那份站点装进 APK 里跑：

- **页面走虚拟 https 源**（`https://appassets.androidplatform.net/assets/www/index.html`，由 `ShellClient` 从 assets 应答）。不能用 `file:///android_asset/`：ES module 在那个协议下按 CORS 处理，一行 JS 都跑不起来。虚拟源同时是安全上下文，页面的 http 升级判断和线上行为一致。
- **数据不打包**，仍从 `hzxs163.github.io/radio-browser-snapshot/` 取（Pages 发了 `Access-Control-Allow-Origin: *`，跨源可读）。这样电台数据天天新，APK 不必跟着重出。
- **本地优先靠 `ShiBoStore`**：`window.ShiBoStore` 是 `StoreBridge` 暴露的私有目录文件读写，页面 `src/cache.js` 用它存 7.7 MB 的解压快照（localStorage 装不下）。首次运行下载存盘；之后开屏先读磁盘秒开，版本旧了再后台重下一份写盘，本次收听不打断；断网时用上次那份并写明「本机快照（离线）」。
- **后台继续播**：`PlayService` 是 `mediaPlayback` 前台服务 + `MediaSession`，通知栏三个键通过 `evaluateJavascript` 打回页面的 `window.ShiBoNative.onTransport`，动作直接点在现有按钮上（判断逻辑只有一份）。`MainActivity.onPause()` 故意不调 `webView.onPause()`——那会让 Chromium 挂起音频，锁屏就断了。
- **签名用仓库内置的 `android/keystore/shibo.p12`**（别名 `shibo`，口令写在 `android/app/build.gradle`）。这是为了让每次构建出同一个签名，覆盖安装不会 `INSTALL_FAILED_UPDATE_INCOMPLETE`；代价是这把钥匙对所有人可见——它只用于这一个 app，任何别的发布物都不要复用它。

发版：打标签 `app-v1.0.0` 推上去，`.github/workflows/build-app.yml` 会构建 release APK、校验（页面字节 = 构建清单 = 仓库文件；类在 dex 里；签名证书就是仓库那张），再把它作为 GitHub Release 资产发布。也可以手动触发 workflow 填版本号重出。

本机构建不了（没有 JDK/Android SDK），Gradle 与 Java 的编译正确性以 CI 首次运行为准。
