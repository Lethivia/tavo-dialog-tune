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
if (!manifest.name) fail('manifest.name 必填');
if (!manifest.localization?.defaultLocale) {
  fail('缺少 localization.defaultLocale（specVersion 2 必填）');
} else {
  const resources = Object.keys(manifest.localization?.resources || {});
  if (!resources.includes(manifest.localization.defaultLocale)) {
    fail(
      `localization.defaultLocale（${manifest.localization.defaultLocale}）必须出现在 resources 里`
    );
  }
}

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
  if (!allowed.includes(permission)) {
    notes.push(
      `权限「${permission}」不在文档列出的清单里，但已上架插件（如 tavo-memory-curator）在用，` +
        `且本插件确实调用了对应的 API，保留`
    );
  }
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
    const pattern = /\bt\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      /* 以 . 结尾的是运行时拼接的前缀（如 'runtime.thinking.family.' + key），跳过 */
      if (match[1].endsWith('.')) continue;
      jsKeys.add(match[1]);
    }
  }
}
walkJs(resolve(ROOT, 'ui/js'));
walkJs(resolve(ROOT, 'ui'));
{
  const source = readFileSync(resolve(ROOT, 'entry.js'), 'utf8');
  const pattern = /i18n\.t\(\s*['"]([^'"]+)['"]/g;
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

/* ---------------- 5.5 manifest schema 逐字段校验 ---------------- */

/** 文档中列出的根字段 */
const ALLOWED_ROOT = new Set([
  'specVersion', 'id', 'name', 'version', 'entry', 'author', 'description',
  'releaseNotes', 'localization', 'cover', 'minAppVersion', 'permissions', 'contributes'
]);

/** 文档中列出的 contributes 字段 */
const ALLOWED_CONTRIBUTES = new Set([
  'inputActions', 'sidebar', 'lastMessageActions', 'htmlFragments',
  'settings', 'visible', 'fileProcessors'
]);

const ALLOWED_ACTION_FIELDS = new Set(['id', 'label', 'icon']);
const ALLOWED_LAST_MESSAGE_FIELDS = new Set(['id', 'label', 'icon', 'role']);
const ALLOWED_FRAGMENT_FIELDS = new Set(['id', 'src', 'mount']);
const ALLOWED_VISIBLE_KEYS = new Set(['inputActions', 'sidebar', 'lastMessageActions', 'chat', 'messages']);

/** 文档列出的挂载点枚举（封闭集合，不能自由拼装） */
const ALLOWED_CHAT_MOUNTS = new Set([
  '/chat',
  '/chat/head/start',
  '/chat/head/end',
  '/chat/body/start',
  '/chat/body/end'
]);
const ALLOWED_MESSAGE_MOUNTS = new Set([
  '/messages/start',
  '/messages/end',
  '/messages/start?role=user',
  '/messages/end?role=character',
  '/messages/end?position=last',
  '/messages/end?role=character&position=last'
]);

/** 设置项类型 → 允许的字段（when 为所有类型通用） */
const SETTINGS_FIELDS = {
  switch: new Set(['type', 'key', 'label', 'default', 'description', 'when']),
  select: new Set(['type', 'key', 'label', 'default', 'description', 'options', 'when']),
  slider: new Set(['type', 'key', 'label', 'min', 'max', 'step', 'default', 'description', 'when']),
  text: new Set(['type', 'key', 'label', 'default', 'description', 'placeholder', 'when']),
  textarea: new Set(['type', 'key', 'label', 'default', 'description', 'placeholder', 'minLines', 'maxLines', 'when']),
  list: new Set(['type', 'key', 'label', 'items', 'default', 'description', 'fixed', 'min', 'max', 'sortable', 'when']),
  header: new Set(['type', 'label', 'when']),
  info: new Set(['type', 'text', 'icon', 'when']),
  divider: new Set(['type', 'when']),
  break: new Set(['type', 'when'])
};

for (const key of Object.keys(manifest)) {
  if (!ALLOWED_ROOT.has(key)) fail(`manifest 出现文档未列出的根字段：${key}`);
}

const contributes = manifest.contributes || {};
for (const key of Object.keys(contributes)) {
  if (!ALLOWED_CONTRIBUTES.has(key)) fail(`contributes 出现文档未列出的字段：${key}`);
}

for (const [index, action] of (contributes.inputActions || []).entries()) {
  for (const key of Object.keys(action)) {
    if (!ALLOWED_ACTION_FIELDS.has(key)) fail(`inputActions[${index}] 出现未列出的字段：${key}`);
  }
  if (!action.id) fail(`inputActions[${index}] 缺少 id`);
  if (!action.label) fail(`inputActions[${index}] 缺少 label`);
}

for (const [index, action] of (contributes.lastMessageActions || []).entries()) {
  for (const key of Object.keys(action)) {
    if (!ALLOWED_LAST_MESSAGE_FIELDS.has(key)) fail(`lastMessageActions[${index}] 出现未列出的字段：${key}`);
  }
  if (!action.id) fail(`lastMessageActions[${index}] 缺少 id`);
  if (!action.label) fail(`lastMessageActions[${index}] 缺少 label`);
  if (!action.icon) fail(`lastMessageActions[${index}] 缺少 icon（文档标注为必填）`);
  if (action.role && !['character', 'user', 'any'].includes(action.role)) {
    fail(`lastMessageActions[${index}] 的 role 只能是 character / user / any`);
  }
}

const fragmentIds = new Set();
for (const [index, fragment] of (contributes.htmlFragments || []).entries()) {
  if (fragment.id) {
    if (fragmentIds.has(fragment.id)) fail(`htmlFragments 的 id 重复：${fragment.id}`);
    fragmentIds.add(fragment.id);
  }
  for (const key of Object.keys(fragment)) {
    if (!ALLOWED_FRAGMENT_FIELDS.has(key)) fail(`htmlFragments[${index}] 出现未列出的字段：${key}`);
  }
  if (!fragment.id) fail(`htmlFragments[${index}] 缺少 id`);
  if (!fragment.src) fail(`htmlFragments[${index}] 缺少 src`);
  if (!fragment.mount) {
    fail(`htmlFragments[${index}] 缺少 mount`);
  } else {
    const mount = fragment.mount;
    const allowed =
      mount.startsWith('/chat') ? ALLOWED_CHAT_MOUNTS : ALLOWED_MESSAGE_MOUNTS;
    if (!allowed.has(mount)) {
      fail(
        `htmlFragments[${index}] 的 mount 不在文档列出的挂载点里：${mount}\n` +
          `       聊天页可用：${[...ALLOWED_CHAT_MOUNTS].join(' ')}\n` +
          `       消息可用：${[...ALLOWED_MESSAGE_MOUNTS].join(' ')}`
      );
    }
  }
}

for (const key of Object.keys(contributes.visible || {})) {
  if (!ALLOWED_VISIBLE_KEYS.has(key)) fail(`contributes.visible 出现未列出的位置：${key}`);
}

const schema = contributes.settings?.schema || [];
if (!Array.isArray(schema)) fail('contributes.settings.schema 必须是数组');
const seenKeys = new Set();
schema.forEach((item, index) => {
  const type = item.type;
  if (!type) {
    fail(`settings.schema[${index}] 缺少 type`);
    return;
  }
  const allowed = SETTINGS_FIELDS[type];
  if (!allowed) {
    fail(`settings.schema[${index}] 使用了未知的设置类型：${type}`);
    return;
  }
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) fail(`settings.schema[${index}]（${type}）出现未列出的字段：${key}`);
  }
  if (['switch', 'select', 'slider', 'text', 'textarea', 'list'].includes(type)) {
    if (!item.key) fail(`settings.schema[${index}]（${type}）缺少 key`);
    if (!item.label) fail(`settings.schema[${index}]（${type}）缺少 label`);
    if (seenKeys.has(item.key)) fail(`设置项 key 重复：${item.key}`);
    seenKeys.add(item.key);
  }
  if (type === 'slider') {
    if (typeof item.min !== 'number' || typeof item.max !== 'number' || item.max <= item.min) {
      fail(`settings.schema[${index}]（slider）的 min/max 不合法`);
    }
    if (item.step !== undefined && !(item.step > 0)) fail(`settings.schema[${index}]（slider）的 step 必须大于 0`);
  }
  if (type === 'textarea') {
    const min = item.minLines === undefined ? 2 : item.minLines;
    const max = item.maxLines === undefined ? 10 : item.maxLines;
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      fail(`settings.schema[${index}]（textarea）的 minLines/maxLines 不合法`);
    }
  }
  if (type === 'select') {
    if (!Array.isArray(item.options) || !item.options.length) {
      fail(`settings.schema[${index}]（select）缺少 options`);
    } else {
      const values = new Set();
      item.options.forEach((option) => {
        const value = typeof option === 'string' ? option : option.value;
        if (value === undefined) fail(`settings.schema[${index}]（select）存在没有 value 的选项`);
        if (values.has(value)) fail(`settings.schema[${index}]（select）选项 value 重复：${value}`);
        values.add(value);
      });
      if (item.default !== undefined && !values.has(item.default)) {
        fail(
          `settings.schema[${index}]（select）的 default「${item.default}」不在 options 里`
        );
      }
    }
  }
  if (type === 'switch' && item.default !== undefined && typeof item.default !== 'boolean') {
    fail(`settings.schema[${index}]（switch）的 default 必须是布尔值`);
  }
});

