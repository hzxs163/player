// node test/run.mjs —— 纯逻辑层的单元测试（不依赖浏览器）
import assert from 'node:assert';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as C from '../src/core.js';
import * as CN from '../src/countries-cn.js';
import * as LN from '../src/langs-cn.js';
import * as S from '../src/store.js';
import * as R from '../src/radio.js';

let failed = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), s = JSON.stringify(want);
  if (g === s) console.log(`PASS  ${name}: ${g.length > 80 ? g.slice(0, 80) + '…' : g}`);
  else { failed++; console.log(`FAIL  ${name}\n      得到 ${g}\n      期望 ${s}`); }
};

// ---------- 真数据集解码（本地 data/ 里的产物） ----------
const dataDir = path.join(import.meta.dirname, '..', 'data');
const gz = fs.readFileSync(path.join(dataDir, 'stations.web.json.gz'));
const idsGz = fs.readFileSync(path.join(dataDir, 'stations.ids.json.gz'));
const text = zlib.gunzipSync(gz).toString('utf8');
const headerLine = text.slice(0, text.indexOf('\n'));
const header = JSON.parse(headerLine);
// 浏览器端用 DecompressionStream 解压，这里把已解压的文本喂进去，验证的是解析逻辑而不是解压
const ds = C.parseDataset(new TextEncoder().encode(text));
const ids = JSON.parse(zlib.gunzipSync(idsGz).toString('utf8'));
eq('数据集行数与 ids 数一致', [ds.rows.length, ids.length], [62022, 62022]);
eq('表头字段齐全', Object.keys(C.COL).every((k) => header.fields.includes(k)), true);
eq('第一行是数组且长度=字段数', ds.rows[0].length, header.fields.length);

// ---------- 国家统计（质心只由真实坐标算出，无坐标的台不参与） ----------
const stats = C.countryStats(ds);
const de = stats.get("DE");
eq("德国有统计且质心在界内", Boolean(de) && de.lat > 35 && de.lat < 72 && de.lon > -12 && de.lon < 30, true);
eq("国家台数=有坐标+无坐标", de.n >= de.nGeo && de.nGeo > 0, true);
// 只有一半坐标（有经度没纬度）也算没坐标，跟 applyFilter 的 geoOnly 同一口径
const hasPos = (r) => r[C.COL.lat] !== 0 && r[C.COL.lon] !== 0;
const halfPos = (r) => (r[C.COL.lat] === 0) !== (r[C.COL.lon] === 0);
const nGeo = ds.rows.filter(hasPos).length;
// 原始数据 13482 行填了坐标：2 行越界（100.5°N、-273°W）被 parseDataset 打回全零，另有 2 行只填了一半
eq("越界坐标被打回、只填一半的不算坐标",
  [nGeo, ds.rows.filter(halfPos).length, ds.rows.filter((r) => !r[C.COL.lat] && !r[C.COL.lon]).length],
  [13478, 2, 48542]);
eq("geoOnly 只留真有坐标的台（13478 vs 全库 62022）", C.applyFilter(ds, ds.rows, { geoOnly: true }).length, 13478);
eq("坐标全部夹在合法范围", ds.rows.every((r) => (r[C.COL.lat] === 0 && r[C.COL.lon] === 0)
  || (r[C.COL.lat] >= -90 && r[C.COL.lat] <= 90 && r[C.COL.lon] >= -180 && r[C.COL.lon] <= 180)), true);
eq("有画不出来的国家时质心留 null", [...stats.values()].every((c) => (c.nGeo === 0 ? c.lat === null : Number.isFinite(c.lat))), true);

