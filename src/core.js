// 数据层：解码前端数据集、按条件筛选、加权随机、国家质心。
// 不碰 DOM，Node 里可直接 import 单测：node test/run.mjs
// 键名与数据集列名逐字一致：parseDataset 会按名字校验，名字对不上就是加载失败
export const COL = {
  name: 0, url_resolved: 1, cc: 2, country: 3, lang: 4, tags: 5,
  votes: 6, bitrate: 7, codec: 8, hls: 9, lat: 10, lon: 11,
};

// gzip 解压：浏览器走 DecompressionStream，没有就报错（不做同步兜底，宁可明确失败）
export async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('这个浏览器不支持 DecompressionStream(gzip)，需要 Chrome 111+/Safari 16.4+/Firefox 115+');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isSecureUrl(u) {
  return typeof u === 'string' && u.startsWith('https://');
}

// 数据集的 hls 列不可全信（有 .m3u8 却标 0 的），判定以地址为准
export function isHlsUrl(u) {
  return /\.m3u8(\?|$)/i.test(String(u || ''));
}

// http 源在 https 页面下必挂（混合内容）。国内 CDN 常见「只登记了 http，但 https 也通」，
// 所以显式升级一次，成了就能播。带端口的不换（端口后面往往只监听 http），localhost 不换
export function upgradeToHttps(u) {
  const s = String(u || '');
  if (!s.startsWith('http://')) return '';
  const rest = s.slice(7);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (!host || host.includes(':') || host === 'localhost') return '';
  return 'https://' + rest;
}

// HLS 怎么放：Safari/iOS 原生能放；其余浏览器要靠 hls.js 走 MSE。
// Chromium 的 canPlayType('application/vnd.apple.mpegurl') 会客气地回 "maybe" 但其实放不了，
// 所以只认 "probably"
export function hlsMode(audio) {
  const native = audio && typeof audio.canPlayType === 'function'
    && audio.canPlayType('application/vnd.apple.mpegurl') === 'probably';
  if (native) return 'native';
  return typeof globalThis.MediaSource === 'function' ? 'lib' : 'none';
}

// 文件结构：第 1 行是 {fields, dict}，其后每行一条电台（值按 fields 下标的数组）
export function parseDataset(u8) {
  return parseDatasetText(new TextDecoder().decode(u8));
}

// 缓存命中时手上已经是解码好的文本了，别为了复用同一个解析器再编一遍 7.6MB 的字节
export function parseDatasetText(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('数据集格式不对：没有表头行');
  const header = JSON.parse(text.slice(0, nl));
  const fields = header.fields;
  for (const k of Object.keys(COL)) {
    if (!fields.includes(k)) throw new Error(`数据集缺少列 ${k}`);
  }
  const col = {};
  fields.forEach((f, i) => { col[f] = i; });
  const rows = [];
  let start = nl + 1;
  for (;;) {
    const next = text.indexOf('\n', start);
    const chunk = next < 0 ? text.slice(start) : text.slice(start, next);
    if (chunk.length) {
      const row = JSON.parse(chunk);
      // 经纬度是电台自己填的，实测有 100.5°N、-273°W 这种越界值：一律降级成「没坐标」。
      // 不然国家质心被拉偏、当地时间算出负数小时，面板还理直气壮地把假坐标显示出来
      const lat = row[col.lat], lon = row[col.lon];
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) { row[col.lat] = 0; row[col.lon] = 0; }
      rows.push(row);
    }
    if (next < 0) break;
    start = next + 1;
  }
  return { header, dict: header.dict, col, rows };
}

export function decodeIds(u8) {
  return decodeIdsText(new TextDecoder().decode(u8));
}

export function decodeIdsText(text) {
  const v = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error('id 表格式不对：不是数组');
  return v;
}

export function tagNames(dict) {
  return dict.tags;
}

export function stationTags(ds, row) {
  return row[ds.col.tags].map((i) => ds.dict.tags[i]).filter((s) => s != null);
}

export function stationCountry(ds, row) {
  return ds.dict.country[row[ds.col.country]] || ds.dict.cc[row[ds.col.cc]] || '未知';
}

export function stationCc(ds, row) {
  return ds.dict.cc[row[ds.col.cc]] || '';
}

export function stationLang(ds, row) {
  return ds.dict.lang[row[ds.col.lang]] || '';
}

export function stationCodec(ds, row) {
  return ds.dict.codec[row[ds.col.codec]] || '';
}

// 数据集把「没填」也当成一种编码写进字典（UNKNOWN 占了几千行），显示时要当没有
export function codecName(ds, row) {
  const raw = stationCodec(ds, row);
  return raw && raw !== 'UNKNOWN' ? raw : '';
}

