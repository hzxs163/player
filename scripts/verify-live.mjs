#!/usr/bin/env node
// 验「线上那份页面」和「APK 里那份」是不是同一串字节。
//
// APK 内的页面由 sync-www.mjs 从 deploy-pages.yml 的 cp 行取，verify-apk.mjs 已经保证
// APK == 清单；这里补上另一半：清单 == Pages 上真实响应回来的字节。
// 两边都过，才敢说壳里跑的就是 https://hzxs163.github.io/player/ 那一份。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www-manifest.json');

export async function checkLive({ base, manifestRaw, log = console.log } = {}) {
  const man = JSON.parse(manifestRaw ?? fs.readFileSync(MANIFEST, 'utf8'));
  const origin = base || man.site;
  let bad = 0;
  for (const f of man.files) {
    const rel = f.path.replace(/^www\//, '');
    const url = origin.replace(/\/$/, '') + '/' + rel;
    let buf, note = '';
    try {
      const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const enc = r.headers.get('content-encoding');
      if (enc) note = `（响应带 content-encoding:${enc}，那是解压后的字节）`;
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      bad++;
      log(`FAIL  ${rel} 取不到：${e.message}`);
      continue;
    }
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== f.bytes || sum !== f.sha256) {
      bad++;
      log(`FAIL  ${rel} 线上 ${buf.length} B / ${sum.slice(0, 12)}… ≠ 清单 ${f.bytes} B / ${f.sha256.slice(0, 12)}…${note}`);
    } else {
      log(`PASS  ${rel} ${buf.length} B ${sum.slice(0, 12)}…`);
    }
  }
  log(`\n${man.files.length - bad}/${man.files.length} 个文件与线上逐字节一致：${origin}`);
  return bad === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined;
  checkLive({ base }).then((ok) => process.exit(ok ? 0 : 1));
}