/* ---------------- 6. 图片资源格式 ---------------- */

/** 读取 PNG 尺寸；不是 PNG 返回 null */
function pngSize(path) {
  const buffer = readFileSync(path);
  const isPng =
    buffer.length > 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  if (!isPng) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isWebp(path) {
  const buffer = readFileSync(path);
  return (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

function checkImage(path, label) {
  if (!existsSync(path)) {
    fail(`${label} 不存在：${path}`);
    return;
  }
  const size = pngSize(path);
  if (size) {
    if (size.width > 512 || size.height > 512) {
      fail(`${label} 尺寸超过 512×512：${size.width}×${size.height}`);
    }
    if (size.width !== size.height) {
      notes.push(`${label} 不是正方形（${size.width}×${size.height}），官方插件中心的封面为 512×512`);
    }
    return;
  }
  if (isWebp(path)) return;
  fail(`${label} 不是合法的 PNG/WebP（插件动作图标只接受这两种格式）：${path}`);
}

if (manifest.cover) {
  checkImage(resolve(ROOT, manifest.cover), '封面');
}
for (const action of [
  ...(manifest.contributes?.inputActions || []),
  ...(manifest.contributes?.lastMessageActions || [])
]) {
  if (action.icon) checkImage(resolve(ROOT, action.icon), `动作「${action.id}」图标`);
}

/* ---------------- 6.5 多语言一致性 ----------------
   插件中心的自动审核会检查两种语言的占位符、链接目标、Markdown 标记是否一致
   （规则 I18N_PLACEHOLDER_MISMATCH / I18N_FIXED_TOKEN_MISMATCH /
   I18N_MARKUP_MISMATCH），不一致会被判 warn。 */

function placeholdersOf(text) {
  const found = new Set();
  const pattern = /\{([a-zA-Z0-9_.]+)\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  return found;
}

function urlsOf(text) {
  return (String(text).match(/https?:\/\/[^\s"')\]<>]+/g) || []).sort();
}

function markupOf(text) {
  const links = (String(text).match(/\[[^\]]*\]\([^)]*\)/g) || []).map((l) =>
    l.replace(/\[[^\]]*\]/, '[]')
  );
  const tags = (String(text).match(/<\/?[a-zA-Z][^>]*>/g) || []).sort();
  return { links: links.sort(), tags };
}

{
  const locales = Object.keys(catalogs);
  const base = locales[0];
  for (const locale of locales.slice(1)) {
    for (const key of Object.keys(catalogs[base])) {
      if (!Object.prototype.hasOwnProperty.call(catalogs[locale], key)) continue;
      const a = catalogs[base][key];
      const b = catalogs[locale][key];
      const pa = placeholdersOf(a);
      const pb = placeholdersOf(b);
      if (pa.size !== pb.size || [...pa].some((p) => !pb.has(p))) {
        fail(
          `多语言占位符不一致（${base} vs ${locale}）：${key} → ${base} {${[...pa].join(',')}} / ${locale} {${[...pb].join(',')}}`
        );
      }
      const ua = urlsOf(a);
      const ub = urlsOf(b);
      if (ua.join('|') !== ub.join('|')) {
        fail(`多语言链接不一致（${base} vs ${locale}）：${key}`);
      }
      const ma = markupOf(a);
      const mb = markupOf(b);
      if (ma.links.join('|') !== mb.links.join('|')) {
        fail(`多语言 Markdown 链接目标不一致（${base} vs ${locale}）：${key}`);
      }
      if (ma.tags.join('|') !== mb.tags.join('|')) {
        fail(`多语言 HTML 标记不一致（${base} vs ${locale}）：${key}`);
      }
    }
  }
  if (!problems.length) {
    notes.push(`多语言一致性：${locales.join(' / ')} 的占位符、链接与标记全部一致`);
  }
}

/* ---------------- 7. 文案长度上限 ---------------- */

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
