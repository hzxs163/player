// 快照本地缓存。装了原生存储的宿主（安卓套壳）里：先读磁盘秒开，再在后台把这一版换到本地，
// 下次打开就是最新的；浏览器里没有这个能力，整套逻辑直接跳过，页面行为一个字都不变。
//
// 关键约束：fetch / XMLHttpRequest 拿不到自定义响应头，所以「命中哪一版」不能靠头部判断，
// 只能用 meta_web.json 里的 generated_at 当版本凭据 —— 它是每次构建唯一的值。
// 存储能力由宿主注入，这里只认接口形状、不认 window，node 里传假实现就能跑完整流程。

export const WEB_SNAPSHOT = {
  prefix: 'shibo.snap.',
  file: 'stations.web.json.gz',
  bytesKey: 'gz_bytes',
  shaKey: 'sha256_gz',
  rowsKey: 'web_rows',
  kind: 'dataset',
};

// 电台 id 表决定播放和上报指向哪一台，每次开屏都重下 1.2MB 不值得，一起进缓存
export const IDS_SNAPSHOT = {
  prefix: 'shibo.ids.',
  file: 'stations.ids.json.gz',
  bytesKey: 'ids_gz_bytes',
  shaKey: 'ids_sha256_gz',
  rowsKey: 'ids_rows',
  kind: 'ids',
};

export const REC_SUFFIX = '.rec';

// 名字会被宿主拼成真实文件路径，所以白名单卡死：只许小写字母数字点横线下划线，且不许 ..
const NAME_RE = /^[a-z0-9._-]{1,120}$/;

export function isSafeName(n) {
  return typeof n === 'string' && NAME_RE.test(n) && !n.includes('..');
}

// generated_at 里的冒号不能进文件名，ISO 的 T/Z 也一并换成下划线：出来的名字必须落在 isSafeName
// 的纯小写白名单里（宿主拿它直接拼文件路径），同时字典序仍等于时间序、且不会撞车。
export function keyFor(v, version) {
  return version ? v.prefix + String(version).replace(/[^a-z0-9._-]/g, '_') : null;
}

export function snapKey(meta, v = WEB_SNAPSHOT) {
  return keyFor(v, meta && (meta.generated_at || meta[v.shaKey]));
}

export function recKey(key) {
  return key ? key + REC_SUFFIX : null;
}

export function recordOf(meta, v = WEB_SNAPSHOT) {
  return JSON.stringify({
    generated_at: (meta && meta.generated_at) || null,
    sha: (meta && meta[v.shaKey]) || null,
    bytes: Number(meta && meta[v.bytesKey]) || 0,
    rows: Number(meta && meta[v.rowsKey]) || 0,
  });
}

// 缓存里的记录和线上这份 meta 是不是同一版
export function recordMatches(recRaw, meta, v = WEB_SNAPSHOT) {
  let rec = null;
  try {
    rec = recRaw == null ? null : typeof recRaw === 'string' ? JSON.parse(recRaw) : recRaw;
  } catch {
    return false;
  }
  if (!rec || typeof rec !== 'object') return false;
  const want = meta && (meta.generated_at || meta[v.shaKey]);
  if (!want) return false; // 版本凭据都没了就当没缓存，宁可重下也不悄悄用着一版说不清的
  if ((rec.generated_at || rec.sha) !== want) return false;
  const rows = Number(meta[v.rowsKey]) || 0;
  return rows > 0 ? Number(rec.rows) === rows : true;
}

// 只验形状不逐行解：真解析交给 parseDataset/decodeIds，这里挡掉「下到一半就断」的半截文件
export function looksComplete(text, v = WEB_SNAPSHOT) {
  if (typeof text !== 'string' || text.length < 1024) return false;
  if (v.kind === 'ids') return text.trimStart().startsWith('[') && text.trimEnd().endsWith(']');
  const nl = text.indexOf('\n');
  if (nl < 0) return false;
  const head = text.slice(0, nl);
  return head.includes('"fields"') && head.includes('"dict"');
}

// 换版后旧的整份快照要清掉：一份 7.6MB，留三五份就把私有目录撑满了。keep 含当前这份
export function pruneNames(names, keepKey, keep = 2, v = WEB_SNAPSHOT) {
  const list = (Array.isArray(names) ? names : []).filter(
    (n) => typeof n === 'string' && n.startsWith(v.prefix) && !n.endsWith(REC_SUFFIX) && n !== keepKey,
  );
  return list.sort().reverse().slice(Math.max(0, keep - 1));
}

