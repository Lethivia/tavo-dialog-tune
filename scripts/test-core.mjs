/**
 * 冒烟测试：用 jsdom 跑真实的插件 DOM 流程
 *
 * 覆盖：打开面板 → 组装提示词 → 生成 → 差异预览 → 重新生成 → 应用为消息版本
 *       长按浮标 → 开关记忆（全局变量）
 *
 * 用法：node scripts/test-core.mjs
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'locales/zh-CN.json'), 'utf8'));

let failures = 0;
function assert(condition, label, extra = '') {
  if (condition) {
    console.log('  ✓', label);
  } else {
    failures++;
    console.log('  ✗', label, extra);
  }
}

/* ---------------- 假 Tavo 宿主 ---------------- */

const store = {
  messages: [
    { id: 1, role: 'user', content: '在吗' },
    { id: 2, role: 'assistant', content: '我在呢，今天想聊点什么？' },
    { id: 3, role: 'user', content: '讲个笑话' }
  ],
  draft: '',
  generated: [],
  variantCalls: [],
  variables: {},
  toasts: [],
  appended: []
};

const CONFIG = {
  enabled: true,
  showInlineButton: true,
  longPressBehavior: 'pill',
  defaultUseMemory: false,
  defaultRecentN: 0,
  maxRecentN: 50,
  timeoutSeconds: 60,
  autoApply: false,
  contentLanguage: 'source',
  guidePrompt: 'GUIDE_PROMPT_MARKER'
};

const listeners = {};

const tavo = {
  plugin: {
    i18n: {
      requestedLocale: 'zh-CN',
      locale: 'zh-CN',
      defaultLocale: 'zh-CN',
      supportedLocales: ['zh-CN', 'en'],
      t(key, params) {
        let text = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      },
      onChange() {
        return () => {};
      }
    },
    config: {
      get(key) {
        return Object.prototype.hasOwnProperty.call(CONFIG, key) ? CONFIG[key] : null;
      },
      all() {
        return { ...CONFIG };
      }
    },
    on(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
      return () => {};
    },
    emit(type, data) {
      (listeners[type] || []).forEach((handler) => handler(data));
      return Promise.resolve();
    }
  },
  message: {
    get(id) {
      return Promise.resolve(store.messages.find((m) => m.id === id) || null);
    },
    current() {
      return Promise.resolve(store.messages[1]);
    },
    find(range, filter = {}) {
      let list = store.messages.slice();
      if (filter.role) list = list.filter((m) => m.role === filter.role);
      if (filter.hidden === false) list = list.filter((m) => m.hidden !== true);
      if (typeof range === 'number') return Promise.resolve(list.slice(range, range + 1));
      if (Array.isArray(range)) {
        const start = range[0] < 0 ? Math.max(0, list.length + range[0]) : range[0];
        const end = range[1] < 0 ? list.length + range[1] : range[1];
        if (range.length === 1) return Promise.resolve(list.slice(start));
        return Promise.resolve(list.slice(start, end + 1));
      }
      return Promise.resolve(list);
    },
    update(payload) {
      const target = store.messages.find((m) => m.id === payload.id);
      if (target) target.content = payload.content;
      return Promise.resolve(payload.id);
    },
    append(payload) {
      store.appended.push(payload);
      return Promise.resolve(99);
    },
    variant: {
      create(messageId, data, options) {
        store.variantCalls.push({ messageId, data, options });
        return Promise.resolve(42);
      },
      list() {
        return Promise.resolve([]);
      },
      select() {
        return Promise.resolve(7);
      }
    }
  },
  input: {
    get() {
      return Promise.resolve(store.draft);
    },
    set(text) {
      store.draft = text;
      return Promise.resolve();
    }
  },
  generate(prompt, options) {
    store.generated.push({ prompt, options });
    const n = store.generated.length;
    return Promise.resolve(`我在这儿，今天想聊点${n === 1 ? '什么' : '别的'}？`);
  },
  variable: {
    get(name, scope = 'chat') {
      return Promise.resolve(store.variables[`${scope}:${name}`]);
    },
    set(name, value, scope = 'chat') {
      store.variables[`${scope}:${name}`] = value;
      return Promise.resolve();
    }
  },
  memory: {
    current() {
      return Promise.resolve({ id: 1, enabled: true, memories: ['用户喜欢简洁的回答'] });
    }
  },
  utils: {
    toast(message) {
      store.toasts.push(message);
    }
  },
  ui: {
    getInsets() {
      return { topSafe: 10, topBar: 56, bottomInput: 80, bottomSafe: 20 };
    },
    onInsetsChanged() {
      return () => {};
    }
  }
};

