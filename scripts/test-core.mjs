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
let received = null;
const onRequest = (event) => { received = event.detail; };
window.addEventListener('dialog-tune-request', onRequest);
api.requestOpen({ kind: 'message', messageId: 2, role: 'assistant' });
await tick(20);
window.removeEventListener('dialog-tune-request', onRequest);
assert(!!received, '请求通过宿主页面窗口的 CustomEvent 发出');
assert(received && received.messageId === 2, '请求里带着目标消息 id');
const sheetBefore = window.document.querySelector('.dt-sheet-root');
assert(
  !sheetBefore || sheetBefore.hidden === true,
  '非宿主不会自己打开面板（面板由宿主统一承载）'
);
api.claimHost();
api.handleRequest(received);
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

/* 17. 差异算法：长文本、无差异、以及样式契约 */
console.log('\n17. 差异算法与样式');
{
  /* 17.1 长文本（超过旧的长度上限）也要能标出差异 */
  const longSource = '这是一段很长的测试文本。'.repeat(200);      // ≈ 2200 字
  const longTuned = longSource.replace('测试文本', '验收文本');
  store.messages.push({ id: 90, role: 'assistant', content: longSource });
  await api.open({ kind: 'message', messageId: 90, role: 'assistant' });
  await tick(10);
  window.document.querySelector('.dt-textarea').value = '改一下';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  /* 让假模型返回带差异的长文本 */
  const originalGenerate = tavo.generate;
  tavo.generate = () => Promise.resolve(longTuned);
  byText(window.document, '.dt-ghost-btn', '重新生成').click();
  await tick(40);
  const longAdds = window.document.querySelectorAll('.dt-diff__add');
  const longDels = window.document.querySelectorAll('.dt-diff__del');
  assert(longAdds.length > 0, '超长文本也能标出新增');
  assert(longDels.length > 0, '超长文本也能标出删除');
  tavo.generate = originalGenerate;

  /* 17.2 内容完全相同时，明确显示「与原文一致」而不是空白 */
  store.messages.push({ id: 91, role: 'assistant', content: '一模一样的内容' });
  await api.open({ kind: 'message', messageId: 91, role: 'assistant' });
  await tick(10);
  window.document.querySelector('.dt-textarea').value = '改一下';
  const gen2 = tavo.generate;
  tavo.generate = () => Promise.resolve('一模一样的内容');
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(40);
  assert(
    window.document.querySelectorAll('.dt-diff__add').length === 0,
    '内容相同时不产生高亮'
  );
  const stat = window.document.querySelector('.dt-diff__stat');
  assert(!!stat && stat.textContent.length > 0, '显示差异统计');
  assert(
    !!stat && stat.textContent.includes('一致'),
    '内容相同时明确提示「与原文完全一致」'
  );
  tavo.generate = gen2;

  /* 17.3 样式契约：CSS 里必须有高亮规则，否则改了类名就静默失效 */
  const css = readFileSync(resolve(ROOT, 'ui/css/panel.css'), 'utf8');
  assert(css.includes('.dt-diff__add'), '样式表里有新增高亮规则');
  assert(css.includes('.dt-diff__del'), '样式表里有删除高亮规则');
}

