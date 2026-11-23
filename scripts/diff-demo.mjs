/**
 * 差异算法独立验证脚本
 *
 *   node scripts/diff-demo.mjs "原文" "改后"
 *
 * 直接调用插件里的同一套差异代码（core.js 暴露的 api.diff），
 * 不依赖 jsdom，可以单独把玩、核对结果。
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

const cases = [
  ['今天天气不错', '今天天气很好'],
  ['Hello world', 'Hello there'],
  ['第一行\n第二行', '第一行\n第二行改'],
  ['完全一样', '完全一样'],
  ['abc', 'axc']
];

for (const [before, after] of cases) {
  const segments = diff(before, after);
  console.log(`\n「${before}」 → 「${after}」`);
  if (!segments.length) {
    console.log('  （无差异）');
    continue;
  }
  for (const segment of segments) {
    const mark = segment.type === 'add' ? '+' : segment.type === 'del' ? '-' : ' ';
    console.log(`  ${mark} ${JSON.stringify(segment.text)}`);
  }
}
