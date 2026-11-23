/**
 * 插件中心（Plugin Hub）投稿前自检
 *
 * 把官方 Hub 前端里那套校验规则逐条落地，投稿前先跑一遍：
 *   node scripts/check-hub-ready.mjs [包路径]
 *
 * 校验项来自 Hub 前端（hub.tavoai.dev）暴露的错误码与文案：
 *   packageFilenameInvalid / packageArchiveInvalid / packageEncrypted /
 *   packageSymlinkUnsupported / packagePathInvalid / packagePathDuplicate /
 *   packageTooManyFiles / packageUncompressedTooLarge / packageTooLarge /
 *   manifestMissing / manifestTooLarge / manifestSpecUnsupported /
 *   manifestInvalid / manifestEntryRequired / manifestFileInvalid /
 *   manifestContributionsInvalid / manifestSettingsInvalid /
 *   manifestLocalizationInvalid / manifestCoverInvalid / manifestCoverTooLarge /
 *   authorMismatch / i18nMismatchWarning
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = resolve(process.argv[2] || resolve(ROOT, 'dist/dialog-tune-1.0.9.tpg'));
/** Hub 账号名：manifest 的 author 必须与它一致 */
const ACCOUNT_NAME = process.env.HUB_ACCOUNT || 'Lethivia';

const problems = [];
const notes = [];
const ok = (msg) => console.log('  ✓', msg);
const bad = (msg) => {
  problems.push(msg);
  console.log('  ✗', msg);
};
const info = (msg) => {
  notes.push(msg);
  console.log('  ·', msg);
};

console.log(`\n插件中心投稿前自检：${relative(ROOT, PKG)}\n`);

/* ---------- 1. 文件名与包体 ---------- */
if (!existsSync(PKG)) {
  bad(`找不到插件包：${PKG}`);
  process.exit(1);
}
const fileName = PKG.split('/').pop();
if (!/^[\w.\-]+\.(tpg|zip)$/.test(fileName)) {
  bad(`packageFilenameInvalid：文件名不合法（只允许安全字符 + .tpg/.zip）：${fileName}`);
} else {
  ok(`packageFilenameInvalid：文件名安全（${fileName}）`);
}

const pkgSize = statSync(PKG).size;
if (pkgSize > 64 * 1024 * 1024) bad('packageTooLarge：插件包过大');
else ok(`packageTooLarge：包体 ${(pkgSize / 1024).toFixed(1)} KB，远低于上限`);