// ---------- 筛选 ----------
const all = ds.rows.map((_, i) => i);
const secureOnly = C.applyFilter(ds, ds.rows, { secureOnly: true });
eq('仅 https 命中率与数据侧一致', Math.round(secureOnly.length / ds.rows.length * 1000) / 10, 64.2);
eq('筛选结果是原下标且升序', secureOnly.every((v, i, a) => i === 0 || v > a[i - 1]), true);
// ---------- HLS 与 http 升级 ----------
eq('按地址认 HLS', [C.isHlsUrl('http://x/a/128k.m3u8'), C.isHlsUrl('https://x/a.m3u8?token=1'),
  C.isHlsUrl('https://x/a.mp3'), C.isHlsUrl(''), C.isHlsUrl(null)], [true, true, false, false, false]);
const hideHls = C.applyFilter(ds, ds.rows, { hideHls: true });
eq('排除 HLS 连标记漏报的 .m3u8 一起排掉',
  hideHls.every((i) => ds.rows[i][C.COL.hls] !== 1 && !C.isHlsUrl(ds.rows[i][C.COL.url_resolved])), true);
eq('升级 http → https 保留路径与查询',
  C.upgradeToHttps('http://ali-m-l.cztv.com/channels/lantian/fm107/128k.m3u8'),
  'https://ali-m-l.cztv.com/channels/lantian/fm107/128k.m3u8');
// 带端口的主机不能换协议：端口后面常常只监听 http，换了是另一种失败
eq('带端口不升级', C.upgradeToHttps('http://abm21.com.au:8000/stream'), '');
eq('localhost 不升级', C.upgradeToHttps('http://localhost:8123/x'), '');
eq('本来就是 https 不再升级', C.upgradeToHttps('https://a/b'), '');
eq('非 http 协议不升级', C.upgradeToHttps('rtmp://a/b'), '');
eq('空地址不升级', C.upgradeToHttps(''), '');
eq('Safari 系原生能放就不上库', C.hlsMode({ canPlayType: () => 'probably' }), 'native');
// Chromium 会客气地回 "maybe" 但其实放不了，只认 "probably"
eq('Chromium 的 maybe 不算原生支持', C.hlsMode({ canPlayType: () => 'maybe' }), typeof globalThis.MediaSource === 'function' ? 'lib' : 'none');
eq('没有 canPlayType 也不给 native', C.hlsMode({}), typeof globalThis.MediaSource === 'function' ? 'lib' : 'none');
eq('短地址原样', C.clipUrl('https://a/b.mp3'), 'https://a/b.mp3');
eq('刚好到上限不加省略号', C.clipUrl('x'.repeat(120)).length, 120);
eq('超长截断并留省略号', [C.clipUrl('y'.repeat(500)).length, C.clipUrl('y'.repeat(500)).endsWith('…')], [120, true]);
eq('空地址给空串不报错', [C.clipUrl(''), C.clipUrl(null), C.clipUrl(undefined)], ['', '', '']);
// 数据里最长的一条是 7.8K 字符，直接写进面板会把版式顶爆，取全体行长上限来验截断真的生效
eq('全集最长地址截断后不超过 120', Math.max(...ds.rows.map((r) => C.clipUrl(r[C.COL.url_resolved]).length)) <= 120, true);
const tagIdx = ds.dict.tags.indexOf('jazz');
const byTag = C.applyFilter(ds, ds.rows, { tags: new Set([tagIdx]) });
eq('按 tags 下标筛选命中', byTag.length > 500 && byTag.every((i) => ds.rows[i][C.COL.tags].includes(tagIdx)), true);
const byName = C.applyFilter(ds, ds.rows, { query: 'bbc world' });
// 搜索词的判定域是「名字 + 全部标签」拼起来的串（名字没命中才回落到标签），
// 所以断言也得按同一个口径写，否则改了匹配规则测试还停在旧契约上
const hayOf = (i) => [ds.rows[i][C.COL.name], ...ds.rows[i][C.COL.tags].map((t) => ds.dict.tags[t])]
  .join(' ').toLowerCase();
