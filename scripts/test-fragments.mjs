/**
 * 片段集成测试：加载真实的 panel.html / message.html 与三个脚本
 *
 * 覆盖两种拓扑：
 *   A. 同文档 —— 消息片段与聊天页片段共享一个 document；
 *   B. 跨文档 —— 消息片段在另一个 document（模拟 iframe），面板必须由
 *      聊天页宿主渲染，不能被限制在消息侧。
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

/** 按 HTML 里的 <script src> 顺序加载对应的本地脚本 */
function loadFragmentScripts(window, htmlPath) {
  const html = readFileSync(resolve(ROOT, htmlPath), 'utf8');
  const sources = [...html.matchAll(/<script src="\/plugins\/[^"]+\/ui\/([^"]+)"><\/script>/g)].map((m) => m[1]);
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

async function api_close(window) {
  const api = window.__dialogTune__;
  if (api && api.close) api.close();
  await tick(10);
}

function makeWindow(fake, BroadcastChannel) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://tavo.local/chat',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  dom.window.tavo = fake.tavo;
  /* jsdom 没有 BroadcastChannel，换成跨文档共享的等价实现 */
  dom.window.BroadcastChannel = BroadcastChannel || createBroadcastChannelFactory();
  /* 收集未捕获异常，真实宿主里这类异常会被静默吞掉 */
  dom.window.addEventListener('error', (event) => {
    console.log('    [未捕获异常]', event.error && event.error.message);
  });
  return dom.window;
}

/* 把片段的 HTML 主体塞进文档（去掉 script 标签，脚本由 loadFragmentScripts 加载） */
function injectBody(window, htmlPath) {
  const html = readFileSync(resolve(ROOT, htmlPath), 'utf8');
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
  window.document.body.insertAdjacentHTML('beforeend', body);
}

console.log('\n对话微调 · 片段集成测试\n');

/* ================= A. 同文档 ================= */
console.log('A. 同文档：消息片段与聊天页片段共享 document');
{
  const fake = createFakeTavo(catalog);
  const window = makeWindow(fake, createBroadcastChannelFactory());
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
    sheet && sheet.parentNode === window.document.body,
    '面板挂在页面 body 下（fixed 相对视口，不会被气泡容器限制）'
  );
  assert(
    window.document.querySelector('.dt-sheet__subtitle').textContent.includes('角色'),
    '面板目标正确指向角色消息'
  );
}

/* ================= B. 跨文档 ================= */
console.log('\nB. 跨文档：消息片段在另一个 document（模拟 iframe）');
{
  const fake = createFakeTavo(catalog);
  const BC = createBroadcastChannelFactory();
  const hostWindow = makeWindow(fake, BC);
  injectBody(hostWindow, 'ui/panel.html');
  loadFragmentScripts(hostWindow, 'ui/panel.html');
  await tick(20);

  const messageWindow = makeWindow(fake, BC);
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
  await tick(60);

  assert(
    fake.store.variables['chat:dialog_tune_request'],
    '请求已写入聊天作用域信箱'
  );
  await tick(500);

  const hostSheet = hostWindow.document.querySelector('.dt-sheet-root');
  assert(!!hostSheet && !hostSheet.hidden, '宿主侧弹出了面板');
  assert(
    hostSheet && hostSheet.parentNode === hostWindow.document.body,
    '面板由宿主文档承载，位置不受消息侧容器影响'
  );
  assert(
    messageWindow.document.querySelector('.dt-sheet-root').hidden,
    '消息侧没有就地渲染面板'
  );
}

/* ================= C. action bar / 输入框 + 菜单 ================= */
console.log('\nC. entry 的两个原生入口');
{
  const fake = createFakeTavo(catalog);
  const window = makeWindow(fake, createBroadcastChannelFactory());
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/panel.html');
  await tick(20);

  /* entry.js 用插件事件总线通知面板 */
  const api = window.__dialogTune__;
  fake.store.draft = '我今天有点累';
  await api.open({ kind: 'input' });
  await tick(20);
  assert(
    window.document.querySelector('.dt-sheet-root') &&
      !window.document.querySelector('.dt-sheet-root').hidden,
    '通过插件事件总线可以打开面板（action bar / + 菜单走这条路）'
  );
}