// 播放地址最长的一条有 7.8K 字符（p99 也到 246），直接塞进面板会把版式顶爆，
// 所以显示先截断，完整地址留给 title。「为什么播不了」得能一眼看到真实地址。
export function clipUrl(u, max = 120) {
  const s = String(u || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// 一行里要说清「怎么播」：数据集里 15% 的台没填码率、codec 又常写 UNKNOWN，
// 所以缺什么就省什么，拼出「MP3 128k」「HLS」「AAC+」，绝不留「?」——「MP3 ?k」看着像页面坏了。
// 编码名优先，只有它缺失时才拿 HLS 顶上（收信参数那行永远会标出 HLS）
export function codecBitrate(ds, row) {
  const head = codecName(ds, row) || (isHlsUrl(row[ds.col.url_resolved]) ? 'HLS' : '');
  const br = Number(row[ds.col.bitrate]) || 0;
  if (head) return br ? `${head} ${br}k` : head;
  return br ? `${br}k` : '未知';
}

// 26 个字母码 -> emoji 旗帜；非法码给一个占位方块而不是崩溃
export function flagEmoji(cc) {
  if (!/^[A-Z]{2}$/.test(String(cc))) return '⬜';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 - 65 + c.charCodeAt(0)));
}

// 筛选条件求值：返回下标数组（不复制行对象，6 万行的引用拷贝比条件本身还贵）
export function applyFilter(ds, rows, cond) {
  const out = [];
  const c = COL;
  const wantedCc = cond.ccs && cond.ccs.size ? cond.ccs : null;
  const wantedLang = cond.langs && cond.langs.size ? cond.langs : null;
  const q = cond.query ? cond.query.toLowerCase() : '';
  const anyTag = cond.tags && cond.tags.size ? cond.tags : null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (cond.secureOnly && !isSecureUrl(r[c.url_resolved])) continue;
    // 排除 HLS 时也要看地址：数据里有 .m3u8 却把 hls 标成 0 的行，光看标记会漏
    if (cond.hideHls && (r[c.hls] === 1 || isHlsUrl(r[c.url_resolved]))) continue;
    if (cond.geoOnly && (r[c.lat] === 0 || r[c.lon] === 0)) continue;
    if (cond.minVotes > 0 && r[c.votes] < cond.minVotes) continue;
    if (cond.minBitrate > 0 && r[c.bitrate] < cond.minBitrate) continue;
    if (wantedCc && !wantedCc.has(ds.dict.cc[r[c.cc]] || '')) continue;
    if (wantedLang && !wantedLang.has(r[c.lang])) continue;
    if (anyTag) {
      const t = r[c.tags];
      let hit = false;
      for (let k = 0; k < t.length; k++) if (anyTag.has(t[k])) { hit = true; break; }
      if (!hit) continue;
    }
    if (q && !rowMatches(ds, r, q)) continue;
    out.push(i);
  }
  return out;
}

// 空格分隔的词全部命中即可，别做模糊匹配——电台名里噪声太多，糊出来的结果更没用。
// 名字没命中再看 tags：中文台/本地写法常常只存在于标签里（搜「福建」要能出厦门台），
// 但只在名字失败时才拼这根稻草，否则 6 万行每行都要多走一遍字符串拼接
function rowMatches(ds, r, q) {
  const words = q.split(/\s+/).filter(Boolean);
  const name = String(r[COL.name] || '').toLowerCase();
  if (words.every((w) => name.includes(w))) return true;
  const tags = r[COL.tags];
  if (!tags || !tags.length) return false;
  let hay = name;
  for (const t of tags) {
    const s = ds.dict.tags[t];
    if (s) hay += ' ' + s.toLowerCase();
  }
  return words.every((w) => hay.includes(w));
}

// 权重：votes 优先，其次有坐标（地图点得到）、码率高、名字非空。
// 用 log 压缩票数，避免新台永远抢不到曝光
export function weightOf(r, fallback = 1) {
  const votes = r[COL.votes];
  const w = 1
    + Math.log10(1 + Math.max(0, votes)) * 3
    + (r[COL.lat] !== 0 && r[COL.lon] !== 0 ? 1.5 : 0)
    + Math.min(2, r[COL.bitrate] / 128)
    + (r[COL.hls] === 1 ? -1.5 : 0);
  return Math.max(fallback, w);
}

export function totalWeight(rows, indices) {
  let sum = 0;
  for (const i of indices) sum += weightOf(rows[i]);
  return sum;
}

export function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 加权抽样 + 近期不重复（recent 是一个环形数组，存最近用过的下标）
export function pickWeighted(rows, indices, rng, recent = [], avoidIdx = -1) {
  if (!indices.length) return -1;
  const recentSet = new Set(recent);
  const cand = indices.filter((i) => !recentSet.has(i) && i !== avoidIdx);
  const pool = cand.length >= 3 ? cand : indices.filter((i) => i !== avoidIdx);
  if (!pool.length) return indices[0];
  let sum = 0;
  for (const i of pool) sum += weightOf(rows[i]);
  let x = rng() * sum;
  for (const i of pool) {
    x -= weightOf(rows[i]);
    if (x <= 0) return i;
  }
  return pool[pool.length - 1];
}

