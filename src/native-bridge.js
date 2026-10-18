// 安卓套壳的接缝：页面里播的是同一个播放器，但锁屏/通知栏要能看见并在控制，
// 所以宿主（原生侧）注入 window.ShiBoMedia 收播放状态，我们把 window.ShiBoNative
// 挂回去接它点来的播控键。浏览器里没有 ShiBoMedia，整套东西就是一个不发声的对象。

// kind 用宿主的词（toggle/next/prev），落到页面上由调用方给具体动作，
// 这里不碰 DOM，node 里塞个假 window 就能把两条路径都跑一遍。
export function createShell(win, handlers) {
  const media = win && win.ShiBoMedia;
  const live = !!media && typeof media.setPlaying === 'function';

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
    };
  }

  return {
    native: live,
    // 每次状态机落定都发一遍：原生侧只认这一个入口，暂停就撤通知（不占前台服务）
    send(playing, title, sub) {
      if (!live) return;
      try {
        media.setPlaying(!!playing, String(title || ''), String(sub || ''));
      } catch { /* 宿主崩了不该让页面跟着崩 */ }
    },
  };
}