/* ---------------- 启动 jsdom ---------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://tavo.local/chat',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
window.tavo = tavo;
window.eval(readFileSync(resolve(ROOT, 'ui/js/core.js'), 'utf8'));

const api = window.__dialogTune__;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function byText(node, selector, text) {
  return Array.from(node.querySelectorAll(selector)).find((n) => n.textContent.includes(text));
}

console.log('\n对话微调 · 冒烟测试\n');

/* 1. 打开面板 */
console.log('1. 打开微调面板');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
const sheet = window.document.querySelector('.dt-sheet-root');
assert(!!sheet, '面板已挂载');
assert(sheet && !sheet.hidden, '面板默认可见');
assert(
  window.document.querySelector('.dt-sheet__subtitle').textContent.includes('角色'),
  '副标题标明目标角色'
);
assert(window.document.querySelector('.dt-textarea') !== null, '存在微调要求输入框');

/* 2. 组装提示词并生成 */
console.log('\n2. 组装上下文并调用当前聊天 API');
const textarea = window.document.querySelector('.dt-textarea');
textarea.value = '把语气改得更自然一点';
const confirmBtn = byText(window.document, '.dt-primary-btn', '生成微调');
assert(!!confirmBtn, '存在「生成微调」按钮');
confirmBtn.click();
await tick(30);

assert(store.generated.length === 1, '调用了一次生成 API');
const prompt = store.generated[0].prompt;
assert(prompt.includes('GUIDE_PROMPT_MARKER'), '提示词包含设置页的引导提示词');
assert(prompt.includes('我在呢，今天想聊点什么？'), '提示词包含原文全文');
assert(prompt.includes('把语气改得更自然一点'), '提示词包含玩家的微调要求');
assert(!prompt.includes('讲个笑话'), '默认不包含最近对话（N=0）');
assert(store.generated[0].options.context === false, '不自动附带对话上下文');

/* 3. 预览与差异高亮 */
console.log('\n3. 生成结果预览');
const tuned = window.document.querySelector('.dt-diff__body--tuned');
assert(!!tuned && tuned.textContent.length > 0, '预览展示微调后的正文');
assert(
  window.document.querySelectorAll('.dt-diff__add, .dt-diff__del').length > 0,
  '差异部分有高亮标记'
);
assert(
  window.document.querySelectorAll('.dt-diff__block').length === 1,
  '只展示改写后的正文，不再并列原文'
);
assert(
  window.document.querySelector('.dt-diff__body--tuned') !== null,
  '改写后的正文带有差异高亮容器'
);

/* 4. 重新生成并保留历次结果 */
console.log('\n4. 重新生成（reroll）');
const rerollBtn = byText(window.document, '.dt-ghost-btn', '重新生成');
assert(!!rerollBtn, '存在「重新生成」按钮');
rerollBtn.click();
await tick(30);
assert(store.generated.length === 2, 'reroll 再次调用了生成 API');
assert(store.generated[1].prompt === prompt, 'reroll 使用完全相同的上下文');
assert(window.document.querySelectorAll('.dt-chip').length === 2, '保留了两个历次结果可切换');

/* 5. 应用为消息版本 */
console.log('\n5. 应用结果');
const applyBtn = byText(window.document, '.dt-primary-btn', '应用到消息');
assert(!!applyBtn, '存在「应用到消息」按钮');
applyBtn.click();
await tick(20);
assert(store.variantCalls.length === 1, '调用了 variant.create');
assert(store.variantCalls[0].messageId === 2, '写入的是被微调的那条消息');
assert(store.variantCalls[0].options.select === true, '新版本被设为当前版本（可原生切回）');
assert(
  store.variantCalls[0].data.content === '我在这儿，今天想聊点别的？',
  '写入的是选中的那次生成结果'
);
assert(window.document.querySelector('.dt-sheet-root').hidden, '应用后面板自动收起');

/* 6. 开关记忆 */
console.log('\n6. 记住玩家的开关调整');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
const memorySwitch = window.document.querySelector('.dt-switch');
memorySwitch.click();
await tick(10);
assert(
  store.variables['global:dialog_tune_prefs'] &&
    store.variables['global:dialog_tune_prefs'].useMemory === true,
  '长记忆开关状态被写入全局变量'
);

await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
assert(
  window.document.querySelector('.dt-switch').getAttribute('aria-checked') === 'true',
  '下次打开时恢复上一次的开关状态'
);

