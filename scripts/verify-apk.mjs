#!/usr/bin/env node
// 校验构建出来的 APK：里面那份页面必须逐字节等于构建清单，签名必须是仓库里那把钥匙。
//
// 本机没有 JDK/Android SDK，所以这个脚本只在 CI 里跑全量；本地能跑 --www-only，
// 用来证明「zip 读取 + 清单比对」这套逻辑本身是对的，而不是等 CI 才发现解析写错了。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_ASSET = 'assets/www-manifest.json';
const CLASSES = ['MainActivity', 'PlayService', 'StoreBridge', 'ShellClient', 'MediaBridge'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 最小 zip 读取器：只解中央目录 + 需要的条目，APK 就是 zip。 */
export function readZip(buf) {
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到中央目录结尾标记');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录条目损坏 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    // Windows 上打的包有时用反斜杠当分隔符，归一化后两种都认
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    entries.set(name, { method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

export function zipBytes(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const p = e.local;
  if (zip.buf.readUInt32LE(p) !== 0x04034b50) throw new Error('本地文件头损坏：' + name);
  const nameLen = zip.buf.readUInt16LE(p + 26);
  const extraLen = zip.buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = zip.buf.slice(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${e.method}：${name}`);
}

function fail(list, msg) {
  list.push(msg);
  console.log('FAIL  ' + msg);
}

function ok(msg, extra) {
  console.log(`PASS  ${msg}${extra === undefined ? '' : ': ' + extra}`);
}

export function verifyApk(file, { wwwOnly = false, certDer = null } = {}) {
  const buf = fs.readFileSync(file);
  const zip = readZip(buf);
  const problems = [];

  const manRaw = zipBytes(zip, MANIFEST_ASSET);
  if (!manRaw) {
    fail(problems, `APK 里没有 ${MANIFEST_ASSET}，页面是不是没打进去`);
  } else {
    const man = JSON.parse(manRaw.toString('utf8'));
    let same = 0;
    for (const f of man.files) {
      // 清单记的是资产相对路径（www/...），包里的条目带 assets/ 前缀
      const got = zipBytes(zip, 'assets/' + f.path);
      if (!got) { fail(problems, `清单里的 assets/${f.path} 不在 APK 里`); continue; }
      if (got.length !== f.bytes) { fail(problems, `${f.path} 字节数 ${got.length} ≠ 清单 ${f.bytes}`); continue; }
      const sum = sha256(got);
      if (sum !== f.sha256) { fail(problems, `${f.path} sha256 不符：${sum.slice(0, 12)} ≠ ${f.sha256.slice(0, 12)}`); continue; }
      same++;
    }
    // 反向也要查：多出来的文件说明有人往 assets 里塞了清单外的东西
    const listed = new Set(man.files.map((f) => 'assets/' + f.path));
    for (const name of zip.entries.keys()) {
      if (name.startsWith('assets/www/') && !listed.has(name)) fail(problems, `APK 里有清单外的页面文件：${name}`);
    }
    ok('页面资产逐字节对得上清单', `${same}/${man.files.length} 个`);
  }

  if (!wwwOnly) {
    const dex = zipBytes(zip, 'classes.dex');
    if (!dex) fail(problems, '没有 classes.dex');
    else {
      const text = dex.toString('latin1');
      const missing = CLASSES.filter((c) => !text.includes('Lcom/shibo/app/' + c + ';'));
      if (missing.length) fail(problems, `dex 里找不到类：${missing.join(', ')}`);
      else ok('五个原生类都在 dex 里', CLASSES.join(' '));
    }

    const am = zipBytes(zip, 'AndroidManifest.xml');
    if (!am) fail(problems, '没有 AndroidManifest.xml');
    else if (!am.toString('utf16le').includes('com.shibo.app')) fail(problems, '二进制清单里没有包名');
    else ok('包名在 AndroidManifest.xml(utf16le) 里');

    if (!buf.includes(Buffer.from('APK Sig Block 42'))) {
      fail(problems, '没有 APK Sig Block 42：这个包没被 v2/v3 签过名');
    } else {
      ok('APK 签名块存在（v2/v3）');
    }
    if (certDer) {
      const der = fs.readFileSync(certDer);
      if (!buf.includes(der)) fail(problems, 'APK 里没有仓库内置的那张证书 —— 签名钥匙不对，装了会覆盖不了旧版');
      else ok('签名证书就是仓库里那张', der.length + ' 字节 DER');
    } else {
      ok('没给 --cert，跳过证书比对（CI 会带上）');
    }
  }

  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apk = args.find((a) => !a.startsWith('--'));
  if (!apk) {
    console.error('用法：node scripts/verify-apk.mjs <apk> [--www-only] [--cert <der 文件>]');
    process.exit(2);
  }
  const problems = verifyApk(apk, {
    wwwOnly: args.includes('--www-only'),
    certDer: args.includes('--cert') ? args[args.indexOf('--cert') + 1] : null,
  });
  if (problems.length) {
    console.log(`\n${problems.length} 项不通过`);
    process.exit(1);
  }
  console.log('\nAPK 校验全部通过');
}