/* ================= D. 没有宿主时的降级 ================= */
console.log('\nD. 没有宿主：降级为就地展开，保证点击一定有反应');
{
  const fake = createFakeTavo(catalog);
  const messageWindow = makeWindow(fake, createBroadcastChannelFactory());
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  const btn = messageWindow.document.querySelector('[data-dt-action="tune"]');
  btn.click();
  await tick(60);
  assert(
    messageWindow.document.querySelector('.dt-sheet-root').hidden,
    '刚点击时先等待宿主响应'
  );

  await tick(400);
  const sheet = messageWindow.document.querySelector('.dt-sheet-root');
  assert(sheet && !sheet.hidden, '宿主缺席时本地兜底打开面板');
  assert(
    sheet && sheet.classList.contains('dt-sheet-root--inline'),
    '兜底模式为就地展开（iframe 会随内容变高，而不是裁成一条）'
  );
  const anchor = messageWindow.document.querySelector('#dt-message-root');
  assert(
    sheet && sheet.parentNode === anchor,
    '兜底面板插入在触发它的消息下方'
  );
}

/* ================= E. 兄弟 iframe 借共同父窗口中转 ================= */
console.log('\nE. 兄弟 iframe：借共同父窗口中转（真实拓扑）');
{
  const fake = createFakeTavo(catalog);
  const BC = createBroadcastChannelFactory();

  /* 造一个「页面窗口」，它把收到的 message 派发给所有监听者 */
  const pageListeners = [];
  const page = {
    addEventListener(type, handler) {
      if (type === 'message') pageListeners.push(handler);
    },
    removeEventListener(type, handler) {
      const index = pageListeners.indexOf(handler);
      if (index >= 0) pageListeners.splice(index, 1);
    },
    dispatch(data, source) {
      pageListeners.forEach((handler) => handler({ data, source, type: 'message' }));
    }
  };

  const hostWindow = makeWindow(fake, BC);
  const messageWindow = makeWindow(fake, BC);

  /* 两个片段是并列的兄弟 iframe，共享同一个父窗口 */
  function attachParent(target) {
    Object.defineProperty(target, 'parent', {
      configurable: true,
      value: {
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        postMessage(data) {
          page.dispatch(data, target);
        }
      }
    });
  }
  attachParent(hostWindow);
  attachParent(messageWindow);

  injectBody(hostWindow, 'ui/panel.html');
  loadFragmentScripts(hostWindow, 'ui/panel.html');
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  messageWindow.document.querySelector('[data-dt-action="tune"]').click();
  await tick(120);

  const hostSheet = hostWindow.document.querySelector('.dt-sheet-root');
  assert(!!hostSheet && !hostSheet.hidden, '宿主通过父窗口中转收到请求并打开面板');
  assert(
    hostSheet && hostSheet.parentNode === hostWindow.document.body,
    '面板由宿主文档承载（聊天页底部），不是消息内联'
  );
  assert(
    !hostSheet.classList.contains('dt-sheet-root--inline'),
    '不是降级的内联模式'
  );
  assert(
    messageWindow.document.querySelector('.dt-sheet-root').hidden,
    '消息侧没有重复打开面板'
  );
}

