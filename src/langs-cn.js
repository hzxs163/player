// 语言名 → 中文。
// dict.lang 是广播者自己填的自由文本（全库 1352 种写法：english / engilsh / american english /
// español - latinoamerica / язык: русский），所以这里按「归一化后的常见写法」查表，
// 查不到就原样显示——宁可看到 english，也不想看到乱码或空白。
// test/run.mjs 会拿真实产物里出现频次 ≥40 的值逐个校验覆盖率。

// 归一化：去变音符、小写、把标点当空格、压缩空白。key 一律是归一化之后的形态。
function normKey(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[:,.()\[\]\-\u2013_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const LANG_CN = {
  english: '英语', 'american english': '英语（美式）', 'english uk': '英语（英式）',
  'british english': '英语（英式）', engilsh: '英语',
  spanish: '西班牙语', espanish: '西班牙语', español: '西班牙语',
  'espanol mexico': '西班牙语（墨西哥）', 'espanol argentina': '西班牙语（阿根廷）',
  'espanol chile': '西班牙语（智利）', 'espanol internacional': '西班牙语（国际）',
  'espanol latinoamerica': '西班牙语（拉美）', 'castellano espanol': '西班牙语（卡斯蒂利亚）',
  german: '德语', 'austria german': '德语（奥地利）', 'swiss german': '德语（瑞士）',
  french: '法语', 'canadian french': '法语（加拿大）', italian: '意大利语',
  chinese: '中文', mandarin: '普通话', cantonese: '粤语',
  russian: '俄语', 'язык: русский': '俄语', ukrainian: '乌克兰语', ukranian: '乌克兰语',
  polish: '波兰语', portuguese: '葡萄牙语', 'brazilian portuguese': '葡萄牙语（巴西）',
  'português brasil': '葡萄牙语（巴西）', 'pt-br': '葡萄牙语（巴西）',
  dutch: '荷兰语', arabic: '阿拉伯语', ar: '阿拉伯语', greek: '希腊语',
  hindi: '印地语', tamil: '泰米尔语', telugu: '泰卢固语', kannada: '卡纳达语',
  malayalam: '马拉雅拉姆语', bengali: '孟加拉语', punjabi: '旁遮普语',
  marathi: '马拉地语', urdu: '乌尔都语', gujarati: '古吉拉特语', nepali: '尼泊尔语',
  serbian: '塞尔维亚语', croatian: '克罗地亚语', bosnian: '波斯尼亚语',
  romanian: '罗马尼亚语', romania: '罗马尼亚语', romana: '罗马尼亚语',
  bulgarian: '保加利亚语', czech: '捷克语', slovak: '斯洛伐克语',
  turkish: '土耳其语', hungarian: '匈牙利语',
  swedish: '瑞典语', norwegian: '挪威语', danish: '丹麦语', finnish: '芬兰语',
  icelandic: '冰岛语',
  indonesian: '印尼语', malay: '马来语', thai: '泰语', vietnamese: '越南语',
  korean: '韩语', japanese: '日语', filipino: '菲律宾语', tagalog: '他加禄语',
  hebrew: '希伯来语', persian: '波斯语', farsi: '波斯语',
  armenian: '亚美尼亚语', georgian: '格鲁吉亚语', azerbaijani: '阿塞拜疆语',
  kurdish: '库尔德语', albanian: '阿尔巴尼亚语', macedonian: '马其顿语',
  slovenian: '斯洛文尼亚语', estonian: '爱沙尼亚语', latvian: '拉脱维亚语',
  lithuanian: '立陶宛语', irish: '爱尔兰语', welsh: '威尔士语',
  'scottish gaelic': '苏格兰盖尔语', gaelic: '盖尔语', basque: '巴斯克语',
  catalan: '加泰罗尼亚语', galician: '加利西亚语', esperanto: '世界语',
  latin: '拉丁语', yiddish: '意第绪语',
  afrikaans: '南非荷兰语', swahili: '斯瓦希里语', amharic: '阿姆哈拉语',
  somali: '索马里语', zulu: '祖鲁语', xhosa: '科萨语', yoruba: '约鲁巴语',
  hausa: '豪萨语', igbo: '伊博语', shona: '绍纳语', chichewa: '齐切瓦语',
  akan: '阿肯语', wolof: '沃洛夫语', kinyarwanda: '卢旺达语', luganda: '干达语',
  sotho: '塞索托语', setswana: '茨瓦纳语', twi: '特威语',
  hawaiian: '夏威夷语', maori: '毛利语', samoan: '萨摩亚语', fijian: '斐济语',
  inuktitut: '因纽特语', creole: '克里奥尔语', papiamento: '帕皮阿门托语',
  // 非语言值也会出现这一列里（Radio Browser 不校验），照实翻出来比裸着强
  unknown: '语言未知', other: '其他语言', multilingual: '多语种',
};

// 表键和输入走同一个归一化，写表时可以用带重音的自然写法（español / português），
// 不会因为漏了某一步而「明明在表里却查不到」
const NORM = new Map(Object.entries(LANG_CN).map(([k, v]) => [normKey(k), v]));

// "english,german" 这类一格多语言：拆开逐个翻，用顿号拼回去
export function langName(raw = '') {
  const s = String(raw).trim();
  if (!s) return '';
  const parts = s.split(/[;,/]+/).map((p) => {
    const k = normKey(p);
    return NORM.get(k) || p.trim(); // 查不到就照原样留着，归一化只用于查表，不拿去显示
  }).filter(Boolean);
  return parts.join('、');
}