export function rememberRecent(recent, idx, cap = 400) {
  recent.push(idx);
  if (recent.length > cap) recent.splice(0, recent.length - cap);
  return recent;
}

// 国家级统计：质心只用于放「这一国有多少台」的角标，不拿来冒充电台位置。
// 键是国家码字符串——字典下标每天会变，用下标当键会让跨天的收藏/角标全部错位。
export function countryStats(ds) {
  const ccByIdx = ds.dict.cc;
  const acc = new Map();
  for (const r of ds.rows) {
    const cc = ccByIdx[r[COL.cc]];
    if (!cc) continue;
    let a = acc.get(cc);
    if (!a) { a = { cc, n: 0, nGeo: 0, lat: 0, lon: 0, nameIdx: r[COL.country] }; acc.set(cc, a); }
    a.n++;
    if (r[COL.lat] !== 0 && r[COL.lon] !== 0) { a.nGeo++; a.lat += r[COL.lat]; a.lon += r[COL.lon]; }
  }
  const out = new Map();
  for (const [cc, a] of acc) {
    out.set(cc, {
      cc, n: a.n, nGeo: a.nGeo, nameIdx: a.nameIdx,
      // 只有画得出来的台才给质心；一个都画不出就留 null，宁可没角标也不放错位置
      lat: a.nGeo ? a.lat / a.nGeo : null,
      lon: a.nGeo ? a.lon / a.nGeo : null,
    });
  }
  return out;
}

// 客户端在哪个国家：只用时区和语言标签推断。
// 请求 Geolocation 要弹权限，而「默认选中中国」这点便利根本不值这个打扰；
// 推错了用户点一下就改，所以这里宁可不精确也不弹窗
const CN_TZ = /^Asia\/(Shanghai|Chongqing|Urumqi|Harbin|Kashgar|Beijing)$/;
export function guessUserCc({ timeZone = '', language = '' } = {}) {
  if (CN_TZ.test(String(timeZone))) return 'CN';
  const lang = String(language || '').toLowerCase().replace(/_/g, '-');
  const m = /^([a-z]{2,3})-([a-z]{2})$/.exec(lang);
  if (m) return m[2].toUpperCase();
  if (lang === 'zh-cn' || lang === 'zh-hans-cn' || lang === 'zh-hans') return 'CN';
  return '';
}

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 调谐刻度：以当前台为中心，取筛选结果里左右各 span 台。
// 邻居按 indices 的顺序排（也就是快照里的稳定序），所以「往右一格」是可复现的，
// 不是再随机一次——连着微调比随机更容易找到能听的台
// 传 nameOf 时改成「宽窗口取候选 + 按名字去重 + 当前台尽量居中」：
// 同一家电台常挂两三个流，名字一模一样，刻度里连着出现两个同名看着像渲染坏了
export function dialNeighbors(indices, nowIdx, span = 3, nameOf = null) {
  const k = indices.indexOf(nowIdx);
  if (k < 0) return [];
  const grab = (from, to) => {
    const out = [];
    for (let p = Math.max(0, from); p <= Math.min(indices.length - 1, to); p++) {
      out.push({ idx: indices[p], dist: p - k });
    }
    return out;
  };
  if (!nameOf) return grab(k - span, k + span);
  const seen = new Set();
  const uniq = [];
  for (const it of grab(k - span * 2 - 1, k + span * 2 + 1)) {
    const nm = String(nameOf(it.idx) || '').trim().toLowerCase();
    if (!nm) { uniq.push(it); continue; } // 没名字的台不去重，否则它们会互相吃掉
    if (seen.has(nm)) continue;
    seen.add(nm);
    uniq.push(it);
  }
  const cur = uniq.findIndex((it) => it.dist === 0);
  const from = Math.max(0, Math.min(cur - span, uniq.length - (span * 2 + 1)));
  return uniq.slice(from, from + span * 2 + 1);
}

// 电台所在地的地方平时（经度/15 小时）。数据集里没有时区列，这是均时而非法定时：
// 所以界面上一律标「当地约」，且无坐标（lat/lon 都是 0 是数据集的缺省哨兵）时不给
export function localMeanTime(lon, now = new Date()) {
  const v = Number(lon);
  if (!Number.isFinite(v) || v === 0) return '';
  const off = Math.round(v / 15);
  const d = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + off * 3600000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 国家列表排序：有锚点（用户在的国家）就按大圆距离由近及远，
// 距离并列时台数多的在前；没有锚点或该国无质心时退回「台数降序 + 码升序」
export function sortCountriesByPosition(items, anchor) {
  const withDist = items.map((it) => ({
    ...it,
    d: anchor && it.lat != null && it.lon != null ? haversineKm(anchor, { lat: it.lat, lon: it.lon }) : Infinity,
  }));
  withDist.sort((a, b) => {
    if (a.d !== b.d) return a.d - b.d;
    if (a.n !== b.n) return b.n - a.n;
    return a.cc < b.cc ? -1 : a.cc > b.cc ? 1 : 0;
  });
  return withDist;
}

