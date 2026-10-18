#!/usr/bin/env node
// 把「Pages 实际发出去的那份站点」原样复制进 APK 的 assets/www。
//
// 站点清单不在这儿重写一遍：直接从 .github/workflows/deploy-pages.yml 的组装步骤里读 cp 命令。
// 于是「壳里的页面 == 线上页面」是结构上的事实，而不是两份列表要靠人记得同步；
// 哪天 deploy 改了要发哪些文件，APK 自动跟着变，读不出来就红，不会悄悄少打一个文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF = path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml');
const OUT = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');
export const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www-manifest.json');

/** 从 deploy workflow 的 YAML 文本里读出 cp 行：返回 [{ srcs, dest }]，dest 形如 site/src/。 */
export function siteCopies(yaml) {
  const out = [];
  for (const line of String(yaml).split(/\r?\n/)) {
    const m = /^\s*cp\s+(\S.*?)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    out.push({ srcs: m[1].trim().split(/\s+/), dest: m[2] });
  }
  return out;
}

/** 把 cp 行展开成「仓库相对路径 -> 站点相对路径」的确定映射。 */
export function planFiles(yaml) {
  const copies = siteCopies(yaml);
  const plan = [];
  for (const c of copies) {
    if (!c.dest.startsWith('site/')) continue; // 拷到别处的不是站点内容
    const destDir = c.dest.replace(/^site/, '').replace(/\/$/, '');
    for (const pattern of c.srcs) {
      // Windows 上 globSync 回的是反斜杠路径，不归一化的话 basename 拆不开、清单里也会混进两种分隔符
      const hits = (/[*?[\]]/.test(pattern) ? fs.globSync(pattern, { cwd: ROOT }) : [pattern])
        .map((p) => p.split(path.sep).join('/'));
      for (const src of hits.sort()) {
        if (!fs.statSync(path.join(ROOT, src)).isFile()) continue;
        plan.push({ src, dest: path.posix.join(destDir, path.posix.basename(src)).replace(/^\/+/, '') });
      }
    }
  }
  return plan;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sync({ quiet = false } = {}) {
  const yaml = fs.readFileSync(WF, 'utf8');
  const plan = planFiles(yaml);
  // 一条都没匹配上 = deploy 的步骤写法变了，这时候必须炸，不能打一个空壳 APK
  if (plan.length < 3) {
    throw new Error(`从 deploy-pages.yml 只读出 ${plan.length} 个站点文件，清单解析八成失效了`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const files = [];
  for (const { src, dest } of plan) {
    const buf = fs.readFileSync(path.join(ROOT, src));
    const target = path.join(OUT, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    files.push({ path: 'www/' + dest, bytes: buf.length, sha256: sha256(buf) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { source: 'hzxs163/player', site: 'https://hzxs163.github.io/player/', files };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  if (!quiet) {
    for (const f of files) console.log(`${f.sha256.slice(0, 12)}  ${String(f.bytes).padStart(9)}  ${f.path}`);
    console.log(`\n${files.length} 个文件，共 ${files.reduce((n, f) => n + f.bytes, 0)} 字节 -> ${path.relative(ROOT, OUT)}`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sync();
}
