// 装配层：把数据、筛选、列表、播放、历史接在一起。
// 逻辑都在各模块里，这里只做 DOM 绑定与状态流转。
import {
  COL, inflate, parseDataset, decodeIds, flagEmoji, applyFilter, isSecureUrl,
  isHlsUrl, upgradeToHttps, hlsMode, clipUrl,
  stationTags, stationCountry, stationCc, stationLang, codecBitrate, codecName,
  countryStats, pickWeighted, rememberRecent, makeRng,
  guessUserCc, sortCountriesByPosition, haversineKm, dialNeighbors, localMeanTime,
} from './core.js';
import { ccName } from './countries-cn.js';
import { langName } from './langs-cn.js';
import { createStationList } from './listview.js';
import {
  loadHistory, saveHistory, pushHistory, loadFavorites, saveFavorites,
  toggleFavorite, isFavorite, toCsv, HISTORY_COLUMNS, sleepDeadline, sleepRemaining,
} from './store.js';
import {
  report, pickMirror, isFatalMediaError, mediaErrorText, START_TIMEOUT_MS, STALL_RESUME_MS,
  canGo, nextRetryDelay, shouldAutoSkip,
} from './radio.js';
import { attachHls } from './hlsplay.js';

const MIRROR = pickMirror();

// 数据源按顺序探测，第一个能读到 meta_web.json 的为准；换源是重新下载，不做增量。
// ./data 只在本地开发服务器上存在，线上把它列进候选等于每次开页先吃一个 404，
// 还让下拉框显示一个根本用不了的选项，所以按 origin 决定有没有这一项。
const IS_DEV = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(location.origin);
const SOURCES = [
  ...(IS_DEV ? [{ id: 'local', label: '本地 ./data（开发）', base: './data/' }] : []),
  { id: 'pages', label: 'GitHub Pages · 每日快照', base: 'https://hzxs163.github.io/radio-browser-snapshot/' },
];

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), dsDot: $('ds-dot'), dsText: $('ds-text'), dataset: $('dataset-info'),
  q: $('q'), sourceSelect: $('source-select'),
  btnSettings: $('btn-settings'), settings: $('settings'), setScrim: $('set-scrim'),
  setClose: $('set-close'), setBadge: $('set-badge'),
  poolCount: $('pool-count'), poolFill: $('pool-fill'), poolNote: $('pool-note'),
  secure: $('f-secure'), hls: $('f-hls'), geo: $('f-geo'),
  votes: $('f-votes'), oVotes: $('o-votes'), br: $('f-br'), oBr: $('o-br'),
  ccCount: $('cc-count'), ccFilter: $('cc-filter'), ccList: $('cc-list'),
  ccSort: $('cc-sort'), ccSortNote: $('cc-sort-note'),
  tagCount: $('tag-count'), tagFilter: $('tag-filter'), tagList: $('tag-list'),
  langCount: $('lang-count'), langSelect: $('lang-select'), langNote: $('lang-note'),
  btnReset: $('btn-reset'),
  stageHint: $('stage-hint'), stationList: $('station-list'),
  overlay: $('overlay'), ovTitle: $('ov-title'), ovBody: $('ov-body'), ovBar: $('ov-bar'), ovStart: $('ov-start'),
  toast: $('toast'),
  deck: $('deck'), npState: $('np-state'), npName: $('np-name'),
  npCountry: $('np-country'), npClock: $('np-clock'), npSub: $('np-sub'), dial: $('dial'),
  npMore: $('np-more'), npQuick: $('np-quick'), npCodec: $('np-codec'), npBitrate: $('np-bitrate'),
  npUrl: $('np-url'),
  npVotes: $('np-votes'), npGeo: $('np-geo'), npReport: $('np-report'), npTags: $('np-tags'),
  btnFav: $('btn-fav'), btnNext: $('btn-next'),
  tabHistory: $('tab-history'), tabFavs: $('tab-favs'),
  btnExport: $('btn-export'), btnClear: $('btn-clear'),
  btnPlay: $('btn-play'), btnRandom: $('btn-random'), btnPrev: $('btn-prev'), btnNextHist: $('btn-nexthist'),
  btnMore: $('btn-more'), ctrlMore: $('ctrl-more'),
  volume: $('volume'), volOut: $('vol-out'), btnMute: $('btn-mute'),
  sleep: $('sleep'), sleepOut: $('sleep-out'), status: $('status'),
  audio: $('audio'),
};

// 手机断点：CSS 里也用同一个数，改一处就要改两处，所以 JS 只认这一条查询
const NARROW = matchMedia('(max-width: 760px)');

const state = {
  ds: null, ids: null, uuidToIdx: null, idsPromise: null,
  stats: null,
  indices: [], cond: { ccs: new Set(), tags: new Set(), langs: null },
  rng: makeRng((Date.now() ^ (Math.random() * 2 ** 31)) >>> 0),
  recent: [], nowIdx: -1, playState: 'idle',
  history: loadHistory(localStorage), favs: loadFavorites(localStorage),
  histCursor: -1, failStreak: 0, chainOn: false, failedIdx: -1,
  attempt: 0, attemptUrl: '', hlsPlayer: null,
  startTimer: 0, stallTimer: 0, reportedFor: '',
  sleepUntil: 0, sleepTick: 0,
  userCc: '', ccSort: 'pos', ccNote: '', sig: '', navFromIdx: -1,
};

let list = null;

// ---------- 顶部状态条 ----------

function setDs(kind, text) {
  els.dataset.className = 'dataset' + (kind ? ' is-' + kind : '');
  els.dsText.textContent = text;
  // 手机上这行会被截断，完整状态留给悬停/长按的 title
  els.dataset.title = '数据集状态：' + text;
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ' is-' + kind : '');
}

