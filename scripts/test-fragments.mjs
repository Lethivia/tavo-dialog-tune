/**
 * 片段集成测试：加载真实的 panel.html / message.html 与三个脚本
 *
 * 模拟真实拓扑：插件片段是「宿主页面」里的 iframe，
 * 通过 window.frameElement.ownerDocument 拿到宿主页面文档与窗口。
 *
 * 覆盖：同文档、跨 iframe（共享宿主页）、禁用同源广播、宿主缺席、
 *       entry 的两个原生入口、插件被关闭。
 *
 * 用法：node scripts/test-fragments.mjs
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeTavo, createBroadcastChannelFactory } from './fake-tavo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'locales/zh-CN.json'), 'utf8'));

let failures = 0;
function assert(condition, label, extra = '') {
  if (condition) console.log('  ✓', label);
  else {
    failures++;
    console.log('  ✗', label, extra);
  }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 直接加载一个脚本文件（entry.js 不是 HTML 片段，没有 <script> 标签） */
function loadScript(window, relativePath) {
  const code = readFileSync(resolve(ROOT, relativePath), 'utf8');
  try {
    window.eval(code);
  } catch (error) {
    throw new Error(`加载 ${relativePath} 失败：${error.message}`);
  }
}

/** 把片段的 HTML 主体塞进文档（去掉 script/link，脚本由 loadFragmentScripts 加载） */
function injectBody(window, htmlPath) {
  const html = readFileSync(resolve(ROOT, htmlPath), 'utf8');
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '');
  window.document.body.insertAdjacentHTML('beforeend', body);
}

/** 按 HTML 里的 <script src> 顺序加载对应的本地脚本 */
function loadFragmentScripts(window, htmlPath) {
  const html = readFileSync(resolve(ROOT, htmlPath), 'utf8');
  const sources = [
    ...html.matchAll(/<script src="\/plugins\/[^"]+\/ui\/([^"]+)"><\/script>/g)
  ].map((m) => m[1]);
  for (const src of sources) {
    const code = readFileSync(resolve(ROOT, 'ui', src), 'utf8');
    try {
      window.eval(code);
    } catch (error) {
      throw new Error(`加载 ${src} 失败：${error.message}`);
    }
  }
  return sources;
}

/** 宿主页面：插件片段是它的 iframe */
function makePage() {
  return new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavo.local/app',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
}

function makeWindow(fake, BroadcastChannel, page) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavo.local/chat',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  dom.window.tavo = fake.tavo;
  /* jsdom 没有 BroadcastChannel，换成跨文档共享的等价实现 */
  dom.window.BroadcastChannel = BroadcastChannel || createBroadcastChannelFactory();
  if (page) {
    Object.defineProperty(dom.window, 'frameElement', {
      configurable: true,
      value: { ownerDocument: page.window.document }
    });
  }
  dom.window.addEventListener('error', (event) => {
    console.log('    [未捕获异常]', event.error && event.error.message);
  });
  return dom.window;
}

console.log('\n对话微调 · 片段集成测试\n');

/* ================= A. 同文档 ================= */
console.log('A. 同文档：消息片段与聊天页片段共享 document');
{
  const fake = createFakeTavo(catalog);
  const window = makeWindow(fake);
  injectBody(window, 'ui/message.html');
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/message.html');
  loadFragmentScripts(window, 'ui/panel.html');
  await tick(20);

  const api = window.__dialogTune__;
  assert(!!api, '核心脚本已加载');
  assert(api.isHost() === true, '聊天页片段认领了面板宿主');

  const btn = window.document.querySelector('[data-dt-action="tune"]');
  assert(!!btn, '行内微调按钮已渲染');
  assert(window.document.querySelector('#dt-message-root').hidden === false, '按钮所在容器可见');

  btn.click();
  await tick(30);
  const sheet = window.document.querySelector('.dt-sheet-root');
  assert(!!sheet && !sheet.hidden, '点击后弹出面板');
  assert(
    window.document.querySelector('.dt-sheet__subtitle').textContent.includes('角色'),
    '面板目标正确指向角色消息'
  );
}