/* 18. 差异算法的精确行为：用手算期望值锁死 */
console.log('\n18. 差异算法的精确行为');
{
  const diff = api.diff;
  const show = (before, after) =>
    diff(before, after).map((s) => s.type + ':' + JSON.stringify(s.text)).join(' | ');

  assert(
    show('今天天气不错', '今天天气很好') ===
      'equal:"今天天气" | del:"不错" | add:"很好"',
    '中文：按字对齐，公共部分保留、替换部分整体标出',
    show('今天天气不错', '今天天气很好')
  );
  assert(
    show('Hello world', 'Hello there') === 'equal:"Hello " | del:"world" | add:"there"',
    '英文：按词对齐（不切开单词内部）',
    show('Hello world', 'Hello there')
  );
  /* 相邻同类段会被合并，所以是「第一行\n第二行」一段 + 新增「改」 */
  const expectedMultiline = [
    { type: 'equal', text: '第一行\n第二行' },
    { type: 'add', text: '改' }
  ];
  assert(
    JSON.stringify(diff('第一行\n第二行', '第一行\n第二行改')) ===
      JSON.stringify(expectedMultiline),
    '多行：逐行对齐后再逐字细化',
    show('第一行\n第二行', '第一行\n第二行改')
  );
  assert(
    diff('完全一样', '完全一样').length === 1 &&
      diff('完全一样', '完全一样')[0].type === 'equal',
    '完全相同返回一段 equal（预览区不会空白）'
  );
  assert(
    diff('', '新增内容').length === 1 && diff('', '新增内容')[0].type === 'add',
    '空原文时全部算新增'
  );
  assert(
    diff('原有内容', '').length === 1 && diff('原有内容', '')[0].type === 'del',
    '空结果时全部算删除'
  );

  /* 最小编辑性质：替换一段时，add/del 各只有一段 */
  const segments = diff('这是一段完整的话', '这是一段改过的话');
  const adds = segments.filter((s) => s.type === 'add');
  const dels = segments.filter((s) => s.type === 'del');
  assert(adds.length === 1 && dels.length === 1, '改动一处只产生一对 add/del');
  assert(
    segments.filter((s) => s.type === 'equal').map((s) => s.text).join('') ===
      '这是一段的话',
    '公共部分被完整保留（前后两段都算公共）',
    JSON.stringify(segments)
  );
}

/* 19. 段落级增删改的差异表现（用户提出的场景） */
console.log('\n19. 段落级增删改');
{
  const diff = api.diff;
  const flat = (segs) => segs.map((s) => s.type + ':' + JSON.stringify(s.text)).join(' | ');

  /* 纯插入一段：其它地方必须保持为公共部分 */
  assert(
    flat(diff('甲段。\n乙段。\n丙段。', '甲段。\n乙段。\n新增段。\n丙段。')) ===
      'equal:"甲段。\\n乙段。\\n" | add:"新增段。\\n" | equal:"丙段。"',
    '中间插入一段：只有新增段被标出，其余保持公共',
    flat(diff('甲段。\n乙段。\n丙段。', '甲段。\n乙段。\n新增段。\n丙段。'))
  );
  assert(
    flat(diff('甲段。\n乙段。\n丙段。', '甲段。\n丙段。')) ===
      'equal:"甲段。\\n" | del:"乙段。\\n" | equal:"丙段。"',
    '中间删除一段：只有被删的那段被标出',
    flat(diff('甲段。\n乙段。\n丙段。', '甲段。\n丙段。'))
  );
  assert(
    flat(diff('甲段。\n乙段。', '甲段。\n乙段。\n新增段。')) ===
      'equal:"甲段。\\n乙段。\\n" | add:"新增段。"',
    '结尾插入一段：只有新增段被标出',
    flat(diff('甲段。\n乙段。', '甲段。\n乙段。\n新增段。'))
  );

  /* 插入 + 改写混在一起：不能把不相干的两段配成一对 */
  const mixed = diff('甲段。\n乙段。\n丙段。', '甲段。\n新增段。\n乙段改。\n丙段。');
  const mixedFlat = flat(mixed);
  assert(
    !mixedFlat.includes('del:"乙" | add:"新增"'),
    '插入一段 + 改一段时，不会把两段错误配成一对',
    mixedFlat
  );
  assert(
    mixedFlat === 'equal:"甲段。\\n" | del:"乙段。\\n" | add:"新增段。\\n" | add:"乙段改。\\n" | equal:"丙段。"',
    '插入与改写分别标出（新增的两段各自独立），如实反映改动',
    mixedFlat
  );

  /* 原文无换行、结果有换行：粒度必须统一，否则整段会被误判 */
  const mixed2 = flat(diff('正文内容。', '开头的铺垫。\n正文内容。\n结尾的收束。'));
  assert(
    mixed2 === 'add:"开头的铺垫。\\n" | equal:"正文内容。\\n" | add:"结尾的收束。"',
    '原文没有换行、结果有换行时，正文仍被正确识别为公共部分',
    mixed2
  );

  /* 整段改写：仍要逐字对齐（只在确实相似时） */
  const rewritten = flat(diff('今天天气不错。\n明天见。', '今天天气很好。\n明天见。'));
  assert(
    rewritten === 'equal:"今天天气" | del:"不错" | add:"很好" | equal:"。\\n明天见。"',
    '段落内容改写：逐字对齐，公共部分保留',
    rewritten
  );
}