/* 7. 长按浮标 */
console.log('\n7. 长按浮出「微调」按钮');
const bubble = window.document.createElement('div');
bubble.textContent = '我在呢，今天想聊点什么？';
window.document.body.appendChild(bubble);
api.registerMessage({ id: 2, role: 'assistant', content: '我在呢，今天想聊点什么？', el: bubble });

function pointerDown(target) {
  const event = new window.MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  target.dispatchEvent(event);
}
pointerDown(bubble);
await tick(600);
const pill = window.document.querySelector('.dt-pill');
assert(!!pill, '长按后浮出浮标');
assert(
  pill && pill.textContent.includes('对话微调'),
  '浮标内含「微调」按钮'
);
pill.querySelector('.dt-pill__btn').click();
await tick(20);
assert(!window.document.querySelector('.dt-sheet-root').hidden, '点击浮标后打开面板');

/* 8. 输入框草稿目标 */
console.log('\n8. 微调输入框草稿');
store.draft = '我今天有点累';
await api.open({ kind: 'input' });
await tick(10);
assert(
  window.document.querySelector('.dt-sheet__subtitle').textContent.includes('我的输入'),
  '目标是「我的输入」'
);
window.document.querySelector('.dt-textarea').value = '更委婉一点';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
assert(store.generated[store.generated.length - 1].prompt.includes('我今天有点累'), '提示词包含草稿内容');
const fillBtn = byText(window.document, '.dt-primary-btn', '填回输入框');
assert(!!fillBtn, '草稿目标提供「填回输入框」');
fillBtn.click();
await tick(20);
assert(store.draft.length > 0, '结果已填回输入框');

/* 9. 切换开关不会清空已输入的指令 */
console.log('\n9. 切换上下文开关不打断输入');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
const typed = '把结尾改短一点';
window.document.querySelector('.dt-textarea').value = typed;
window.document.querySelector('.dt-switch').click();
await tick(10);
assert(
  window.document.querySelector('.dt-textarea').value === typed,
  '切开关后玩家已输入的指令仍然保留'
);

/* 10. 生成失败时保持原文 */
console.log('\n10. 生成失败不写入任何内容');
const originalGenerate = tavo.generate;
tavo.generate = () => Promise.reject(new Error('模型不可用'));
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-textarea').value = '随便改改';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
assert(store.variantCalls.length === 1, '失败时没有新增任何版本写入');
assert(
  window.document.querySelector('.dt-note.is-error') !== null &&
    window.document.querySelector('.dt-note.is-error').textContent.includes('模型不可用'),
  '面板内显示失败原因'
);
tavo.generate = originalGenerate;

/* 11. 底部主按钮与下拉菜单 */
console.log('\n11. 主按钮与下拉菜单');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-textarea').value = '换个说法';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
const caret = window.document.querySelector('.dt-split__toggle');
assert(!!caret, '存在下拉触发按钮');
caret.click();
await tick(5);
const menu = window.document.querySelector('.dt-menu');
assert(menu && !menu.hidden, '下拉菜单已展开');
const menuLabels = Array.from(menu.querySelectorAll('.dt-menu__item')).map((n) => n.textContent);
assert(menuLabels.some((l) => l.includes('作为新消息')), '菜单里收进了「作为新消息」');
assert(menuLabels.some((l) => l.includes('复制')), '菜单里收进了「复制」');
assert(
  window.document.querySelectorAll('.dt-sheet__foot .dt-primary-btn').length === 2,
  '底部只剩主按钮与下拉触发器，不再挤一排按钮'
);
const appendItem = Array.from(menu.querySelectorAll('.dt-menu__item')).find((n) =>
  n.textContent.includes('作为新消息')
);
appendItem.click();
await tick(20);
assert(store.appended.length === 1, '菜单里的「作为新消息」生效');

/* 12. 生成中的加载动画 */
console.log('\n12. 生成中显示加载动画');
let resolveGenerate;
tavo.generate = () => new Promise((resolve) => { resolveGenerate = resolve; });
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-textarea').value = '再改改';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(10);
assert(window.document.querySelector('.dt-spinner') !== null, '生成中按钮出现加载圈');
assert(
  byText(window.document, '.dt-primary-btn', '生成中').textContent.includes('生成中'),
  '生成中按钮文案切换为「生成中…」'
);
resolveGenerate('我在这儿，今天想聊点什么？');
await tick(30);
assert(window.document.querySelector('.dt-spinner') === null, '生成结束后加载圈消失');

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);