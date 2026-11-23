/**
 * 差异算法性能基准
 *
 *   node scripts/bench-diff.mjs
 *
 * 用插件里的同一套 diff 代码（core.js 暴露的 api.diff）跑 1 万字文本，
 * 覆盖三种改动强度，外加单行长文本这一病态场景。
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://tavo.local/',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
dom.window.tavo = {
  plugin: { i18n: { t: (k) => k }, config: { get: () => null } },
  variable: { get: () => Promise.resolve(null) }
};
dom.window.eval(readFileSync(resolve(ROOT, 'ui/js/core.js'), 'utf8'));
const diff = dom.window.__dialogTune__.diff;

/* ---------------- 造数据 ---------------- */

const WORDS = [
  '夜色', '灯火', '长街', '风声', '旧信', '站台', '雨伞', '咖啡', '少年', '远方',
  '星辰', '海浪', '旧书', '旅人', '月光', '心事', '归途', '黎明', '屋檐', '春风'
];

function makeText(chars, lineLength = 50) {
  let out = '';
  let seed = 20261123;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  while (out.length < chars) {
    const sentence = WORDS[Math.floor(rand() * WORDS.length)] +
      WORDS[Math.floor(rand() * WORDS.length)] + '。';
    out += sentence;
    if (lineLength && out.length % lineLength < sentence.length) out += '\n';
  }
  return out.slice(0, chars);
}

function editFew(text) {
  // 少量修改：10 处，每处改 2 个字
  const chars = [...text];
  for (let i = 0; i < 10; i++) {
    const at = Math.floor((chars.length / 11) * (i + 1));
    chars[at] = '甲';
    chars[at + 1] = '乙';
  }
  return chars.join('');
}

function editMany(text) {
  // 大量修改：约 40% 的字被替换
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    if (i % 5 < 2 && chars[i] !== '\n') chars[i] = '改';
  }
  return chars.join('');
}

function editAll(text) {
  // 全部不同
  return makeText(text.length).replace(/[^\n]/g, '全');
}

function makeOneLine(chars) {
  return makeText(chars, 0).replace(/\n/g, '');
}

/* ---------------- 跑基准 ---------------- */

function measure(label, before, after) {
  const before2 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const segments = diff(before, after);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const adds = segments.filter((s) => s.type === 'add').length;
  const dels = segments.filter((s) => s.type === 'del').length;
  const equalChars = segments
    .filter((s) => s.type === 'equal')
    .reduce((sum, s) => sum + s.text.length, 0);
  const memMB = (process.memoryUsage().heapUsed - before2) / 1024 / 1024;

  /* 再量一次「把差异渲染成 DOM」的耗时——这才是真机上的开销 */
  const host = dom.window.document.createElement('div');
  const r0 = process.hrtime.bigint();
  for (const segment of segments) {
    if (segment.type === 'equal') {
      host.appendChild(dom.window.document.createTextNode(segment.text));
    } else {
      const span = dom.window.document.createElement('span');
      span.className = segment.type === 'add' ? 'dt-diff__add' : 'dt-diff__del';
      span.textContent = segment.text;
      host.appendChild(span);
    }
  }
  const r1 = process.hrtime.bigint();
  const renderMs = Number(r1 - r0) / 1e6;
  const nodes = host.childNodes.length;

  console.log(
    `  ${label.padEnd(22)} 计算 ${ms.toFixed(1).padStart(7)} ms  渲染 ${renderMs.toFixed(1).padStart(6)} ms   ` +
      `分段 ${String(segments.length).padStart(5)}（+${adds}/-${dels}）  ` +
      `DOM ${String(nodes).padStart(5)}  公共 ${String(equalChars).padStart(6)} 字`
  );
  return { label, ms, renderMs, segments: segments.length };
}

console.log('\n差异算法性能基准（1 万字）\n');

const base = makeText(10000);
const baseOneLine = makeOneLine(10000);
console.log(`原文：${base.length} 字，${base.split('\n').length} 行；单行变体 ${baseOneLine.length} 字`);

console.log('\n多行文本：');
const results = [];
results.push(measure('少量修改（10 处）', base, editFew(base)));
results.push(measure('大量修改（约 40%）', base, editMany(base)));
results.push(measure('全部不同', base, editAll(base)));

console.log('\n单行长文本（最坏情况，无法逐行对齐）：');
results.push(measure('少量修改（10 处）', baseOneLine, editFew(baseOneLine)));
results.push(measure('大量修改（约 40%）', baseOneLine, editMany(baseOneLine)));
results.push(measure('全部不同', baseOneLine, editAll(baseOneLine)));

const worst = results.reduce((a, b) => (b.ms > a.ms ? b : a));
const worstRender = results.reduce((a, b) => (b.renderMs > a.renderMs ? b : a));
console.log(`\n最慢计算：${worst.label} ${worst.ms.toFixed(1)} ms`);
console.log(`最慢渲染：${worstRender.label} ${worstRender.renderMs.toFixed(1)} ms`);