/* 20. 退化与规模：不变量 + 规模上限 */
console.log('\n20. 退化与规模');
{
  const diff = api.diff;

  /* 20.1 文本守恒：公共 + 删除 === 原文；公共 + 新增 === 新文（不丢字、不重字） */
  const pairs = [
    ['今天天气不错。\n明天见。', '今天天气很好。\n明天见。'],
    ['甲段。\n乙段。\n丙段。', '甲段。\n乙段。\n新增段。\n丙段。'],
    ['甲段。\n乙段。\n丙段。', '甲段。\n丙段。'],
    ['甲段。\n乙段。\n丙段。', '甲段。\n新增段。\n乙段改。\n丙段。'],
    ['正文内容。', '开头的铺垫。\n正文内容。\n结尾的收束。'],
    ['Hello world\nsecond line', 'Hello there\nsecond line'],
    ['', '只有新增'],
    ['只有删除', ''],
    ['完全一样', '完全一样'],
    ['重复。\n重复。\n重复。', '重复。\n重复。']
  ];
  /* 按顺序交错重建：原文 = equal₁+del₁+equal₂+…，新文 = equal₁+add₁+equal₂+…
     结尾换行做归一化：实现里为统一切分粒度会给两边补一个结尾换行，
     它不参与内容比较（渲染上也看不出来）。 */
  const stripTail = (text) => text.replace(/\n$/, '');
  const rebuild = (segs, kind) => {
    let out = '';
    for (const seg of segs) if (seg.type === 'equal' || seg.type === kind) out += seg.text;
    return stripTail(out);
  };
  let conserved = true;
  let detail = '';
  for (const [before, after] of pairs) {
    const segs = diff(before, after);
    if (rebuild(segs, 'del') !== stripTail(before) || rebuild(segs, 'add') !== stripTail(after)) {
      conserved = false;
      detail = `${JSON.stringify(before)} → ${JSON.stringify(after)} 得到 ${JSON.stringify(segs)}`;
      break;
    }
  }
  assert(conserved, '文本守恒：按顺序重建能还原原文与新文（不丢字、不重字）', detail);

  /* 20.2 规模上限：1 万字全部不同 → 塌缩成 2 段 */
  const big = '甲乙丙丁戊。\n'.repeat(1000);
  const bigChanged = '子丑寅卯辰。\n'.repeat(1000);
  const bigSegs = diff(big, bigChanged);
  assert(bigSegs.length <= 2, '全文皆改时塌缩成整块删除+整块新增', String(bigSegs.length));
  assert(bigSegs.length <= 700, '任何输入下分段数不超过 700（DOM 节点上限）', String(bigSegs.length));

  /* 20.3 性能：1 万字少量修改应在 100ms 内 */
  const perfText = '甲乙丙丁戊。\n'.repeat(1000);
  const perfEdited = perfText.replace('戊。\n甲乙丙丁戊。', '戊改。\n甲乙丙丁戊。');
  const t0 = Date.now();
  const perfSegs = diff(perfText, perfEdited);
  const elapsed = Date.now() - t0;
  assert(elapsed < 100, `1 万字差异计算在 100ms 内（实测 ${elapsed}ms）`);
  assert(perfSegs.length <= 700, '1 万字场景分段数在上限内', String(perfSegs.length));
}