/* ================= F. 没有同源广播时，父窗口中转必须独立可用 ================= */
console.log('\nF. 禁用同源广播：父窗口中转独立可用');
{
  const fake = createFakeTavo(catalog);
  const pageListeners = [];
  const page = {
    addEventListener(type, handler) {
      if (type === 'message') pageListeners.push(handler);
    },
    removeEventListener(type, handler) {
      const index = pageListeners.indexOf(handler);
      if (index >= 0) pageListeners.splice(index, 1);
    },
    dispatch(data, source) {
      pageListeners.forEach((handler) => handler({ data, source, type: 'message' }));
    }
  };

  const hostWindow = makeWindow(fake);
  const messageWindow = makeWindow(fake);
  /* 真机上同源广播不一定连通，这里显式关掉它 */
  hostWindow.BroadcastChannel = undefined;
  messageWindow.BroadcastChannel = undefined;

  function attachParent(target) {
    Object.defineProperty(target, 'parent', {
      configurable: true,
      value: {
        addEventListener: page.addEventListener.bind(page),
        removeEventListener: page.removeEventListener.bind(page),
        postMessage(data) {
          page.dispatch(data, target);
        }
      }
    });
  }
  attachParent(hostWindow);
  attachParent(messageWindow);

  injectBody(hostWindow, 'ui/panel.html');
  loadFragmentScripts(hostWindow, 'ui/panel.html');
  injectBody(messageWindow, 'ui/message.html');
  loadFragmentScripts(messageWindow, 'ui/message.html');
  await tick(20);

  messageWindow.document.querySelector('[data-dt-action="tune"]').click();
  await tick(150);
  const hostSheet = hostWindow.document.querySelector('.dt-sheet-root');
  assert(!!hostSheet && !hostSheet.hidden, '没有广播时，父窗口中转仍然送达宿主');

  /* 再等过 350ms 兜底窗口，确认消息侧没有又展开一个面板 */
  await tick(500);
  assert(
    messageWindow.document.querySelector('.dt-sheet-root').hidden,
    '收到回执后消息侧没有再就地展开（不会出现两个面板）'
  );
}

/* ================= G. entry.js 的两个原生入口 ================= */
console.log('\nG. entry.js：输入框 + 菜单与最后一条消息 action bar');
{
  const fake = createFakeTavo(catalog);
  const window = makeWindow(fake, createBroadcastChannelFactory());
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/panel.html');
  loadScript(window, 'entry.js');
  await tick(20);

  assert(fake.registered().includes('inputActions:dialog-tune'), 'entry 注册了输入框动作');
  assert(
    fake.registered().includes('lastMessageActions:dialog-tune-last'),
    'entry 注册了最后一条消息动作'
  );

  fake.store.draft = '我今天有点累';
  fake.fire('inputActions:dialog-tune');
  await tick(60);
  const sheet = window.document.querySelector('.dt-sheet-root');
  assert(!!sheet && !sheet.hidden, '输入框「+」菜单的入口能打开面板');

  await api_close(window);
  fake.fire('lastMessageActions:dialog-tune-last', { chatId: 1, messageId: 2, role: 'assistant' });
  await tick(60);
  assert(
    !window.document.querySelector('.dt-sheet-root').hidden,
    '最后一条消息 action bar 的入口能打开面板'
  );
  assert(
    window.document.querySelector('.dt-sheet__subtitle').textContent.includes('角色'),
    'action bar 入口的目标是那条消息'
  );
}

/* ================= H. 插件被关闭时要有明确反馈 ================= */
console.log('\nH. 插件关闭时不静默');
{
  const fake = createFakeTavo(catalog);
  fake.CONFIG.enabled = false;
  const window = makeWindow(fake, createBroadcastChannelFactory());
  injectBody(window, 'ui/panel.html');
  loadFragmentScripts(window, 'ui/panel.html');
  loadScript(window, 'entry.js');
  await tick(20);

  fake.store.draft = '我今天有点累';
  fake.fire('inputActions:dialog-tune');
  await tick(1000);
  assert(
    fake.store.toasts.length > 0,
    '插件关闭时给出了明确提示，而不是点了没反应'
  );
  assert(
    window.document.querySelector('.dt-sheet-root').hidden,
    '插件关闭时不会打开面板'
  );
}

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);