eq('按名搜索（多词全部命中，允许走标签回落）', byName.length > 0 && byName.every((i) => hayOf(i).includes('bbc') && hayOf(i).includes('world')), true);
const mini = {
  dict: { cc: ['CN'], country: ['China'], lang: ['chinese'], codec: ['MP3'], tags: ['fujian', 'news'] },
  col: Object.fromEntries(Object.keys(C.COL).map((k) => [k, C.COL[k]])),
  rows: [
    ['厦门卫视', 'https://a/', 0, 0, 0, [0, 1], 5, 128, 0, 0, 0, 0],
    ['Central', 'https://b/', 0, 0, 0, [1], 5, 128, 0, 0, 0, 0],
  ],
};
eq('名字里没有、只在 tags 里的词也要搜得到', C.applyFilter(mini, mini.rows, { query: 'fujian' }), [0]);
eq('中文词命中名字', C.applyFilter(mini, mini.rows, { query: '厦门' }), [0]);
eq('多词允许跨名字与标签分布', C.applyFilter(mini, mini.rows, { query: '厦门 news' }), [0]);
eq('凑不齐词就不命中', C.applyFilter(mini, mini.rows, { query: 'xiamen news' }), []);
const deOnly = C.applyFilter(ds, ds.rows, { ccs: new Set(['DE']) });
eq('按国家码筛选', deOnly.length > 1000 && deOnly.every((i) => ds.dict.cc[ds.rows[i][C.COL.cc]] === 'DE'), true);
eq('空条件返回全部', C.applyFilter(ds, ds.rows, {}).length, ds.rows.length);

// ---------- 加权随机 ----------
const rng = C.makeRng(20261018);
const rng2 = C.makeRng(20261018);
eq('同种子序列可复现', [rng(), rng()], [rng2(), rng2()]);
const recent = [];
const picks = [];
for (let k = 0; k < 50; k++) {
  const i = C.pickWeighted(ds.rows, all, C.makeRng(1000 + k), recent);
  picks.push(i);
  C.rememberRecent(recent, i);
}
eq('近期不重复：连续 50 抽无重复', new Set(picks).size, 50);
const biased = C.pickWeighted(ds.rows, all, C.makeRng(7), []);
eq('抽样结果在候选集内', all.includes(biased), true);
eq('候选集为空时不返回野下标', C.pickWeighted(ds.rows, [], Math.random), -1);
// 加权是否正确要在小池上精确验：大池抽 2000 次的方差比效应本身还大，测不出实现错误
const pool = [
  ['', 'u1', 0, 0, 0, [], 0, 0, 0, 0, 10, 10],
  ['', 'u2', 0, 0, 0, [], 999999, 0, 0, 0, 10, 10],
];
const w = pool.map((r) => C.weightOf(r));
const expectHigh = w[1] / (w[0] + w[1]);
const seen = { 0: 0, 1: 0 };
const rngBias = C.makeRng(424242);
for (let k = 0; k < 40000; k++) seen[C.pickWeighted(pool, [0, 1], rngBias, [])]++;
const measured = seen[1] / 40000;
eq('加权抽样命中率与理论权重相符（误差 <3%）', Math.abs(measured - expectHigh) < 0.03, true);
eq('高票台确实被偏好', measured > 0.55, true);
eq('大池抽样只返回合法下标', (() => {
  for (let k = 0; k < 300; k++) {
    const i = C.pickWeighted(ds.rows, all, Math.random, []);
    if (!all.includes(i)) return false;
  }
  return true;
})(), true);
eq('权重恒为正', C.weightOf(ds.rows[0]) > 0 && C.weightOf([ '', '', 0, 0, 0, [], 0, 0, 0, 1, 0, 0 ]) > 0, true);

// ---------- 旗帜 ----------
eq('合法码出旗帜', C.flagEmoji('DE'), '🇩🇪');
eq('非法码出占位', C.flagEmoji(''), '⬜');
eq('字典国家名可读', C.stationCountry(ds, ds.rows[0]).length > 2, true);