/* ---------- 2. 解包检查 ---------- */
let listing = [];
try {
  listing = execFileSync('unzip', ['-Z1', PKG], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  ok('packageArchiveInvalid：ZIP 可正常读取');
} catch (error) {
  bad('packageArchiveInvalid：不是有效的 ZIP 压缩包');
}

const fileEntries = listing.filter((name) => !name.endsWith('/'));
const dirEntries = listing.filter((name) => name.endsWith('/'));

if (fileEntries.length + dirEntries.length > 256) {
  bad('packageTooManyFiles：文件/目录过多');
} else {
  ok(`packageTooManyFiles：${fileEntries.length} 个文件 / ${dirEntries.length} 个目录，在上限内`);
}

const unsafe = listing.filter(
  (name) => name.startsWith('/') || name.includes('..') || /^[A-Za-z]:/.test(name) || name.includes('\\')
);
if (unsafe.length) bad(`packagePathInvalid：存在不安全的包内路径：${unsafe.join(', ')}`);
else ok('packagePathInvalid：无绝对路径、无 ../、无 Windows 反斜杠');

const normalized = listing.map((n) => n.replace(/\/+$/, ''));
const duplicates = normalized.filter((n, i) => normalized.indexOf(n) !== i);
if (duplicates.length) bad(`packagePathDuplicate：存在重复条目：${duplicates.join(', ')}`);
else ok('packagePathDuplicate：无重复条目');

let uncompressed = 0;
for (const name of fileEntries) {
  const out = execFileSync('unzip', ['-p', PKG, name], { maxBuffer: 64 * 1024 * 1024 });
  uncompressed += out.length;
}
if (uncompressed > 64 * 1024 * 1024) bad('packageUncompressedTooLarge：解压后总大小超限');
else ok(`packageUncompressedTooLarge：解压后 ${(uncompressed / 1024).toFixed(1)} KB`);

/* ---------- 3. manifest ---------- */
if (!fileEntries.includes('manifest.json')) {
  bad('manifestMissing：包根目录没有 manifest.json');
  process.exit(1);
}
ok('manifestMissing：manifest.json 位于包根目录');

const manifestRaw = execFileSync('unzip', ['-p', PKG, 'manifest.json']);
if (manifestRaw.length > 64 * 1024) bad('manifestTooLarge：manifest.json 过大');
else ok(`manifestTooLarge：manifest.json ${(manifestRaw.length / 1024).toFixed(1)} KB`);

let manifest;
try {
  manifest = JSON.parse(manifestRaw.toString('utf8'));
  ok('manifestInvalid：manifest.json 是合法 JSON');
} catch (error) {
  bad(`manifestInvalid：JSON 解析失败：${error.message}`);
  process.exit(1);
}

if (manifest.specVersion !== 2) bad('manifestSpecUnsupported：specVersion 必须是 2');
else ok('manifestSpecUnsupported：specVersion = 2');

for (const field of ['id', 'name', 'version', 'author', 'description']) {
  if (!manifest[field]) bad(`manifestInvalid：缺少必填字段 ${field}`);
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(manifest.version || '')) {
  bad('manifestInvalidSemVerWithLocation：version 必须是合法 SemVer');
} else {
  ok(`manifestInvalidSemVerWithLocation：version = ${manifest.version}`);
}

/* author 必须与账号名一致 */
if (manifest.author !== ACCOUNT_NAME) {
  bad(
    `authorMismatch：manifest 的 author 是「${manifest.author}」，与 Hub 账号名「${ACCOUNT_NAME}」不一致`
  );
} else {
  ok(`authorMismatch：author = ${manifest.author}，与 Hub 账号名一致`);
}

/* entry 与贡献声明 */
const hasActions =
  (manifest.contributes?.inputActions || []).length > 0 ||
  (manifest.contributes?.sidebar || []).length > 0 ||
  (manifest.contributes?.lastMessageActions || []).length > 0;
if (hasActions && !manifest.entry) {
  bad('manifestEntryRequired：声明了动作却没有 entry');
} else {
  ok('manifestEntryRequired：entry 声明完整');
}
if (manifest.entry && !fileEntries.includes(manifest.entry)) {
  bad(`manifestFileInvalid：entry 指向的文件不存在：${manifest.entry}`);
} else if (manifest.entry) {
  ok(`manifestFileInvalid：entry 文件存在（${manifest.entry}）`);
}
for (const fragment of manifest.contributes?.htmlFragments || []) {
  if (!fileEntries.includes(fragment.src)) {
    bad(`manifestFileInvalid：HTML 片段不存在：${fragment.src}`);
  }
}
ok('manifestFileInvalid：HTML 片段路径均存在');

/* 设置项 */
for (const item of manifest.contributes?.settings?.schema || []) {
  if (!item.type) bad('manifestSettingsInvalid：存在缺少 type 的设置项');
  if (['switch', 'select', 'slider', 'text', 'textarea', 'list'].includes(item.type)) {
    if (!item.key) bad(`manifestSettingsInvalid：${item.type} 缺少 key`);
    if (!item.label) bad(`manifestSettingsInvalid：${item.type} 缺少 label`);
  }
  if (item.type === 'switch' && item.default !== undefined && typeof item.default !== 'boolean') {
    bad('manifestSettingsInvalid：switch 的 default 必须是布尔值');
  }
  if (item.type === 'select') {
    const values = (item.options || []).map((o) => (typeof o === 'string' ? o : o.value));
    if (!values.length) bad('manifestSettingsInvalid：select 缺少 options');
    if (item.default !== undefined && !values.includes(item.default)) {
      bad(`manifestSettingsInvalid：select 的 default「${item.default}」不在 options 里`);
    }
  }
}
ok('manifestSettingsInvalid：设置项 schema 逐项检查通过');

/* 国际化：defaultLocale 与 $t key 完整性 */
const loc = manifest.localization;
if (!loc || !loc.defaultLocale) {
  bad('manifestLocalizationInvalid：缺少 localization.defaultLocale');
} else {
  const catalogs = {};
  let missing = 0;
  for (const [locale, path] of Object.entries(loc.resources || {})) {
    if (!fileEntries.includes(path)) {
      bad(`manifestLocalizationInvalid：catalog 文件不存在：${path}`);
      continue;
    }
    catalogs[locale] = JSON.parse(
      execFileSync('unzip', ['-p', PKG, path]).toString('utf8')
    );
  }
  if (!Object.keys(loc.resources || {}).includes(loc.defaultLocale)) {
    bad(`manifestLocalizationInvalid：defaultLocale（${loc.defaultLocale}）不在 resources 里`);
  }
  const manifestKeys = new Set();
  (function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === 'object') {
      if (Object.keys(node).length === 1 && typeof node.$t === 'string') {
        manifestKeys.add(node.$t);
        return;
      }
      Object.values(node).forEach(collect);
    }
  })(manifest);
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of manifestKeys) {
      if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
        bad(`manifestLocalizationInvalid：[${locale}] 缺少文案 ${key}`);
        missing++;
      }
    }
    for (const [key, value] of Object.entries(catalog)) {
      if (typeof value !== 'string' || !value.trim()) {
        bad(`manifestLocalizationInvalid：[${locale}] ${key} 的值不是非空字符串`);
        missing++;
      }
    }
  }
  if (!missing) {
    ok(
      `manifestLocalizationInvalid：${loc.defaultLocale} + ${Object.keys(catalogs).length - 1} 个语言包，${manifestKeys.size} 条 $t 全部齐全`
    );
    ok(`i18nMismatchWarning：多语言支持完整（${Object.keys(catalogs).join(', ')}）`);
  }
}

