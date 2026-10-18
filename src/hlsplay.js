// HLS 播放：只在第一次真的碰到 .m3u8 时才把 hls.js 拉下来（113KB gzip），
// 主包和地图数据都不为此买单。Safari/iOS 走原生，不加载这个库。
let libPromise = null;

export function loadHlsLib() {
  if (!libPromise) {
    libPromise = import('../vendor/hls.light.min.mjs')
      .then((m) => m.default)
      // 拉库失败要把缓存清掉，否则一次网络抖动就永久播不了 HLS
      .catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

// 返回 { src, destroy }。src 是挂上 MSE 之后 <audio> 的实际地址（blob:），
// 调用方要拿它当「本次尝试」的认脸依据，否则换台后旧事件会被算到新台上。
export async function attachHls(audio, url, hooks = {}) {
  const Hls = await loadHlsLib();
  const hls = new Hls({
    enableWorker: false, // 单个直播音频流不值得开 worker
    lowLatencyMode: false,
    backBufferLength: 30,
    liveDurationInfinity: true,
  });
  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data.fatal) {
      if (hooks.onNote) hooks.onNote(data.details);
      return;
    }
    // 直播断流是常态：网络和媒体错误先按官方姿势自愈一次，自愈不了才交给换台逻辑
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { if (hooks.onNote) hooks.onNote('重连'); hls.startLoad(); return; }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { if (hooks.onNote) hooks.onNote('解码自愈'); hls.recoverMediaError(); return; }
    if (hooks.onFatal) hooks.onFatal(`hls ${data.type}/${data.details}`);
  });
  hls.attachMedia(audio);
  hls.loadSource(url);
  return {
    get src() { return audio.src; },
    destroy() { hls.destroy(); },
  };
}