export async function sha256Hex(bytes) {
  const c = globalThis.crypto;
  if (!c || !c.subtle || !bytes || !bytes.byteLength) return null;
  try {
    const d = await c.subtle.digest('SHA-256', bytes);
    let s = '';
    for (const b of new Uint8Array(d)) s += b.toString(16).padStart(2, '0');
    return s;
  } catch {
    return null;
  }
}

// 线上没给哈希（老快照、本地开发数据）时不能把用户挡在门外，跳过校验但别假装验过
export function shaMatches(want, got) {
  if (!want || !got) return true;
  return String(want).toLowerCase() === String(got).toLowerCase();
}

export function bridgeStore(b) {
  const call = (m, ...a) => {
    try {
      const f = b && b[m];
      return typeof f === 'function' ? f.apply(b, a) : null;
    } catch {
      return null;
    }
  };
  return {
    async read(name) {
      if (!isSafeName(name)) return null;
      const v = call('read', name);
      return v == null || v === '' ? null : String(v);
    },
    async write(name, text) {
      if (!isSafeName(name) || typeof text !== 'string') return false;
      return call('write', name, text) === true; // 宿主崩了/没回话都算没存住，别装作写进去了
    },
    async remove(name) {
      if (!isSafeName(name)) return false;
      return call('remove', name) === true;
    },
    async list() {
      try {
        const v = JSON.parse(call('list') || '[]');
        return Array.isArray(v) ? v.filter(isSafeName) : [];
      } catch {
        return [];
      }
    },
  };
}

export function storeOf(w) {
  const b = w && w.ShiBoStore;
  return b && typeof b.read === 'function' && typeof b.write === 'function' ? bridgeStore(b) : null;
}

// 行数对齐是「这份缓存能用」最硬的证据：半截文件、跨版本都会在这里露出来
export function rowsMatch(rows, meta, v = WEB_SNAPSHOT) {
  const want = Number(meta && meta[v.rowsKey]) || 0;
  return Array.isArray(rows) && (want === 0 || rows.length === want);
}

// ids 表必须和「内存里这份数据集」同版：下标错位会把点击上报到另一台台上去。
// 记录里认不出版本时宁可当作不可用，也别装作对齐过。
export function versionOf(recordRaw, fallback) {
  try {
    const r = recordRaw == null ? null : typeof recordRaw === 'string' ? JSON.parse(recordRaw) : recordRaw;
    return (r && (r.generated_at || r.sha)) || fallback || '';
  } catch {
    return fallback || '';
  }
}

export async function readCache(store, meta, v = WEB_SNAPSHOT) {
  if (!store) return null;
  const key = snapKey(meta, v);
  if (!key) return null;
  const rec = await store.read(recKey(key));
  if (!recordMatches(rec, meta, v)) return null;
  const text = await store.read(key);
  if (!looksComplete(text, v)) {
    await store.remove(key);
    await store.remove(recKey(key));
    return null;
  }
  return { key, text, record: rec };
}

// 本地优先的正解：只要磁盘上有完整的一份就先拿它开屏，版本对不对交给后台去补。
// 断网时 meta 都取不到，这一步是唯一还能起动的路径，所以它必须不看 meta。
// wantVersion 用来挑「和数据集同版」的那一份（ids 表需要）：优先精确命中，都没有才退回最新的一份。
export async function newestCached(store, v = WEB_SNAPSHOT, wantVersion = '') {
  if (!store) return null;
  const names = (await store.list())
    .filter((n) => n.startsWith(v.prefix) && !n.endsWith(REC_SUFFIX))
    .sort()
    .reverse(); // key 尾巴是 ISO 时间，字典序就是新旧序
  let fallback = null;
  for (const key of names) {
    const rec = await store.read(recKey(key));
    const text = await store.read(key);
    if (!looksComplete(text, v)) {
      await store.remove(key);
      await store.remove(recKey(key));
      continue;
    }
    const found = { key, text, record: rec };
    if (wantVersion && versionOf(rec, '') === wantVersion) return found;
    if (!fallback) fallback = found;
  }
  return fallback;
}

export async function writeCache(store, meta, text, v = WEB_SNAPSHOT) {
  if (!store) return false;
  const key = snapKey(meta, v);
  if (!key || !looksComplete(text, v)) return false;
  if (!(await store.write(key, text))) return false;
  const ok = await store.write(recKey(key), recordOf(meta, v));
  for (const n of pruneNames(await store.list(), key, 2, v)) {
    await store.remove(n);
    await store.remove(recKey(n));
  }
  return ok;
}