/* ================= B. 跨 iframe，共享宿主页面 ================= */
console.log('\nB. 跨 iframe：面板挂在宿主页面上（社区插件的通行做法）');
{
  const fake = createFakeTavo(catalog);
  const page = makePage();
  const BC = createBroadcastChannelFactory();

  const hostWindow = makeWindow(fake, BC, page);
  const messageWindow = makeWindow(fake, BC, page);

  injectBody(hostWindow, 'ui/panel.html');
  loadFragmentScripts(hostWindow, 'ui/panel.html');
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  const hostApi = hostWindow.__dialogTune__;
  const messageApi = messageWindow.__dialogTune__;
  assert(hostApi.isHost() === true, '聊天页侧是宿主');
  assert(messageApi.isHost() === false, '消息侧不是宿主');

  const btn = messageWindow.document.querySelector('[data-dt-action="tune"]');
  assert(!!btn, '消息侧行内按钮已渲染');
  btn.click();
  await tick(150);

  const pageSheet = page.window.document.querySelector('.dt-sheet-root');
  assert(!!pageSheet && !pageSheet.hidden, '面板弹在宿主页面文档里');
  assert(
    pageSheet && pageSheet.parentNode === page.window.document.body,
    '面板挂在宿主页面的 body 下（fixed 相对整屏视口）'
  );
  assert(
    messageWindow.document.querySelector('.dt-sheet-root') === null,
    '消息侧没有另建一份面板'
  );
  assert(
    pageSheet.classList.contains('dt-sheet-root--inline') === false,
    '不是内联降级模式'
  );
}

/* ================= C. 禁用同源广播 ================= */
console.log('\nC. 禁用同源广播：靠宿主页面事件仍然可用');
{
  const fake = createFakeTavo(catalog);
  const page = makePage();

  const hostWindow = makeWindow(fake, undefined, page);
  const messageWindow = makeWindow(fake, undefined, page);
  hostWindow.BroadcastChannel = undefined;
  messageWindow.BroadcastChannel = undefined;

  injectBody(hostWindow, 'ui/panel.html');
  loadFragmentScripts(hostWindow, 'ui/panel.html');
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  messageWindow.document.querySelector('[data-dt-action="tune"]').click();
  await tick(150);
  const pageSheet = page.window.document.querySelector('.dt-sheet-root');
  assert(!!pageSheet && !pageSheet.hidden, '没有同源广播时，宿主页面事件仍然送达宿主');

  /* 再等过兜底窗口，确认不会又弹一个 */
  await tick(600);
  assert(
    page.window.document.querySelectorAll('.dt-sheet-root').length === 1,
    '只有一个面板（不会重复打开）'
  );
}

/* ================= D. 宿主缺席：给出明确提示 ================= */
console.log('\nD. 宿主缺席：明确提示而不是无声无息');
{
  const fake = createFakeTavo(catalog);
  const page = makePage();
  const messageWindow = makeWindow(fake, createBroadcastChannelFactory(), page);
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  messageWindow.document.querySelector('[data-dt-action="tune"]').click();
  await tick(900);
  assert(fake.store.toasts.length > 0, '宿主缺席时给出了提示');
  assert(
    page.window.document.querySelector('.dt-sheet-root') === null,
    '宿主缺席时不会凭空弹出面板'
  );
}

/* ================= E. entry.js 的原生入口 ================= */
console.log('\nE. entry.js：输入框 + 菜单入口（右上角菜单不再有入口）');
{
  const fake = createFakeTavo(catalog);
  const page = makePage();
  const window = makeWindow(fake, createBroadcastChannelFactory(), page);
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/panel.html');
  loadScript(window, 'entry.js');
  await tick(20);

  assert(fake.registered().includes('inputActions:dialog-tune'), 'entry 注册了输入框动作');
  assert(
    !fake.registered().includes('sidebar:dialog-tune'),
    '不再注册侧边栏动作（右上角菜单里不显示入口）'
  );

  fake.store.draft = '我今天有点累';
  fake.fire('inputActions:dialog-tune');
  await tick(60);
  const sheet = page.window.document.querySelector('.dt-sheet-root');
  assert(!!sheet && !sheet.hidden, '输入框「+」菜单的入口能打开面板');

  const api = window.__dialogTune__;
  api.close();
  await tick(20);
}

/* ================= F. 插件被关闭时要有明确反馈 ================= */
console.log('\nF. 插件关闭时不静默');
{
  const fake = createFakeTavo(catalog);
  fake.CONFIG.enabled = false;
  const page = makePage();
  const window = makeWindow(fake, createBroadcastChannelFactory(), page);
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/panel.html');
  loadScript(window, 'entry.js');
  await tick(20);

  fake.store.draft = '我今天有点累';
  fake.fire('inputActions:dialog-tune');
  await tick(1000);
  assert(fake.store.toasts.length > 0, '插件关闭时给出了明确提示，而不是点了没反应');
  const closedSheet = page.window.document.querySelector('.dt-sheet-root');
  assert(!closedSheet || closedSheet.hidden === true, '插件关闭时不会打开面板');
}

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