let toastTimer = 0;
function toast(msg, ms = 3200, bad = false) {
  els.toast.hidden = false;
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (bad ? ' is-bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setOverlay(show, title, body, pct) {
  els.overlay.hidden = !show;
  if (title) els.ovTitle.textContent = title;
  if (body) els.ovBody.textContent = body;
  if (pct != null) els.ovBar.style.width = Math.round(pct * 100) + '%';
}

// ---------- 下载 ----------

async function getBytes(url, expectBytes, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`);
  const total = Number(res.headers.get('content-length')) || expectBytes || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onProgress) onProgress(1);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (onProgress) onProgress(total ? Math.min(1, got / total) : 0);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function probeSource(base) {
  try {
    const res = await fetch(`${base}meta_web.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function chooseSource(preferredId) {
  const first = SOURCES.find((s) => s.id === preferredId);
  const order = first ? [first, ...SOURCES.filter((s) => s !== first)] : SOURCES;
  for (const s of order) {
    const meta = await probeSource(s.base);
    if (meta && Number(meta.web_rows) > 0) return { source: s, meta };
  }
  throw new Error('所有数据源都读不到 meta_web.json');
}

// ---------- 载入 ----------

async function boot() {
  setDs('loading', '探测数据源…');
  setOverlay(true, '拾波', '正在寻找可用的数据源…', 0);
  els.audio.volume = Number(els.volume.value);
  els.volOut.textContent = Math.round(Number(els.volume.value) * 100) + '%';
  fillSourceOptions();

  let picked;
  try {
    picked = await chooseSource(els.sourceSelect.value);
  } catch (e) {
    setDs('bad', '数据源不可用');
    setOverlay(true, '载入失败', e.message + ' —— 本地开发请先跑 node serve.mjs，线上则等 CI 产出前端数据集');
    els.ovStart.hidden = false;
    els.ovStart.textContent = '重试';
    return;
  }
  markSource(picked.source);
  state.sig = picked.meta.generated_at || picked.meta.sha256_gz || '';
  restoreSession(state.sig);

  // 快照走 Pages/CDN，前端数据集三件产物按顺序下
  const webBytes = await getBytes(picked.source.base + 'stations.web.json.gz', picked.meta.gz_bytes,
    (p) => setOverlay(true, null, `下载快照 ${Math.round(p * 100)}%`, p * 0.85));
  setDs('loading', `解压 ${(webBytes.length / 1048576).toFixed(2)} MB…`);
  const ds = parseDataset(await inflate(webBytes));
  state.ds = ds;
  state.stats = countryStats(ds);

  state.idsPromise = loadIds(picked.source, picked.meta);

  setDs('ok', `${fmt(ds.rows.length)} 台可播 · ${picked.source.label}`);
  setOverlay(false);
  if (NARROW.matches) els.npMore.open = false;
  buildFacets();
  initList();
  applyUserDefault();
  refreshFilter();
  renderDial();
  renderLists();
  setStatus(`就绪 · 按 N 随机一台（上报镜像 ${MIRROR}）`, 'ok');
}

// 「默认选中中国」值不值一次推断？值，但要写清楚依据、并且用户可以一键改。
// 只用时区/语言，不请求定位权限；推断不出来就什么都不选
function applyUserDefault() {
  const timeZone = (Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
  state.userCc = guessUserCc({ timeZone, language: navigator.language || '' });
  const name = ccName(state.userCc);
  if (state.userCc && state.stats.has(state.userCc)) {
    state.ccNote = `国家列表按离${name}的远近排序`;
    if (state.userCc === 'CN') {
      state.cond.ccs.add('CN');
      state.ccNote = `已按时区 ${timeZone || navigator.language} 默认选中${name}（点国家行可取消）· 国家列表按离${name}远近排序`;
    }
  } else {
    state.ccNote = state.userCc ? `推断你在 ${name}，但快照里没有该国土台` : '推断不出你所在国家，国家列表按台数排序';
  }
}

// 数据源的选择只在这一轮会话里有效：换源是整站 reload 重新下载，
// 记到 localStorage 会让下次打开悄悄用着一个过期快照
const SOURCE_KEY = 'shibo.source.v1';

function fillSourceOptions() {
  els.sourceSelect.replaceChildren(...SOURCES.map((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    return o;
  }));
  // 换源靠 reload 生效，选择必须活得过这次 reload，否则下拉框永远跳回第一项
  const saved = sessionStorage.getItem(SOURCE_KEY);
  els.sourceSelect.value = SOURCES.some((s) => s.id === saved) ? saved : SOURCES[0].id;
}

function markSource(source) {
  els.sourceSelect.value = source.id;
}

async function loadIds(source, meta) {
  try {
    const bytes = await getBytes(source.base + 'stations.ids.json.gz', meta.ids_gz_bytes,
      (p) => { if (state.playState === 'idle') setStatus(`后台载入电台 id ${Math.round(p * 100)}%`); });
    const ids = decodeIds(await inflate(bytes));
    if (ids.length !== state.ds.rows.length) throw new Error(`id 数 ${ids.length} 与行数 ${state.ds.rows.length} 不一致`);
    // 对齐只校验长度是弱的：两个文件来自同一次构建，但万一错位，播放和上报就会指到另一台台上。
    // 官方 uuid 是 40 位十六进制，形状不对的数量非零就是明确的报警，写在状态条里而不是吞掉
    let odd = 0;
    for (let i = 0; i < ids.length; i++) if (!/^[0-9a-f-]{20,}$/i.test(ids[i] || '')) odd++;
    state.ids = ids;
    state.uuidToIdx = new Map();
    ids.forEach((u, i) => state.uuidToIdx.set(u, i));
    setStatus(`就绪 · ${ids.length} 个 id 已载入${odd ? ` · 警告：${odd} 个 id 形状可疑` : ''}`, odd ? 'bad' : 'ok');
    return ids;
  } catch (e) {
    toast('电台 id 载入失败：无法播放或上报（' + e.message + '）', 6000, true);
    return null;
  }
}

// ---------- 筛选 ----------

function readCond() {
  const c = state.cond;
  c.secureOnly = els.secure.checked;
  c.hideHls = els.hls.checked;
  c.geoOnly = els.geo.checked;
  c.minVotes = Number(els.votes.value);
  c.minBitrate = Number(els.br.value);
  c.query = els.q.value.trim();
  els.oVotes.textContent = String(c.minVotes);
  els.oBr.textContent = String(c.minBitrate);
  return c;
}

function refreshFilter() {
  if (!state.ds) return;
  readCond();
  state.indices = applyFilter(state.ds, state.ds.rows, state.cond);
  els.poolCount.textContent = fmt(state.indices.length);
  els.poolFill.style.width = Math.min(100, (state.indices.length / state.ds.rows.length) * 100) + '%';
  // 残留的搜索词最容易让人以为「数据怎么这么少」，所以把它写进统计行里
  const active = [];
  if (state.cond.query) active.push(`搜索「${state.cond.query}」`);
  if (state.cond.ccs.size) active.push([...state.cond.ccs].map((c) => ccName(c)).join('、'));
  if (state.cond.tags.size) active.push(`${state.cond.tags.size} 个风格`);
  if (state.cond.langs && state.cond.langs.size) {
    active.push('语言 ' + (langName(state.ds.dict.lang[[...state.cond.langs][0]]) || '?'));
  }
  if (state.cond.geoOnly) active.push('只要有坐标');
  if (state.cond.minVotes > 0) active.push(`票≥${state.cond.minVotes}`);
  if (state.cond.minBitrate > 0) active.push(`码率≥${state.cond.minBitrate}`);
  els.poolNote.textContent = `全库 ${fmt(state.ds.rows.length)} → 命中 ${fmt(state.indices.length)}`
    + (active.length ? ' · 生效条件：' + active.join('、') : '')
    + (state.ccNote ? ' · ' + state.ccNote : '')
    + (state.indices.length === 0 ? ' · 条件太严，一台都不剩' : '');
  els.btnReset.disabled = !active.length;
  // 条件收进抽屉后就看不见了，所以入口上挂个数字：0 就藏起来，别当成装饰
  const n = active.length + (state.cond.secureOnly ? 1 : 0) + (state.cond.hideHls ? 1 : 0);
  els.setBadge.hidden = n === 0;
  els.setBadge.textContent = String(n);
  renderCcList();
  els.tagCount.textContent = String(state.cond.tags.size);
  els.langCount.textContent = state.cond.langs && state.cond.langs.size ? String(state.cond.langs.size) : '0';
  els.stageHint.textContent = `点行直接播放 · 列表是筛选命中的 ${fmt(state.indices.length)} 台，按快照顺序排`;
  if (list) list.setIndices(state.indices);
}

// ---------- 设置抽屉 ----------
// 抽屉是覆盖层，不占栅格列：开合只改 hidden 和 aria-expanded，
// 里面所有控件的绑定照旧，因为它们在 DOM 里从没被移动过位置以外的地方

function openSettings() {
  if (!els.settings.hidden) return;
  els.settings.hidden = false;
  els.setScrim.hidden = false;
  els.btnSettings.setAttribute('aria-expanded', 'true');
  els.setClose.focus();
}

function closeSettings() {
  if (els.settings.hidden) return;
  els.settings.hidden = true;
  els.setScrim.hidden = true;
  els.btnSettings.setAttribute('aria-expanded', 'false');
  els.btnSettings.focus();
}

const settingsOpen = () => !els.settings.hidden;

// 国家计数来自「忽略国家选择本身」的那一遍筛选，否则多选时数字会互相吃掉
function ccCounts() {
  const c = state.cond;
  const saved = c.ccs;
  c.ccs = new Set();
  const idx = applyFilter(state.ds, state.ds.rows, c);
  c.ccs = saved;
  const counts = new Map();
  for (const i of idx) {
    const cc = stationCc(state.ds, state.ds.rows[i]);
    counts.set(cc, (counts.get(cc) || 0) + 1);
  }
  return counts;
}

function buildFacets() {
  renderTagChips('');
  const langs = state.ds.dict.lang || [];
  const opts = [new Option('不限', '')];
  for (let i = 0; i < Math.min(60, langs.length); i++) opts.push(new Option(langName(langs[i]) || langs[i], String(i)));
  els.langSelect.replaceChildren(...opts);
  // 下拉是「最热 60 种」而不是全部：不写出来的话，冷门语言看起来像库里没有
  els.langNote.textContent = langs.length > opts.length - 1
    ? `下拉只列最常见的 ${opts.length - 1} 种（全库 ${fmt(langs.length)} 种）；冷门语言请用上面的搜索框。`
    : `全库 ${fmt(langs.length)} 种语言，已全部列出。`;
  els.langCount.textContent = '0';
  els.ccCount.textContent = fmt(state.stats.size);
}

// dict 在生成时已按频次降序，所以「前 80 个」就是最热标签，不用再数一遍；
// 一旦用户输入了关键词，就改成在全字典里搜——否则冷门票类永远「搜不到」，
// 而那看起来像「库里没有这个风格」
function renderTagChips(kw) {
  const tags = state.ds.dict.tags || [];
  const q = String(kw || '').trim().toLowerCase();
  const limit = q ? 200 : 80;
  const box = document.createDocumentFragment();
  let shown = 0;
  for (let i = 0; i < tags.length && shown < limit; i++) {
    if (q && !tags[i].toLowerCase().includes(q)) continue;
    shown++;
    const li = document.createElement('li');
    li.textContent = tags[i];
    li.dataset.idx = String(i);
    li.classList.toggle('on', state.cond.tags.has(i));
    li.addEventListener('click', () => {
      if (state.cond.tags.has(i)) state.cond.tags.delete(i); else state.cond.tags.add(i);
      li.classList.toggle('on', state.cond.tags.has(i));
      persistSession();
      refreshFilter();
    });
    box.appendChild(li);
  }
  els.tagList.replaceChildren(box);
  els.tagCount.textContent = q ? `${shown} 个候选 · 选 ${state.cond.tags.size}` : String(state.cond.tags.size);
}

// 清空条件：搜索词、多选、语言、开关、滑杆一律回默认。
// 「清除全部条件」不该顺手把用户取消的开关也改回去吗？——它写的就是全部，
// 所以回默认值，并在提示里说清楚开关回了什么
function clearConditions() {
  els.q.value = '';
  els.ccFilter.value = '';
  els.tagFilter.value = '';
  state.cond.ccs.clear();
  state.cond.tags.clear();
  state.cond.langs = null;
  els.langSelect.value = '';
  els.secure.checked = false;
  els.hls.checked = false;
  els.geo.checked = false;
  els.votes.value = '0';
  els.br.value = '0';
  state.ccNote = '';
  renderTagChips('');
  persistSession();
  refreshFilter();
  toast('条件已清空：全库 ' + fmt(state.ds.rows.length) + ' 台（开关回到默认「不限协议、不排除 HLS」）');
}

// 国家列表：中文名 + 按离用户的远近排序（推断不出位置时退回台数降序）。
// 已选中的国家一律置顶，否则多选几个远国之后它们会被 60 行上限挤掉，看起来像「取消失败」
function renderCcList() {
  const kw = els.ccFilter.value.trim().toLowerCase();
  const counts = ccCounts();
  const anchor = ccAnchor();
  const all = [];
  for (const [cc, n] of counts) {
    if (n <= 0) continue;
    const s = state.stats.get(cc);
    const en = s ? (state.ds.dict.country[s.nameIdx] || '') : '';
    const lat = s ? s.lat : null;
    const lon = s ? s.lon : null;
    all.push({
      cc, n, lat, lon, cn: ccName(cc, en), en,
      d: anchor && lat != null && lon != null ? haversineKm(anchor, { lat, lon }) : null,
    });
  }
  const matched = all.filter((it) => !kw
    || it.cn.includes(kw)
    || it.cc.toLowerCase().includes(kw)
    || it.en.toLowerCase().includes(kw));
  const picked = [];
  const rest = [];
  for (const it of matched) (state.cond.ccs.has(it.cc) ? picked : rest).push(it);
  const sortedRest = state.ccSort === 'n'
    ? rest.slice().sort((a, b) => b.n - a.n || (a.cc < b.cc ? -1 : 1))
    : sortCountriesByPosition(rest, anchor);
  const items = [...picked.sort((a, b) => b.n - a.n), ...sortedRest].slice(0, 60);
  const box = document.createDocumentFragment();
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'row' + (state.cond.ccs.has(it.cc) ? ' on' : '');
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = flagEmoji(it.cc);
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = it.cn;
    name.title = `${it.cc} ${it.en}${it.d != null && Number.isFinite(it.d) ? ` · 约 ${fmt(Math.round(it.d))} km` : ''}`;
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = fmt(it.n);
    li.append(flag, name, num);
    li.addEventListener('click', () => {
      if (state.cond.ccs.has(it.cc)) state.cond.ccs.delete(it.cc); else state.cond.ccs.add(it.cc);
      state.ccNote = ''; // 用户手动动过国家，就别再声称「已默认选中中国」
      refreshFilter();
    });
    box.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = kw ? `没有匹配「${kw}」的国家（中文、英文、两字母码都试试）` : '没有匹配的国家';
    box.appendChild(li);
  }
  els.ccList.replaceChildren(box);
  // 列表只画前 60 行：不写清楚的话，「找不到某国」会被误读成「该国没有电台」
  const shown = items.length;
  els.ccCount.textContent = `${shown}${shown < matched.length ? ` / 共 ${fmt(matched.length)} 国` : ''}`
    + (state.cond.ccs.size ? ` · 选 ${state.cond.ccs.size}` : '');
}

// 排序锚点 = 推断出的用户所在国家的质心
function ccAnchor() {
  const s = state.stats && state.userCc ? state.stats.get(state.userCc) : null;
  return s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : null;
}

// ---------- 列表视图 ----------
// 唯一的选台入口：6 万行不能全进 DOM，交给 createStationList 只画视口内的行。

function initList() {
  // 行高写在内联样式上（虚拟定位），CSS 断点改不动它，所以由这里按断点报数：
  // 手机上字号要更大，行也得跟着高，否则两行字挤出 44px 就被 overflow:hidden 裁掉
  list = createStationList({
    root: els.stationList,
    rowHeight: () => (NARROW.matches ? 56 : 44),
    renderRow: (i) => stationRow(i),
  });
  NARROW.addEventListener('change', () => list.resize());
  new ResizeObserver(() => list.resize()).observe(els.stationList);
}

function stationRow(i) {
  const r = state.ds.rows[i];
  const cc = stationCc(state.ds, r);
  const li = document.createElement('li');
  li.className = 'srow';
  if (i === state.nowIdx) li.classList.add('on');
  // 只标「这一次尝试里真失败过」的那台，历史失败记录早就过期了
  if (i === state.failedIdx && state.playState === 'error') li.classList.add('bad');
  const flag = document.createElement('span');
  flag.className = 'flag';
  flag.textContent = flagEmoji(cc);
  const line = document.createElement('span');
  line.className = 'rowline';
  const b = document.createElement('b');
  b.textContent = r[COL.name] || '（无名）';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = `${ccName(cc, stationCountry(state.ds, r))} · ${langName(stationLang(state.ds, r)) || '语言未知'}`
    + ` · ${(stationTags(state.ds, r)[0] || '无标签')}`;
  line.append(b, sub);
  const meta = document.createElement('span');
  meta.className = 'meta';
  // 明文源单独标出来：它在安全上下文下要先升级 https，升不了就会跳过
  const via = isSecureUrl(r[COL.url_resolved]) ? '' : 'http · ';
  meta.textContent = via + codecBitrate(state.ds, r) + ` · 票 ${r[COL.votes]}`;
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = i === state.nowIdx ? '▶' : (li.classList.contains('bad') ? '⚠' : '');
  li.append(flag, line, meta, mark);
  li.addEventListener('click', () => play(i, { chain: false }));
  return li;
}

// ---------- 播放 ----------

function goState(next) {
  if (state.playState === next) return true;
  if (!canGo(state.playState, next)) {
    setStatus(`非法状态迁移 ${state.playState} → ${next}`, 'bad');
    return false;
  }
  state.playState = next;
  els.deck.classList.toggle('is-live', next === 'playing');
  els.npState.textContent = ({
    idle: '空闲', loading: '连接中', playing: '正在播放', paused: '已暂停', stalled: '缓冲中', error: '失败',
  })[next] || next;
  els.btnPlay.textContent = next === 'playing' ? '❚❚' : '▶';
  els.btnPlay.classList.toggle('is-playing', next === 'playing');
  return true;
}

async function play(idx, { chain } = {}) {
  if (!state.ds) return;
  if (idx < 0 || idx >= state.ds.rows.length) return;
  if (!state.ids) {
    const ids = await state.idsPromise;
    if (!ids) { toast('拿不到电台 id，无法播放', 4000, true); return; }
  }
  const uuid = state.ids[idx];
  // 没有 uuid 就既不能播也不能上报：让 uuid 为空的行直接拒绝，比拿 "undefined" 去请求镜像强
  if (!uuid) {
    toast(`第 ${idx} 行没有 station id（id 文件与快照不同步），换源或等下一次快照`, 5000, true);
    return;
  }
  const row = state.ds.rows[idx];
  const rawUrl = row[COL.url_resolved];
  if (!rawUrl) { toast('这条记录没有播放地址', 3000, true); return; }
  // http 源：安全上下文里浏览器不让碰明文子资源（https 页面和 http://127.0.0.1 都算，
  // 所以判 isSecureContext 而不是判协议，否则本地开发时明明被拦却看不出来）。
  // 显式升级一遍，成了就能播——国内 CDN 常见「只登记 http 但 https 也通」
  let url = rawUrl;
  let upgraded = false;
  if (!isSecureUrl(url) && self.isSecureContext) {
    const up = upgradeToHttps(url);
    if (!up) {
      toast('这条只有 http 地址（还升不了 https），安全上下文下会被浏览器拦掉，已跳过', 3500, true);
      if (chain) return skipChain();
      return;
    }
    url = up;
    upgraded = true;
  }
  const hlsUrl = isHlsUrl(url);
  const mode = hlsUrl ? hlsMode(els.audio) : '';
  if (mode === 'none') {
    toast('这台是 HLS(m3u8)，这个浏览器既不能原生播也没有 MediaSource', 4500, true);
    if (chain) return skipChain();
    return;
  }
  // chain=false 就是「用户点名要这台」：连自动换台开关也要跟着关，
  // 否则手动点中一台死台会继承上一轮的 chainOn，被静默连坐换掉
  state.chainOn = !!chain;
  state.nowIdx = idx;
  state.failedIdx = -1;
  const attempt = ++state.attempt;
  state.attemptUrl = url;
  rememberRecent(state.recent, idx);
  persistSession();
  clearTimers();
  stopHlsPlayer();
  goState('loading');
  paintNowPlaying(idx);
  // 面板上写「真正要去连的那个地址」，升级过的就不是原始值——播不通时先看这行
  els.npUrl.textContent = clipUrl(url);
  els.npUrl.title = url;
  setStatus(`连接 ${shortName(row[COL.name])} · ${ccName(stationCc(state.ds, row))}`
    + (hlsUrl ? ' · HLS' : '') + (upgraded ? ' · 已升级 https' : ''));
  if (mode === 'lib') {
    // 先等库到位再武装超时定时器：113KB 的下载时间不该算进「起播超时」
    setStatus(`加载 HLS 支持… ${shortName(row[COL.name])}`);
    let h;
    try {
      h = await attachHls(els.audio, url, {
        onFatal: (why) => { if (attempt === state.attempt) onMediaFailure(why, idx); },
      });
    } catch (e) {
      onMediaFailure(`hls 库没拉到（${(e && e.message) || e}）`, idx);
      return;
    }
    if (attempt !== state.attempt) { h.destroy(); return; } // 等库的这几秒里用户已经换台
    state.hlsPlayer = h;
    state.attemptUrl = h.src || url; // MSE 挂上后 <audio>.src 变成 blob:，认脸要跟着换
  } else {
    els.audio.src = url;
    els.audio.load();
  }
  state.startTimer = setTimeout(() => onTimeout(idx, attempt), START_TIMEOUT_MS);
  try {
    await els.audio.play();
  } catch (e) {
    // 换台时上一台的 play() 会以「被新 load 打断」reject：那是我们自己造成的，不算死台
    if (attempt !== state.attempt) return;
    onMediaFailure(e && e.name === 'NotAllowedError' ? 'notallowed' : (e && e.message) || 'error', idx);
  }
}

// HLS 实例是「一次尝试一个」：换台、判死、暂停后重开都要先拆掉旧的，
// 否则旧实例还在拉分片，既费流量又会把事件打到新台上
function stopHlsPlayer() {
  if (!state.hlsPlayer) return;
  const h = state.hlsPlayer;
  state.hlsPlayer = null;
  h.destroy();
}

function shortName(s) {
  const v = String(s || '');
  return v.length > 34 ? v.slice(0, 33) + '…' : v;
}

function clearTimers() {
  clearTimeout(state.startTimer);
  clearTimeout(state.stallTimer);
  state.startTimer = state.stallTimer = 0;
}

function onTimeout(idx, attempt) {
  if (attempt !== state.attempt || state.playState !== 'loading') return;
  els.audio.pause();
  onMediaFailure('timeout', idx);
}

function onMediaFailure(reason, idx) {
  // play() 的 reject 和 audio 的 error 事件是同一个故障的两张脸：
  // 不去重的话一台死台会记两次，连挂计数翻倍、退避提前触发
  if (state.playState === 'error' && state.failedIdx === idx) return;
  state.failedIdx = idx;
  clearTimers();
  stopHlsPlayer();
  state.failStreak++;
  goState('error');
  const row = idx >= 0 ? state.ds.rows[idx] : null;
  const label = row ? shortName(row[COL.name]) : '这台';
  const why = reason === 'notallowed' ? '浏览器不允许自动播放'
    : reason === 'timeout' ? `${START_TIMEOUT_MS / 1000} 秒内没有数据`
      : isFatalMediaError(reason) ? '这个源不可播' : `起播失败（${reason}）`;
  setStatus(`${label} ${why} · 连续失败 ${state.failStreak}`, 'bad');
  if (reason !== 'notallowed' && state.chainOn && shouldAutoSkip(state.failStreak)) {
    setTimeout(skipChain, nextRetryDelay(state.failStreak));
  } else if (state.chainOn && !shouldAutoSkip(state.failStreak)) {
    toast('连着 12 台都起不来，自动换台已停止 —— 放宽筛选条件再试', 7000, true);
    state.chainOn = false;
  }
}

function skipChain() {
  const idx = pickRandomIdx();
  if (idx < 0) { toast('随机池是空的，先放宽条件', 4000, true); state.chainOn = false; return; }
  play(idx, { chain: true });
}

function pickRandomIdx() {
  if (!state.indices.length) return -1;
  return pickWeighted(state.ds.rows, state.indices, state.rng, state.recent, state.nowIdx);
}

function paintNowPlaying(idx) {
  const row = state.ds.rows[idx];
  const cc = stationCc(state.ds, row);
  const hasGeo = !!(row[COL.lat] && row[COL.lon]);
  els.npName.textContent = row[COL.name] || '（无名）';
  els.npCountry.textContent = `${flagEmoji(cc)} ${ccName(cc, stationCountry(state.ds, row))}`;
  paintClock();
  const tags = stationTags(state.ds, row);
  const lang = stationLang(state.ds, row);
  els.npSub.textContent = [tags.slice(0, 2).join(' / '), langName(lang)].filter(Boolean).join(' · ')
    || (hasGeo ? '无标签' : '无标签 · 无坐标');
  els.npCodec.textContent = (codecName(state.ds, row) || '未知') + (isHlsUrl(row[COL.url_resolved]) ? ' · HLS' : '');
  els.npBitrate.textContent = row[COL.bitrate] ? row[COL.bitrate] + ' kbps' : '未知';
  els.npVotes.textContent = String(row[COL.votes]);
  els.npGeo.textContent = hasGeo ? `${row[COL.lat].toFixed(2)}, ${row[COL.lon].toFixed(2)}` : '无';
  els.npTags.textContent = tags.slice(0, 10).join(' / ') || '无';
  els.npQuick.textContent = `${codecBitrate(state.ds, row)} · 票 ${row[COL.votes]}`;
  els.npReport.textContent = '待上报';
  els.npReport.className = '';
  els.btnFav.textContent = isFavorite(state.favs, state.ids[idx]) ? '★ 已收藏' : '☆ 收藏';
  els.btnFav.dataset.uuid = state.ids[idx];
  renderDial();
  if (list) {
    list.refresh(); // 行内容里带「当前台」高亮，换了台必须重画视口那十几行
    list.scrollToIndex(state.indices.indexOf(idx));
  }
}

// 当地时间只跟分钟有关，单独抽出来给秒级 tick 复用（换台和每分钟都要刷）
function paintClock() {
  if (state.nowIdx < 0 || !state.ds) { els.npClock.textContent = ''; return; }
  const t = localMeanTime(state.ds.rows[state.nowIdx][COL.lon]);
  els.npClock.textContent = t ? `当地约 ${t}` : '';
}

// 调谐刻度：中间是当前台，两侧是筛选结果里排在它前后的台。
// 点邻居直接换台——比再按一次随机可控，比在地图上找快
function renderDial() {
  // 手机上只留左右各两格：七个等宽格子会把每个名字裁成三个省略号，等于没有信息
  const span = NARROW.matches ? 2 : 3;
  const items = dialNeighbors(state.indices, state.nowIdx, span, (i) => state.ds.rows[i][COL.name]);
  const names = document.createElement('div');
  names.className = 'dial-names';
  const scale = document.createElement('div');
  scale.className = 'dial-scale';
  if (!items.length) {
    const s = document.createElement('span');
    s.className = 'dial-empty';
    s.textContent = state.nowIdx < 0
      ? '还没选台'
      : `这台不在当前筛选结果里（${fmt(state.indices.length)} 台命中），刻度用不了`;
    names.appendChild(s);
    els.dial.replaceChildren(names);
    return;
  }
  for (const it of items) {
    const r = state.ds.rows[it.idx];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tick' + (it.dist === 0 ? ' cur' : '');
    b.textContent = shortName(r[COL.name]);
    b.title = `${it.dist > 0 ? '+' : ''}${it.dist} · ${ccName(stationCc(state.ds, r))} · ${codecBitrate(state.ds, r)} · 票 ${r[COL.votes]}`;
    if (it.dist !== 0) b.addEventListener('click', () => play(it.idx, { chain: false }));
    else b.setAttribute('aria-current', 'true');
    names.appendChild(b);
  }
  const needle = document.createElement('i');
  const k = items.findIndex((it) => it.dist === 0);
  needle.style.left = ((k + 0.5) / items.length * 100).toFixed(2) + '%';
  scale.appendChild(needle);
  els.dial.replaceChildren(names, scale);
}

function reportClick(idx) {
  const uuid = state.ids[idx];
  if (!uuid || state.reportedFor === uuid) return;
  state.reportedFor = uuid;
  els.npReport.textContent = '上报中…';
  report('click', uuid).then((r) => {
    if (r.ok) {
      els.npReport.textContent = '已计入官方点击';
      els.npReport.className = 'ok';
    } else {
      els.npReport.textContent = `失败 ${r.status || '网络'}`;
      els.npReport.className = 'bad';
    }
  });
}

function pushHist(idx) {
  // 从历史里点回来的台不再重排历史：pushHistory 会把命中项挪到最前，
  // 于是「上一台」永远回到 0，按 ⟨ 只能在头两台之间跳
  if (state.navFromIdx === idx) { state.navFromIdx = -1; return; }
  const row = state.ds.rows[idx];
  const entry = {
    uuid: state.ids[idx],
    name: row[COL.name],
    cc: stationCc(state.ds, row),
    country: stationCountry(state.ds, row),
    votes: row[COL.votes],
    bitrate: row[COL.bitrate],
    url: row[COL.url_resolved],
    time: new Date().toISOString(),
  };
  state.history = pushHistory(state.history, entry);
  saveHistory(localStorage, state.history);
  state.histCursor = 0;
  renderLists();
}

// ---------- 历史 / 收藏 ----------

function renderLists() {
  for (const [list, data, isFav] of [[els.tabHistory, state.history, false], [els.tabFavs, state.favs, true]]) {
    const box = document.createDocumentFragment();
    data.slice(0, 60).forEach((e, k) => {
      const li = document.createElement('li');
      const idx = state.uuidToIdx ? state.uuidToIdx.get(e.uuid) : undefined;
      if (!isFav && k === state.histCursor && idx != null) li.className = 'now';
      const row = document.createElement('span');
      row.className = 'rowline';
      const b = document.createElement('b');
      b.textContent = `${flagEmoji(e.cc)} ${e.name}`;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = (isFav ? ccName(e.cc, e.country) : new Date(e.time).toLocaleTimeString())
        + (e.bitrate ? ` · ${e.bitrate}k` : '') + (idx == null ? ' · 本次快照里没有' : '');
      row.append(b, sub);
      li.append(row);
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = isFav ? '★' : '';
      li.append(n);
      li.addEventListener('click', () => {
        if (idx == null) { toast('这台不在当前快照里（可能已下线）', 3000, true); return; }
        state.histCursor = isFav ? state.histCursor : k;
        play(idx, { chain: false });
      });
      box.appendChild(li);
    });
    if (!data.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = isFav ? '还没有收藏' : '还没有收听记录';
      box.appendChild(li);
    }
    list.replaceChildren(box);
  }
}

// ---------- 绑定 ----------

function bind() {
  const deb = debounce(() => refreshFilter(), 120);
  [els.secure, els.hls, els.geo].forEach((c) => c.addEventListener('change', refreshFilter));
  [els.votes, els.br].forEach((r) => r.addEventListener('input', deb));
  els.q.addEventListener('input', deb);
  els.ccFilter.addEventListener('input', debounce(renderCcList, 140));
  els.ccSort.addEventListener('click', () => {
    state.ccSort = state.ccSort === 'pos' ? 'n' : 'pos';
    els.ccSort.textContent = state.ccSort === 'pos' ? '按远近' : '按台数';
    els.ccSortNote.textContent = state.ccSort === 'pos'
      ? (state.userCc ? `离${ccName(state.userCc)}近的在前` : '离你近的在前（没推断出位置）')
      : '台数多的在前';
    renderCcList();
  });
  els.tagFilter.addEventListener('input', debounce(() => renderTagChips(els.tagFilter.value), 140));
  els.btnReset.addEventListener('click', clearConditions);
  els.btnSettings.addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
  els.setClose.addEventListener('click', closeSettings);
  els.setScrim.addEventListener('click', closeSettings);
  els.btnMore.addEventListener('click', () => {
    const open = els.ctrlMore.hidden;
    els.ctrlMore.hidden = !open;
    els.btnMore.setAttribute('aria-expanded', String(open));
  });
  els.langSelect.addEventListener('change', () => {
    const v = els.langSelect.value;
    state.cond.langs = v === '' ? null : new Set([Number(v)]);
    refreshFilter();
  });
  els.btnRandom.addEventListener('click', () => {
    state.failStreak = 0;
    skipChain();
  });
  els.btnNext.addEventListener('click', () => { state.failStreak = 0; skipChain(); });
  els.btnPlay.addEventListener('click', () => {
    if (state.playState === 'playing' || state.playState === 'stalled') {
      els.audio.pause();
      goState('paused');
      state.chainOn = false;
      setStatus('已暂停', 'ok');
    } else if (state.playState === 'paused' && state.nowIdx >= 0) {
      els.audio.play().then(() => goState('playing'), (e) => onMediaFailure(e.message, state.nowIdx));
    } else if (state.nowIdx >= 0) {
      play(state.nowIdx, { chain: false });
    } else {
      state.failStreak = 0;
      skipChain();
    }
  });
  els.btnPrev.addEventListener('click', () => stepHistory(-1));
  els.btnNextHist.addEventListener('click', () => stepHistory(1));
  els.btnFav.addEventListener('click', () => {
    if (state.nowIdx < 0 || !state.ids) return;
    const uuid = state.ids[state.nowIdx];
    const row = state.ds.rows[state.nowIdx];
    const r = toggleFavorite(state.favs, {
      uuid, name: row[COL.name], cc: stationCc(state.ds, row), country: stationCountry(state.ds, row),
      votes: row[COL.votes], bitrate: row[COL.bitrate], url: row[COL.url_resolved],
      time: new Date().toISOString(),
    });
    state.favs = r.list;
    saveFavorites(localStorage, state.favs);
    els.btnFav.textContent = r.added ? '★ 已收藏' : '☆ 收藏';
    renderLists();
  });
  els.btnExport.addEventListener('click', exportCsv);
  els.btnClear.addEventListener('click', () => {
    if (!state.history.length) return;
    if (!confirm(`清空 ${state.history.length} 条历史？`)) return;
    state.history = [];
    saveHistory(localStorage, []);
    renderLists();
    toast('历史已清空');
  });
  els.volume.addEventListener('input', () => {
    const v = Number(els.volume.value);
    els.audio.volume = v;
    els.audio.muted = v === 0;
    els.volOut.textContent = Math.round(v * 100) + '%';
  });
  els.btnMute.addEventListener('click', () => {
    els.audio.muted = !els.audio.muted;
    els.btnMute.textContent = els.audio.muted ? '×' : '♪';
  });
  els.sleep.addEventListener('change', () => {
    const mins = Number(els.sleep.value);
    state.sleepUntil = sleepDeadline(Date.now(), mins);
    clearInterval(state.sleepTick);
    if (state.sleepUntil) {
      state.sleepTick = setInterval(tickSleep, 1000);
      tickSleep();
    } else els.sleepOut.textContent = '';
  });
  els.ovStart.addEventListener('click', () => {
    // 「重试」= 回到默认顺序重新探测，别把刚失败的那个源又顶上来
    if (els.ovStart.textContent === '重试') { sessionStorage.removeItem(SOURCE_KEY); location.reload(); return; }
    setOverlay(false);
    state.failStreak = 0;
    skipChain();
  });
  els.sourceSelect.addEventListener('change', () => {
    sessionStorage.setItem(SOURCE_KEY, els.sourceSelect.value);
    location.reload();
  });
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabbar button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      const fav = b.dataset.tab === 'favs';
      els.tabFavs.hidden = !fav;
      els.tabHistory.hidden = fav;
    });
  });
  addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape' && settingsOpen()) { closeSettings(); return; }
    if (e.key === ' ') { e.preventDefault(); els.btnPlay.click(); }
    else if (e.key === 'n' || e.key === 'N') { els.btnRandom.click(); }
    else if (e.key === 'f' || e.key === 'F') { els.btnFav.click(); }
    else if (e.key === '/') { e.preventDefault(); els.q.focus(); }
    else if (e.key === 's' || e.key === 'S') { if (settingsOpen()) closeSettings(); else openSettings(); }
  });

  // 音量/睡眠在窄屏收进 ⋯ 里、宽屏直接摊在走带条上：同一份 DOM，两种排法，
  // 所以 hidden 由视口决定，而不是只由那个按钮决定
  const syncMore = () => {
    els.btnMore.hidden = !NARROW.matches;
    if (!NARROW.matches) els.ctrlMore.hidden = false;
    else els.ctrlMore.hidden = els.btnMore.getAttribute('aria-expanded') !== 'true';
  };
  NARROW.addEventListener('change', syncMore);
  syncMore();
  // 后台标签页里 setInterval 会被节流到分钟级，回到前台立刻补一次，别让睡眠倒计时看着冻结
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickSleep(); });

  const a = els.audio;
  // 事件里也要认脸：换台后旧连接的 error/playing 仍会到达，把它们算到当前台上会污染计数
  const stale = () => a.src !== state.attemptUrl;
  a.addEventListener('playing', () => {
    if (stale()) return;
    clearTimers();
    if (!goState('playing')) state.playState = 'playing';
    state.failStreak = 0;
    const row = state.ds.rows[state.nowIdx];
    setStatus(`正在播放 ${shortName(row[COL.name])} · ${codecBitrate(state.ds, row)}`, 'ok');
    pushHist(state.nowIdx);
    reportClick(state.nowIdx);
  });
  // 换台时元素可能补发一个 pause：只有真在播/在缓冲才认，否则会把 loading 打成 paused。
  // 还要认 src：旧连接补发的 pause 会把刚点下的新台从 loading 打成 paused，然后干等 12 秒
  a.addEventListener('pause', () => {
    if (stale()) return;
    if (state.playState === 'playing' || state.playState === 'stalled') goState('paused');
  });
  a.addEventListener('stalled', () => {
    if (stale() || state.playState !== 'playing') return;
    goState('stalled');
    setStatus('缓冲中…（流断了会在 ' + STALL_RESUME_MS / 1000 + ' 秒后重试）');
    clearTimeout(state.stallTimer);
    state.stallTimer = setTimeout(() => {
      if (state.playState !== 'stalled') return;
      if (state.chainOn) skipChain();
      else els.audio.play().catch(() => onMediaFailure('stall', state.nowIdx));
    }, STALL_RESUME_MS);
  });
  a.addEventListener('error', () => {
    if (stale() || state.playState === 'idle') return;
    onMediaFailure(mediaErrorText(a.error), state.nowIdx);
  });
}