// ---------- 本地状态 ----------
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const store = memStore();
eq('空存储返回空数组', S.loadHistory(store), []);
const e1 = { uuid: 'U1', name: '一', time: 1 };
const e2 = { uuid: 'U2', name: '二', time: 2 };
let h = S.pushHistory([], e1);
h = S.pushHistory(h, e2);
eq('新记录在前', h.map((x) => x.uuid), ['U2', 'U1']);
h = S.pushHistory(h, e1);
eq('重复播放不产生第二条且移到最前', h.map((x) => x.uuid), ['U1', 'U2']);
eq('历史封顶', S.pushHistory(Array.from({ length: 305 }, (_, i) => ({ uuid: 'x' + i, name: 'n', time: i })), e1).length, S.HISTORY_CAP);
eq('写坏 JSON 不炸', (() => { store.setItem('shibo.history.v1', '{坏掉'); return S.loadHistory(store); })(), []);
S.saveHistory(store, h);
eq('存取往返', S.loadHistory(store).map((x) => x.uuid), ['U1', 'U2']);
const fav = S.toggleFavorite([], e1);
eq('收藏新增', [fav.added, fav.list.length], [true, 1]);
const unfav = S.toggleFavorite(fav.list, e1);
eq('再点取消', [unfav.added, unfav.list.length], [false, 0]);
eq('收藏判定', S.isFavorite([{ uuid: 'U1' }], 'U1'), true);
eq('CSV 转义引号与逗号', S.toCsv([{ name: '他,说"嗨"', uuid: 'u' }], ['name', 'uuid']), 'name,uuid\r\n"他,说""嗨""",u\r\n');
eq('CSV 空值不写 undefined', S.toCsv([{ name: null, uuid: 'u' }], ['name', 'uuid']), 'name,uuid\r\n,u\r\n');
eq('睡眠剩余秒数非负', S.sleepRemaining(1000, 0), 0);
eq('睡眠截止按分钟推', S.sleepDeadline(0, 5), 300000);

// ---------- 官方上报与播放策略 ----------
eq('镜像只有官方两台', R.MIRRORS, ['de1.api.radio-browser.info', 'de2.api.radio-browser.info']);
eq('上报 URL 就是取流地址本身（服务端按它计点击）', R.clickUrl('abc-123', 'de1.api.radio-browser.info'), 'https://de1.api.radio-browser.info/json/url/abc-123');
eq('投票 URL 走 /json/vote', R.voteUrl('u', 'de2.api.radio-browser.info').endsWith('/json/vote/u'), true);
eq('镜像随机分布到两台', (() => { const s = new Set(); for (let i = 0; i < 200; i++) s.add(R.pickMirror()); return s.size; })(), 2);
eq('非法 uuid 被编码', R.clickUrl('a b/c').includes('a%20b%2Fc'), true);
eq('致命错误识别', R.isFatalMediaError('The play source was not supported'), false);
eq('MEDIA_ERR_SRC_NOT_SUPPORTED 文案识别', R.isFatalMediaError('no supported audio source was found'), true);
eq('空错误不误判', R.isFatalMediaError(''), false);
// MediaError.message 在真浏览器里是空串，只有 code 有信息量——不映射就等于没有 fatal 判定
eq('MediaError code 映射成名字', R.mediaErrorText({ code: 4, message: '' }), 'MEDIA_ERR_SRC_NOT_SUPPORTED');
eq('映射后的名字算致命', R.isFatalMediaError(R.mediaErrorText({ code: 4, message: '' })), true);
eq('解码失败也算致命', R.isFatalMediaError(R.mediaErrorText({ code: 3, message: '' })), true);
eq('网络错误不算致命（值得退避重试）', R.isFatalMediaError(R.mediaErrorText({ code: 2, message: '' })), false);
eq('name 优先于 code', R.mediaErrorText({ code: 2, name: 'MEDIA_ERR_NETWORK', message: 'x' }), 'MEDIA_ERR_NETWORK x');
eq('空对象不炸', R.mediaErrorText(null), 'error');
eq('起播超时必须给得出去', R.START_TIMEOUT_MS > 5000, true);
eq('连挂时退避递增且封顶', [R.nextRetryDelay(0), R.nextRetryDelay(2), R.nextRetryDelay(9)], [600, 2400, 8000]);
eq('连挂到上限后停止自动换台', [R.shouldAutoSkip(11), R.shouldAutoSkip(12)], [true, false]);
eq('状态迁移表按预期', [R.canGo('idle', 'loading'), R.canGo('idle', 'playing'), R.canGo('error', 'loading')], [true, false, true]);

