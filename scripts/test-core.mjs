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
import { createFakeTavo } from './fake-tavo.mjs';

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

/* ---------------- 假 Tavo 宿主（与片段测试共用同一份） ---------------- */

const { tavo, store } = createFakeTavo(catalog);

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

/* 7. 面板宿主与跨上下文请求 */
console.log('\n7. 面板宿主与跨上下文请求');
await api.close();
assert(api.isHost() === false, '默认不是宿主（消息片段所在文档）');
api.requestOpen({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(20);
assert(
  store.variables['chat:dialog_tune_request'] &&
    store.variables['chat:dialog_tune_request'].messageId === 2,
  '非宿主的请求写进聊天作用域信箱'
);
assert(
  window.document.querySelector('.dt-sheet-root').hidden,
  '非宿主不会就地渲染面板（避免被限制在气泡容器里）'
);
api.claimHost();
api.handleRequest(store.variables['chat:dialog_tune_request']);
await tick(20);
assert(
  !window.document.querySelector('.dt-sheet-root').hidden,
  '宿主接手请求后打开面板'
);
await api.close();

/* 7.5 生成后仍可修改微调要求 */
console.log('\n7.5 生成后仍可修改微调要求');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
const instructionField = window.document.querySelector('.dt-textarea');
instructionField.value = '第一版要求';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
assert(instructionField.disabled === false, '生成结束后指令框可编辑');
assert(
  store.generated[store.generated.length - 1].prompt.includes('第一版要求'),
  '首次生成使用了这条指令'
);
instructionField.value = '第二版要求';
instructionField.dispatchEvent(new window.Event('input', { bubbles: true }));
const before = store.generated.length;
byText(window.document, '.dt-ghost-btn', '重新生成').click();
await tick(30);
assert(store.generated.length === before + 1, '重新生成只调用一次生成接口');
assert(
  store.generated[store.generated.length - 1].prompt.includes('第二版要求'),
  '重新生成使用了改过的指令'
);

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
const realGenerateForSpinner = tavo.generate;
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
tavo.generate = realGenerateForSpinner;

/* 13. 数字框失焦后「生成微调」按钮不能被换掉 */
console.log('\n13. 调整条数后首次点击不丢');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
const confirmNode = byText(window.document, '.dt-primary-btn', '生成微调');
const numberField = window.document.querySelector('.dt-stepper__input');
numberField.value = '3';
numberField.dispatchEvent(new window.Event('change', { bubbles: true }));
numberField.dispatchEvent(new window.Event('blur', { bubbles: true }));
await tick(10);
assert(confirmNode.isConnected, '失焦后「生成微调」按钮节点仍在文档里（没被重建）');
const currentConfirm = byText(window.document, '.dt-primary-btn', '生成微调');
assert(currentConfirm === confirmNode, '失焦后按钮没有被替换成新节点');
window.document.querySelector('.dt-textarea').value = '改一改';
const callsBefore = store.generated.length;
currentConfirm.click();
await tick(30);
assert(store.generated.length === callsBefore + 1, '点一次就真的发起了一次生成');

/* 14. 生成期间切换目标，结果不写进新目标 */
console.log('\n14. 生成期间切换目标不串写');
let resolveFirst;
const realGenerate = tavo.generate;
tavo.generate = () => new Promise((resolve) => { resolveFirst = resolve; });
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-textarea').value = '改一改';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(10);
await api.open({ kind: 'message', messageId: 3, role: 'user' });
await tick(10);
resolveFirst('生成结果');
await tick(30);
assert(
  window.document.querySelector('.dt-stage--preview').hidden === true,
  '上一次生成结果没有进入新目标的预览'
);
assert(
  window.document.querySelector('.dt-sheet__subtitle').textContent.includes('我的'),
  '面板已经切到新的目标'
);
assert(
  store.toasts.some((msg) => msg.includes('切换了目标')),
  '给出了「目标已切换」的提示，而不是静默丢弃'
);
tavo.generate = realGenerate;

/* 15. 候选版本不可用时退化为直接覆盖 */
console.log('\n15. 没有候选版本能力时直接覆盖');
store.variantResult = null;
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-textarea').value = '改一改';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
const variantCallsBefore = store.variantCalls.length;
byText(window.document, '.dt-primary-btn', '应用到消息').click();
await tick(30);
assert(
  store.variantCalls.length === variantCallsBefore + 1,
  '仍然尝试了写候选版本'
);
assert(
  store.toasts.some((msg) => msg.includes('没有版本记录')),
  '提示了「该楼层没有版本记录」'
);
store.variantResult = undefined;

/* 16. 最近 N 条取的是被微调消息之前的对话 */
console.log('\n16. 最近 N 条对话取的是目标之前的消息');
await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(10);
window.document.querySelector('.dt-switch').click();          // 打开长记忆
const stepper = window.document.querySelector('.dt-stepper__input');
stepper.value = '2';
stepper.dispatchEvent(new window.Event('change', { bubbles: true }));
stepper.dispatchEvent(new window.Event('blur', { bubbles: true }));
await tick(10);
window.document.querySelector('.dt-textarea').value = '改一改';
byText(window.document, '.dt-primary-btn', '生成微调').click();
await tick(30);
const lastPrompt = store.generated[store.generated.length - 1].prompt;
assert(lastPrompt.includes('长记忆') || lastPrompt.includes('memory'), '提示词里带上了长记忆');
assert(lastPrompt.includes('在吗'), '最近对话里包含目标之前的那条消息');
assert(
  !lastPrompt.includes('讲个笑话'),
  '最近对话不包含目标之后的消息'
);

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);