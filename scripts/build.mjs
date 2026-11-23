/**
 * 打包 Tavo 插件为 .tpg（本质是 zip，manifest.json 必须位于包根目录）
 *
 * 零依赖：内置最小 ZIP 写入器（deflate + CRC32）。
 * 用法：node scripts/build.mjs
 */
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

/** 参与打包的路径（其余一律排除） */
const INCLUDE = ['manifest.json', 'entry.js', 'ui', 'locales', 'icons', 'cover.png'];
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.idea', '.vscode']);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime(new Date());

  for (const file of files) {
    const name = relative(ROOT, file).split(sep).join('/');
    const raw = readFileSync(file);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const files = [];
for (const item of INCLUDE) {
  const full = resolve(ROOT, item);
  let stats;
  try {
    stats = statSync(full);
  } catch {
    throw new Error(`缺少打包文件：${item}`);
  }
  if (stats.isDirectory()) walk(full, ROOT, files);
  else files.push(full);
}

if (!files.some((f) => f.endsWith('manifest.json'))) {
  throw new Error('manifest.json 必须位于插件包根目录');
}

mkdirSync(DIST, { recursive: true });

const baseName = `dialog-tune-${manifest.version}`;
const outputs = [resolve(DIST, `${baseName}.tpg`), resolve(DIST, `${baseName}.zip`)];

/**
 * 优先使用系统 zip（Info-ZIP，官方文档示例同款），产出兼容性最好的包；
 * 没有 zip 命令时退回内置的最小 ZIP 写入器。
 */
function packageWithSystemZip(outFile) {
  const result = spawnSync('zip', ['-r', '-q', outFile, ...INCLUDE], {
    cwd: ROOT,
    stdio: 'pipe'
  });
  if (result.error) return false;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ? result.stderr.toString() : '');
    return false;
  }
  return true;
}

let usedSystemZip = false;
for (const outFile of outputs) {
  rmSync(outFile, { force: true });
  if (packageWithSystemZip(outFile)) {
    usedSystemZip = true;
  } else {
    writeFileSync(outFile, buildZip(files));
  }
}

/**
 * 打包后自检：manifest.json 必须在包根目录、且与源文件逐字节一致。
 * Tavo 在导入时找不到根目录的 manifest.json 就会直接拒绝这个包。
 */
function verifyPackage(outFile) {
  const buffer = readFileSync(outFile);
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`${outFile} 不是合法的 zip`);
  }
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const firstName = buffer.slice(30, 30 + nameLength).toString('utf8');
  if (firstName !== 'manifest.json') {
    throw new Error(`包根目录第一个条目必须是 manifest.json，实际是 ${firstName}`);
  }
  const method = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const dataStart = 30 + nameLength + extraLength;
  const payload = buffer.slice(dataStart, dataStart + compressedSize);
  const raw = method === 8 ? zlib.inflateRawSync(payload) : payload;
  const source = readFileSync(resolve(ROOT, 'manifest.json'));
  if (!raw.equals(source)) {
    throw new Error('包内 manifest.json 与源文件不一致');
  }
  const parsed = JSON.parse(raw.toString('utf8'));
  return parsed;
}

console.log(`已打包 ${files.length} 个文件（${usedSystemZip ? '系统 zip / Info-ZIP' : '内置 ZIP 写入器'}）`);
for (const outFile of outputs) {
  console.log('  -', relative(ROOT, outFile), `(${(statSync(outFile).size / 1024).toFixed(1)} KB)`);
}
for (const file of files) console.log('    ·', relative(ROOT, file));

/* 自检：包根目录的 manifest.json */
const verified = verifyPackage(outputs[0]);
console.log(
  `  自检通过：包根目录 manifest.json 可解析，id=${verified.id}，version=${verified.version}`
);
