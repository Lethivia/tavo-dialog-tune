/**
 * 生成「最小排查包」：dist/dialog-tune-minimal-1.0.0.zip
 *
 * 用途：二分定位导入失败的原因。
 *   - 最小包也装不上 → 问题在「文件本身 / 文件选择器 / 传输」这一层，与清单字段无关；
 *   - 最小包装得上   → 问题在完整清单的某个字段，逐项加回即可定位。
 *
 * 最小包保留：id / name / version / entry / author / description / 一个输入动作，
 * 去掉：国际化、封面、图标、设置页、HTML 片段、可见性声明。
 *
 * 用法：node scripts/build-minimal.mjs
 */
import zlib from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

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

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
  const day = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

  for (const [name, raw] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const manifest = {
  specVersion: 2,
  id: 'io.github.dialogtune.dialog-tune-min',
  name: '对话微调（最小排查包）',
  version: "1.0.2",
  entry: 'entry.js',
  author: 'Dialog Tune',
  description: '用于定位导入失败的最小插件包。'
};

const entry = `/* 最小排查包入口：不做任何事，只验证插件包能否被导入。 */
tavo.plugin.onInputAction('noop', async function () {
  await tavo.utils.toast('dialog-tune minimal');
});
`;

mkdirSync(DIST, { recursive: true });
const outFile = resolve(DIST, 'dialog-tune-minimal-1.0.2.zip');
rmSync(outFile, { force: true });

const entries = [
  ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')],
  ['entry.js', Buffer.from(entry, 'utf8')]
];

/* 优先用系统 zip；失败则用内置写入器 */
const staged = resolve(DIST, '.minimal-stage');
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
writeFileSync(resolve(staged, 'manifest.json'), entries[0][1]);
writeFileSync(resolve(staged, 'entry.js'), entries[1][1]);
const result = spawnSync('zip', ['-r', '-q', outFile, 'manifest.json', 'entry.js'], {
  cwd: staged,
  stdio: 'pipe'
});
let via = '系统 zip';
if (result.error || result.status !== 0) {
  via = '内置 ZIP 写入器';
  writeFileSync(outFile, buildZip(entries));
}
rmSync(staged, { recursive: true, force: true });

console.log(`已生成最小排查包 → ${outFile}（${via}，${(statSync(outFile).size / 1024).toFixed(1)} KB）`);