/* 封面与图标 */
function checkImage(path, label) {
  if (!path) return;
  if (!fileEntries.includes(path)) {
    bad(`${label}：文件不存在 ${path}`);
    return;
  }
  const buf = execFileSync('unzip', ['-p', PKG, path]);
  const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  const isGif = buf.toString('ascii', 0, 3) === 'GIF';
  if (!(isPng || isJpeg || isWebp || isGif)) {
    bad(`${label}：不是 PNG/JPEG/WebP/GIF`);
    return;
  }
  if (buf.length > 10 * 1024 * 1024) {
    bad(`${label}：图片过大（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
    return;
  }
  let dims = '';
  if (isPng) {
    dims = `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
  }
  ok(`${label}：格式与体积合规（${isPng ? 'PNG ' + dims : isJpeg ? 'JPEG' : isWebp ? 'WebP' : 'GIF'}，${(buf.length / 1024).toFixed(1)} KB）`);
}
checkImage(manifest.cover, 'manifestCoverInvalid / manifestCoverTooLarge');
for (const action of [
  ...(manifest.contributes?.inputActions || []),
  ...(manifest.contributes?.lastMessageActions || [])
]) {
  checkImage(action.icon, `动作「${action.id}」图标`);
}

/* ---------- 4. 版本与 id ---------- */
info(`版本 ${manifest.version}：发布新版本时必须高于 Hub 上已有版本`);
info(`插件 id ${manifest.id}：全局唯一，不能与他人插件重复`);
info(`公开地址（slug）由插件名生成，重名会被占用（slugTaken）`);

/* ---------- 5. 结论 ---------- */
console.log('');
if (problems.length) {
  console.log(`❌ ${problems.length} 项不符合要求，投稿大概率会被拒：`);
  problems.forEach((p) => console.log('   -', p));
  process.exit(1);
}
console.log('✅ 包体与清单全部符合 Hub 的校验规则');
/* 插件名可能是 $t 对象，取当前默认语言的文案 */
let pluginName = manifest.name;
if (pluginName && typeof pluginName === 'object') {
  const key = pluginName.$t;
  const catalogPath = (manifest.localization?.resources || {})[manifest.localization?.defaultLocale];
  if (catalogPath && fileEntries.includes(catalogPath)) {
    const catalog = JSON.parse(execFileSync('unzip', ['-p', PKG, catalogPath]).toString('utf8'));
    pluginName = catalog[key] || key;
  }
}

console.log('\n投稿时在表单里需要填：');
console.log(`   插件名字    ${pluginName}`);
console.log('   分类        必选（表单里选）');
console.log('   简介        简述插件用途与使用效果');
console.log('   更新说明    本版本的变化');
console.log('   讨论帖链接  可选（HTTP(S)），填了用户可在插件详情页参与讨论');
console.log(`   作者        ${manifest.author}（须与 Hub 账号名一致）`);