// ---------- 中文国名表：逐码覆盖，漏一个就红 ----------
const ccCodes = header.dict.cc.filter(Boolean);
const missingCn = ccCodes.filter((c) => !CN.CC_CN[c]);
eq('中文国名表覆盖数据集里全部国家码', [ccCodes.length, missingCn], [242, []]);
eq('码表本身没有空值或错码', Object.entries(CN.CC_CN).every(([k, v]) => /^[A-Z]{2}$/.test(k) && v.length > 0), true);
eq('查不到时退回英文名', CN.ccName('ZZ', 'Nowhere'), 'Nowhere');
eq('连英文名都没有时给码', CN.ccName('ZZ'), 'ZZ');
eq('中国/港台按行政区划写法', [CN.CC_CN.CN, CN.CC_CN.TW, CN.CC_CN.HK, CN.CC_CN.MO], ['中国', '中国台湾', '中国香港', '中国澳门']);

// ---------- 中文语言名表：广播者乱填（1352 种写法），高频值必须全部翻出来 ----------
const langCounts = new Map();
for (const r of ds.rows) {
  const v = ds.dict.lang[r[ds.col.lang]] || '';
  langCounts.set(v, (langCounts.get(v) || 0) + 1);
}
const hotLangs = [...langCounts.entries()].filter(([v, n]) => v !== '' && n >= 40).map(([v]) => v);
const untranslated = hotLangs.filter((v) => !/[一-鿿]/.test(LN.langName(v)));
eq('高频语言写法全部有中文名', [hotLangs.length, untranslated], [77, []]);
eq('一格多语言拆开逐个翻', LN.langName('english,german'), '英语、德语');
eq('重音与错拼照样命中', [LN.langName('español - latinoamerica'), LN.langName('engilsh'), LN.langName('pt-br')],
  ['西班牙语（拉美）', '英语', '葡萄牙语（巴西）']);
eq('俄语的「язык: русский」也算俄语', LN.langName('язык: русский'), '俄语');
eq('生僻写法原样留着，不吞字', LN.langName('interlingua'), 'interlingua');
eq('空语言给空串', LN.langName(''), '');
eq('中文与粤语分得开', [LN.langName('chinese'), LN.langName('cantonese')], ['中文', '粤语']);
const rowOf = (url, codecIdx, br) => ['x', url, 0, 0, 0, [], 1, br, codecIdx, 0, 0, 0];
eq('编码名 + 码率', C.codecBitrate(ds, rowOf('https://a/x.mp3', 0, 128)), 'MP3 128k');
eq('没填码率就只留编码名', C.codecBitrate(ds, rowOf('https://a/x.mp3', 0, 0)), 'MP3');
eq('UNKNOWN 编码不算编码，HLS 顶上', C.codecBitrate(ds, rowOf('http://a/x.m3u8', 3, 0)), 'HLS');
eq('编码码率都没有时给「未知」', C.codecBitrate(ds, rowOf('https://a/x.mp3', 3, 0)), '未知');
eq('只有码率时不留空', C.codecBitrate(ds, rowOf('https://a/x.mp3', 3, 64)), '64k');
eq('codecName 把 UNKNOWN 当没填', C.codecName(ds, rowOf('https://a/x.mp3', 3, 0)), '');

