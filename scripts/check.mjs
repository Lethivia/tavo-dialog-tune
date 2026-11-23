/**
 * 静态一致性检查
 *
 *   1. manifest.json 字段合法性（id / semver / 文案长度上限 / 路径）
 *   2. manifest 与 JS 里引用的每一个 $t key，都必须存在于全部 catalog
 *   3. catalog 必须是扁平字符串 map，且值非空
 *   4. manifest 引用的文件（entry / cover / icon / html fragment / locales）必须存在
 *   5. JS 里的插件 ID、包内资源路径必须与 manifest 一致
 *
 * 用法：node scripts/check.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

/* ---------------- 读取 ---------------- */

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const catalogs = {};
for (const [locale, path] of Object.entries(manifest.localization?.resources || {})) {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) {
    fail(`catalog 文件不存在：${path}`);
    continue;
  }
  catalogs[locale] = JSON.parse(readFileSync(full, 'utf8'));
}

/* ---------------- 1. manifest 字段 ---------------- */

if (manifest.specVersion !== 2) fail('specVersion 应为 2');
if (!/^[a-z0-9._-]+$/.test(manifest.id || '')) fail(`id 不合法：${manifest.id}`);
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(manifest.version || '')) fail(`version 不是合法 SemVer：${manifest.version}`);
if (!manifest.author || manifest.author.length > 32) fail('author 必须是 1–32 个字符');
if (!manifest.entry) fail('缺少 entry');
if (manifest.entry && !existsSync(resolve(ROOT, manifest.entry))) fail(`entry 不存在：${manifest.entry}`);
if (manifest.cover && !existsSync(resolve(ROOT, manifest.cover))) fail(`cover 不存在：${manifest.cover}`);
if (!manifest.localization?.defaultLocale) fail('缺少 localization.defaultLocale');

for (const [locale, path] of Object.entries(manifest.localization?.resources || {})) {
  if (!existsSync(resolve(ROOT, path))) fail(`locale 资源不存在：${path}（${locale}）`);
}

for (const fragment of manifest.contributes?.htmlFragments || []) {
  if (!existsSync(resolve(ROOT, fragment.src))) fail(`HTML 片段不存在：${fragment.src}`);
  if (!fragment.mount || !fragment.mount.startsWith('/')) fail(`片段 mount 非法：${fragment.mount}`);
}
for (const action of [
  ...(manifest.contributes?.inputActions || []),
  ...(manifest.contributes?.lastMessageActions || [])
]) {
  if (action.icon && !existsSync(resolve(ROOT, action.icon))) fail(`动作图标不存在：${action.icon}`);
}
for (const permission of manifest.permissions || []) {
  const allowed = ['input', 'message', 'generate', 'variable', 'file', 'network', 'tts'];
  if (!allowed.includes(permission)) notes.push(`权限「${permission}」不在文档列出的常见清单中，请确认是否必要`);
}

/* ---------------- 2. 收集所有 $t key ---------------- */

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

/* ---------------- 3. 收集 JS 里使用的 key ---------------- */

const jsKeys = new Set();
function walkJs(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkJs(full);
      continue;
    }
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(full, 'utf8');
    const pattern = /\bt\(\s*'([^']+)'/g;
    let match;
    while ((match = pattern.exec(source)) !== null) jsKeys.add(match[1]);
  }
}
walkJs(resolve(ROOT, 'ui/js'));
walkJs(resolve(ROOT, 'ui'));
{
  const source = readFileSync(resolve(ROOT, 'entry.js'), 'utf8');
  const pattern = /i18n\.t\(\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) jsKeys.add(match[1]);
}

/* ---------------- 4. 校验 catalog ---------------- */

const locales = Object.keys(catalogs);
if (!locales.includes('en')) fail('至少要提供 en catalog');
for (const [locale, catalog] of Object.entries(catalogs)) {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string') fail(`[${locale}] ${key} 的值必须是字符串`);
    if (!value.trim()) fail(`[${locale}] ${key} 的值不能为空`);
  }
  for (const key of [...manifestKeys, ...jsKeys]) {
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
      fail(`[${locale}] 缺少文案：${key}`);
    }
  }
}
for (const key of [...manifestKeys, ...jsKeys]) {
  if (!locales.some((locale) => Object.prototype.hasOwnProperty.call(catalogs[locale], key))) {
    fail(`所有 catalog 都缺少文案：${key}`);
  }
}

/* ---------------- 5. 插件 ID 与资源路径一致 ---------------- */

const coreSource = readFileSync(resolve(ROOT, 'ui/js/core.js'), 'utf8');
const idMatch = coreSource.match(/var PLUGIN_ID = '([^']+)'/);
if (!idMatch) fail('core.js 里找不到 PLUGIN_ID');
else if (idMatch[1] !== manifest.id) fail(`core.js 的 PLUGIN_ID（${idMatch[1]}）与 manifest.id（${manifest.id}）不一致`);

for (const file of ['ui/panel.html', 'ui/message.html']) {
  const html = readFileSync(resolve(ROOT, file), 'utf8');
  for (const url of html.match(/\/plugins\/[^"' ]+/g) || []) {
    if (!url.startsWith(`/plugins/${manifest.id}/`)) {
      fail(`${file} 里的资源路径与插件 ID 不一致：${url}`);
    }
    const rel = url.replace(`/plugins/${manifest.id}/`, '');
    if (!existsSync(resolve(ROOT, rel))) fail(`${file} 引用的资源不存在：${rel}`);
  }
}

/* ---------------- 6. 文案长度上限 ---------------- */

function measure(value) {
  return [...String(value)].length;
}
for (const action of manifest.contributes?.inputActions || []) {
  const label = action.label?.$t ? catalogs[manifest.localization.defaultLocale]?.[action.label.$t] : action.label;
  if (label && measure(label) > 48) fail(`输入动作文案超过 48 字符：${label}`);
}
for (const action of manifest.contributes?.lastMessageActions || []) {
  const label = action.label?.$t ? catalogs[manifest.localization.defaultLocale]?.[action.label.$t] : action.label;
  if (label && measure(label) > 48) fail(`消息动作文案超过 48 字符：${label}`);
}
const pluginName = catalogs[manifest.localization.defaultLocale]?.[manifest.name?.$t];
if (pluginName && measure(pluginName) > 64) fail('插件名称超过 64 字符');
const description = catalogs[manifest.localization.defaultLocale]?.[manifest.description?.$t];
if (description && measure(description) > 10000) fail('插件描述超过 10000 字符');
if (description && measure(description) < 120) notes.push('插件描述偏短，插件列表只展示前 120 个字符，建议写满一段完整说明');

/* ---------------- 输出 ---------------- */

for (const note of notes) console.log('⚠️ ', note);
if (problems.length) {
  console.error('\n❌ 检查未通过：');
  problems.forEach((problem) => console.error('  -', problem));
  process.exit(1);
}
console.log(
  `✅ 检查通过：manifest 合法，${manifestKeys.size + jsKeys.size} 条文案在 ${locales.length} 个语言包中齐全，资源路径一致。`
);
