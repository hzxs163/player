// 本地状态：历史、收藏、导出。存储对象注入，方便 Node 里用假 storage 单测。
export const HISTORY_CAP = 300;
export const FAV_CAP = 500;
const KEY_HISTORY = 'shibo.history.v1';
const KEY_FAV = 'shibo.favorites.v1';

function readJson(store, key, fallback) {
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v;
  } catch {
    return fallback; // 手动改坏过的 localStorage 不该让整页起不来
  }
}

function writeJson(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 隐私模式 / 配额满
  }
}

export function loadHistory(store) {
  const v = readJson(store, KEY_HISTORY, []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.uuid === 'string').slice(0, HISTORY_CAP) : [];
}

export function pushHistory(list, entry, cap = HISTORY_CAP) {
  const next = [entry, ...list.filter((e) => e.uuid !== entry.uuid)];
  return next.slice(0, cap);
}

export function saveHistory(store, list) {
  return writeJson(store, KEY_HISTORY, list);
}

export function loadFavorites(store) {
  const v = readJson(store, KEY_FAV, []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.uuid === 'string') : [];
}

export function toggleFavorite(list, entry) {
  const has = list.some((e) => e.uuid === entry.uuid);
  if (has) return { list: list.filter((e) => e.uuid !== entry.uuid), added: false };
  return { list: [entry, ...list].slice(0, FAV_CAP), added: true };
}

export function saveFavorites(store, list) {
  return writeJson(store, KEY_FAV, list);
}

export function isFavorite(list, uuid) {
  return list.some((e) => e.uuid === uuid);
}

// 导出 CSV：字段里可能有逗号/引号/换行，必须按 RFC4180 包起来
export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(',')]
    .concat(rows.map((r) => columns.map((c) => esc(r[c])).join(',')))
    .join('\r\n') + '\r\n';
}

export const HISTORY_COLUMNS = ['time', 'name', 'cc', 'country', 'votes', 'bitrate', 'url', 'uuid'];

// 睡眠定时：到点淡出停止。返回剩余秒数，纯算式可单测
export function sleepRemaining(nowMs, untilMs) {
  if (!untilMs) return 0;
  return Math.max(0, Math.round((untilMs - nowMs) / 1000));
}

export function sleepDeadline(nowMs, minutes) {
  return minutes > 0 ? nowMs + minutes * 60000 : 0;
}