function stepHistory(dir) {
  if (!state.history.length) return;
  let k = state.histCursor + dir;
  k = (k + state.history.length) % state.history.length;
  state.histCursor = k;
  const uuid = state.history[k].uuid;
  const idx = state.uuidToIdx && state.uuidToIdx.get(uuid);
  renderLists();
  if (idx == null) { toast('历史里的这台不在当前快照里', 3000, true); return; }
  state.navFromIdx = idx;
  play(idx, { chain: false });
}

function exportCsv() {
  if (!state.history.length) { toast('没有历史可导出', 2500); return; }
  const csv = toCsv(state.history, HISTORY_COLUMNS);
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shibo-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`导出 ${state.history.length} 条历史`);
}

function tickSleep() {
  const left = sleepRemaining(Date.now(), state.sleepUntil);
  if (left <= 0) {
    clearInterval(state.sleepTick);
    els.sleepOut.textContent = '';
    state.sleep.value = '0';
    els.audio.pause();
    goState('paused');
    state.chainOn = false;
    setStatus('睡眠定时结束，已停止播放', 'ok');
    return;
  }
  const m = Math.floor(left / 60), s = left % 60;
  els.sleepOut.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// recent 和 tags 存的都是「本份快照里的下标」，而每天的全量刷新会整体重排下标
// （CSV 服务端分页顺序不保证稳定）。所以必须带快照签名：签名不符就丢掉，
// 否则跨天恢复会把「最近听过」和「已选风格」安到完全另一批电台/标签头上
const SESSION_KEY = 'shibo.session.v2';

function persistSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      sig: state.sig || '',
      recent: state.recent.slice(-200),
      tags: [...state.cond.tags],
    }));
  } catch {}
}

function restoreSession(sig) {
  if (!sig) return;
  try {
    const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!v || v.sig !== sig) return;
    if (Array.isArray(v.recent)) state.recent = v.recent.filter((n) => Number.isInteger(n));
    if (Array.isArray(v.tags)) state.cond.tags = new Set(v.tags.filter((n) => Number.isInteger(n)));
  } catch {}
}

bind();
boot();
setInterval(paintClock, 20000);