// ---------- 客户端位置推断与排序 ----------
eq('时区命中大陆 → CN', C.guessUserCc({ timeZone: 'Asia/Shanghai' }), 'CN');
eq('时区乌鲁木齐也算大陆时区', C.guessUserCc({ timeZone: 'Asia/Urumqi' }), 'CN');
eq('语言带地区 → 取地区', C.guessUserCc({ language: 'pt_BR' }), 'BR');
eq('zh-CN → CN', C.guessUserCc({ language: 'zh-CN' }), 'CN');
eq('只有 zh 不猜国家', C.guessUserCc({ language: 'zh' }), '');
eq('什么都不知道就什么都不选', C.guessUserCc({}), '');
eq('北京→上海约 1068km', (() => {
  const d = C.haversineKm({ lat: 39.904, lon: 116.407 }, { lat: 31.23, lon: 121.474 });
  return d > 1050 && d < 1090;
})(), true);
const ccItems = [
  { cc: 'US', n: 100, lat: 39.8, lon: -98.6 },
  { cc: 'JP', n: 50, lat: 36.2, lon: 138.2 },
  { cc: 'CN', n: 994, lat: 35.0, lon: 105.0 },
  { cc: 'XX', n: 700, lat: null, lon: null },
];
eq('有锚点时按远近排，无质心的殿后', C.sortCountriesByPosition(ccItems, { lat: 35.0, lon: 105.0 }).map((x) => x.cc), ['CN', 'JP', 'US', 'XX']);
eq('无锚点时退回台数降序', C.sortCountriesByPosition(ccItems, null).map((x) => x.cc), ['CN', 'XX', 'US', 'JP']);

// ---------- 调谐刻度与当地时间 ----------
eq('刻度取左右各三格', C.dialNeighbors([5, 9, 12, 20, 31, 44, 60, 77, 90], 20, 3).map((x) => x.idx), [5, 9, 12, 20, 31, 44, 60]);
eq('同名邻居跳过一次，当前台仍在正中',
  C.dialNeighbors([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 15, 3,
    (i) => ({ 11: 'A', 12: 'A', 13: 'B', 15: 'C', 16: 'C' }[i] || 'n' + i)).map((x) => x.idx),
  [11, 13, 14, 15, 17, 18, 19]);
eq('去重后名字为空的台不被互相吃掉',
  C.dialNeighbors([1, 2, 3, 4, 5], 3, 1, () => '').map((x) => x.idx), [2, 3, 4]);
eq('贴边时不越界', C.dialNeighbors([1, 2, 3], 1, 3).map((x) => x.idx), [1, 2, 3]);
eq('当前台不在筛选结果里时刻度为空', C.dialNeighbors([1, 2, 3], 99, 3), []);
eq('空池为空', C.dialNeighbors([], -1, 3), []);
const noonUtc = new Date(Date.UTC(2026, 9, 18, 4, 0, 0));
eq('东经 116 度给 12:00（与机器时区无关）', C.localMeanTime(116, noonUtc), '12:00');
eq('西经 105 度给前一日 21:00', C.localMeanTime(-105, noonUtc), '21:00');
eq('经度 0 是缺省哨兵，不显示', C.localMeanTime(0, noonUtc), '');
eq('缺经度不显示', C.localMeanTime(undefined, noonUtc), '');

// ---------- gzip 兜底提示 ----------
const roundTrip = await C.inflate(gz);
eq('inflate 往返等于原文件', new TextDecoder().decode(roundTrip).length, text.length);
const keepDcs = globalThis.DecompressionStream;
delete globalThis.DecompressionStream;
eq('没有 DecompressionStream 时明确报错而不是静默失败',
  await C.inflate(new Uint8Array([1, 2])).then(() => '没报错', (e) => e.message.slice(0, 8)),
  '这个浏览器不支持');
globalThis.DecompressionStream = keepDcs;

console.log(failed ? `\n${failed} 个用例失败` : `\n全部用例通过（${ds.rows.length} 行真实数据参与校验）`);
process.exit(failed ? 1 : 0);
