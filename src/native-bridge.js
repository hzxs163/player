// 安卓套壳的接缝：页面里播的是同一个播放器，但锁屏/通知栏要能看见并在控制，
// 所以宿主（原生侧）注入 window.ShiBoMedia 收播放状态，我们把 window.ShiBoNative
// 挂回去接它点来的播控键。浏览器里没有 ShiBoMedia，整套东西就是一个不发声的对象。
//
// 第三条接缝是「这个壳是谁、系统栏占了多大地方」（window.ShiBoShell）：状态栏压住顶栏这件事
// 只有原生量得准，但让原生自己改布局（给 WebView 加 padding）在真机上治不好，所以改成
// 原生报数、页面自己加 padding——数值同时显示在设置抽屉里，坏了能一眼看出是量错还是没装上。

// 宿主给的 "上 右 下 左"（CSS px，原生已按 density 换算过）解成四个数。
// 形状不对就当没有：宁可不留白，也不能让一个坏字符串把顶栏推出屏幕。
export function parseInsets(raw) {
  const parts = String(raw == null ? '' : raw).trim().split(/[\s,]+/).filter((s) => s.length);
  if (parts.length !== 4) return [0, 0, 0, 0];
  const nums = parts.map(Number);
  if (!nums.every((v) => Number.isFinite(v) && v >= 0)) return [0, 0, 0, 0];
  return nums.map((v) => Math.round(v));
}

// kind 用宿主的词（toggle/next/prev），落到页面上由调用方给具体动作，
// 这里不碰 DOM，node 里塞个假 window 就能把两条路径都跑一遍。
export function createShell(win, handlers) {
  const media = win && win.ShiBoMedia;
  const bridge = win && win.ShiBoShell;
  const live = !!media && typeof media.setPlaying === 'function';
  const hasBridge = !!bridge && typeof bridge.insets === 'function';

  function read() {
    if (!hasBridge) return [0, 0, 0, 0];
    try {
      return parseInsets(bridge.insets());
    } catch {
      return [0, 0, 0, 0];
    }
  }

  // 跨 JS 桥的调用都当它会抛：Activity 没了、桥断了，页面不该跟着黑屏
  function ask(fn) {
    if (!hasBridge || typeof fn !== 'function') return '';
    try {
      return String(fn.call(bridge) || '');
    } catch {
      return '';
    }
  }

  function tell(px) {
    const fn = handlers && handlers.onInsets;
    if (typeof fn !== 'function') return;
    try {
      fn(px);
    } catch { /* 布局回调炸了不该把宿主的派发顶回来 */ }
  }

  if (live) {
    win.ShiBoNative = {
      onTransport(kind) {
        const fn = handlers && handlers[kind];
        if (typeof fn !== 'function') return false;
        try {
          fn();
          return true;
        } catch {
          return false; // 通知栏点了个坏掉的台，不能让原生侧以为成功了
        }
      },
      // 无参：数值只从 insets() 这一个口子出，宿主那声「变了」只是个门铃，
      // 门铃丢了也没关系——下面构造时拉的那一次就是页面起来时的最新值。
      onInsets() {
        const px = read();
        tell(px);
        return px;
      },
    };
  }

  const start = read();
  tell(start);

  return {
    native: live,
    version: ask(bridge && bridge.version),
    insets: start,
    // 每次状态机落定都发一遍：原生侧只认这一个入口，暂停就撤通知（不占前台服务）
    send(playing, title, sub) {
      if (!live) return;
      try {
        media.setPlaying(!!playing, String(title || ''), String(sub || ''));
      } catch { /* 宿主崩了不该让页面跟着崩 */ }
    },
  };
}
