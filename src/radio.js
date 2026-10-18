// 与 Radio Browser 官方 API 打交道的部分：镜像选择、点击/投票上报、播放超时策略。
// URL 构造和策略判定都是纯函数，Node 可单测。
export const MIRRORS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info'];

// 官方要求：随机选镜像分摊负载，并带可识别的 User-Agent
export function pickMirror(rand = Math.random, list = MIRRORS) {
  return list[Math.floor(rand() * list.length) % list.length];
}

// 实测（2026-10-18，源码 api_axum/mod.rs + api/mod.rs:688）：
// 点击计数就是 GET /json/url/{uuid} 本身，服务端按 IP 在 click_valid_timeout 内去重；
// 没有 /click 后缀这条路由（返回 404）。投票是 /json/vote/{uuid}。
export function clickUrl(uuid, mirror = pickMirror()) {
  return `https://${mirror}/json/url/${encodeURIComponent(uuid)}`;
}

export function voteUrl(uuid, mirror = pickMirror()) {
  return `https://${mirror}/json/vote/${encodeURIComponent(uuid)}`;
}

// 上报是「锦上添花」：失败只记状态，绝不影响收听。
// 官方建议带可识别 UA，但浏览器禁止脚本设置 User-Agent 头，这里只能靠 Origin 认人
export async function report(kind, uuid, fetchImpl = fetch, mirror = pickMirror()) {
  const url = kind === 'vote' ? voteUrl(uuid, mirror) : clickUrl(uuid, mirror);
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    return { ok: res.ok, status: res.status, url };
  } catch (e) {
    return { ok: false, status: 0, url, error: e.message };
  }
}

// 播放失败判定：这些串来自浏览器对不可播流的报错文本，命中即换台（同一台重试没意义）
const FATAL_HINTS = [
  'no supported audio source', 'fourOhFour', 'mediawatchederror',
  'load interrupted', 'aborted', 'caused by: disallowed by ruleset',
  // 解码失败与「这个源根本不是音频」：重试同一台永远同样结果，不该走退避
  'media_err_src_not_supported', 'media_err_decode', 'src_not_supported',
];

export function isFatalMediaError(message = '') {
  const s = String(message).toLowerCase();
  return FATAL_HINTS.some((h) => s.includes(h));
}

// MediaError.message 在 Chrome/Firefox 里基本是空串，真正有信息量的是 code（1..4）；
// 直接把 e.message 当原因会让所有硬失败都退化成「起播失败（）」，fatal 判定永远命不中
const MEDIA_ERR = {
  1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};
export function mediaErrorText(err) {
  if (!err) return 'error';
  const name = err.name || MEDIA_ERR[err.code] || '';
  const msg = err.message || '';
  return `${name} ${msg}`.trim() || `code ${err.code}` || 'error';
}

// 起播等待：连了但多少秒内没有任何数据就判定为死台
export const START_TIMEOUT_MS = 12000;
export const STALL_RESUME_MS = 8000;

// 状态机：只允许 idle/loading/playing/paused/error 之间的这些迁移
const TRANSITIONS = {
  idle: ['loading'],
  loading: ['playing', 'paused', 'error', 'loading'],
  playing: ['paused', 'error', 'loading', 'stalled'],
  stalled: ['playing', 'error', 'loading', 'paused'],
  paused: ['loading', 'playing', 'error'],
  error: ['loading', 'idle'],
};

export function canGo(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// 连续失败保护：连着 N 台都起不来就拉长换台间隔，别把浏览器和 API 一起刷爆
export function nextRetryDelay(failStreak, base = 600) {
  if (failStreak <= 0) return base;
  return Math.min(8000, base * 2 ** Math.min(failStreak, 4));
}

export function shouldAutoSkip(failStreak, max = 12) {
  return failStreak < max;
}