/* 21. 思考模式：只影响微调这一次请求 */
console.log('\n21. 思考模式');
{
  const levelSelect = () => window.document.querySelector('.dt-row--thinking select:nth-of-type(2)');
  const familySelect = () => window.document.querySelector('.dt-row--thinking select:nth-of-type(1)');

  /* 默认关闭：不往请求里塞任何东西 */
  await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
  await tick(10);
  assert(!!levelSelect(), '面板上有思考模式控件');
  window.document.querySelector('.dt-textarea').value = '改一改';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  let options = store.generated[store.generated.length - 1].options;
  assert(!options.settings, '默认（关闭思考）不会往请求里加任何参数', JSON.stringify(options));

  /* 选模型族 + 档位 → 生成对应参数，且只放在这一次请求里 */
  await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
  await tick(10);
  familySelect().value = 'openai';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  levelSelect().value = 'low';
  levelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  window.document.querySelector('.dt-textarea').value = '改一改';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  options = store.generated[store.generated.length - 1].options;
  assert(
    options.settings && options.settings.extraBody &&
      options.settings.extraBody.reasoning_effort === 'low',
    '已知模型族按档位生成参数（OpenAI 兼容 → reasoning_effort）',
    JSON.stringify(options)
  );

  /* 自定义 JSON：面板里直接填 */
  await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
  await tick(10);
  levelSelect().value = 'custom';
  levelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  const customArea = window.document.querySelector('.dt-textarea--mono');
  assert(!!customArea && !customArea.parentNode.hidden, '选「自定义 JSON」后出现手动输入框');
  customArea.value = '{"reasoning_effort": "medium", "foo": 1}';
  customArea.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('.dt-textarea').value = '改一改';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  options = store.generated[store.generated.length - 1].options;
  assert(
    options.settings &&
      options.settings.extraBody &&
      options.settings.extraBody.reasoning_effort === 'medium' &&
      options.settings.extraBody.foo === 1,
    '手动填的 JSON 原样进入请求',
    JSON.stringify(options)
  );

  /* 非法 JSON 不应让请求炸掉 */
  await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
  await tick(10);
  levelSelect().value = 'custom';
  levelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  const badArea = window.document.querySelector('.dt-textarea--mono');
  badArea.value = '{不是合法 JSON';
  badArea.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('.dt-textarea').value = '改一改';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  options = store.generated[store.generated.length - 1].options;
  assert(store.generated.length > 0, '手写非法 JSON 时仍然正常发起请求');
  assert(!options.settings || !options.settings.extraBody, '非法 JSON 被忽略，不会污染请求');
}

/* 22. 各模型族的档位必须按官方枚举给出 */
console.log('\n22. 各模型族的档位');
{
  const familySelect = () => window.document.querySelector('.dt-row--thinking select:nth-of-type(1)');
  const levelSelect = () => window.document.querySelector('.dt-row--thinking select:nth-of-type(2)');
  const levelsOf = () =>
    Array.from(levelSelect().options).map((o) => o.value).filter((v) => v !== 'custom');

  await api.open({ kind: 'message', messageId: 2, role: 'assistant' });
  await tick(10);

  familySelect().value = 'glm';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  assert(
    !levelsOf().includes('off'),
    'GLM-5.3 强制思考：不提供「关闭」档（官方说明 disabled 会 400）',
    JSON.stringify(levelsOf())
  );
  assert(
    JSON.stringify(levelsOf()) === JSON.stringify(['low', 'high', 'max']),
    'GLM 的档位是 low/high/max',
    JSON.stringify(levelsOf())
  );

  familySelect().value = 'mimo';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  assert(
    JSON.stringify(levelsOf()) === JSON.stringify(['off', 'on']),
    'MiMo 只有开/关两档（官方 Chat 端点无 reasoning_effort）',
    JSON.stringify(levelsOf())
  );

  familySelect().value = 'kimi';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  assert(
    JSON.stringify(levelsOf()) === JSON.stringify(['low', 'high', 'max']),
    'Kimi K3 用顶层 reasoning_effort，且思考恒开（无关闭档）',
    JSON.stringify(levelsOf())
  );

  familySelect().value = 'openai';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  assert(
    levelsOf().includes('xhigh') && levelsOf().includes('minimal'),
    'OpenAI 的档位含 minimal/xhigh',
    JSON.stringify(levelsOf())
  );

  /* 换族后无效档位要被纠正 */
  familySelect().value = 'mimo';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  levelSelect().value = 'high';
  levelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  familySelect().value = 'deepseek';
  familySelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(10);
  assert(
    levelsOf().includes(levelSelect().value),
    '切换模型族后档位仍合法',
    levelSelect().value
  );

  /* DeepSeek 的实际请求体 */
  levelSelect().value = 'low';
  levelSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  window.document.querySelector('.dt-textarea').value = '改一改';
  byText(window.document, '.dt-primary-btn', '生成微调').click();
  await tick(30);
  const options = store.generated[store.generated.length - 1].options;
  assert(
    options.settings &&
      options.settings.extraBody &&
      options.settings.extraBody.thinking &&
      options.settings.extraBody.thinking.type === 'enabled' &&
      options.settings.extraBody.reasoning_effort === 'low',
    'DeepSeek 发出 thinking + reasoning_effort 两项',
    JSON.stringify(options)
  );
}

console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
process.exit(failures === 0 ? 0 : 1);