/*!
 * 对话微调 — 聊天页（/chat/body/end）装配
 *
 * 负责：
 *   1. 接收 entry 分发过来的插件事件并打开面板；
 *   2. 接收 /messages 片段在同一文档内派发的 DOM 事件并打开面板；
 *   3. 安装长按手势（输入框草稿 / 消息气泡浮标）；
 *   4. 聊天切换时收起面板；语言切换时重渲染。
 */
(function () {
  'use strict';

  var api = window.__dialogTune__;
  if (!api) return;

  /* ---- entry → 面板（官方插件事件总线） ---- */
  var unsubscribe = tavo.plugin.on('dialog-tune-open', function (payload) {
    if (!payload) return;
    if (payload.kind === 'message') {
      api.open({ kind: 'message', messageId: payload.messageId, role: payload.role });
    } else {
      api.open({ kind: 'input' });
    }
  });

  /* ---- /messages 片段 → 面板（同文档 DOM 事件，作为跨文档兜底） ---- */
  function onDomRequest(event) {
    var detail = event && event.detail;
    if (!detail) return;
    if (detail.kind === 'message') {
      api.open({ kind: 'message', messageId: detail.messageId, role: detail.role });
    } else {
      api.open({ kind: 'input' });
    }
  }
  document.addEventListener('dialog-tune-request', onDomRequest);

  /* ---- 长按手势 ---- */
  api.installGesture();

  /* ---- 聊天切换 ---- */
  tavo.plugin.on('chat:closed', function () {
    api.close();
    api.hidePill();
  });

  /* ---- 语言切换：完整重渲染 ---- */
  try {
    tavo.plugin.i18n.onChange(function () {
      api.close();
    });
  } catch (e) {
    /* 旧版本没有 onChange，忽略 */
  }

  /* ---- 通知 entry：面板已就绪 ---- */
  try {
    tavo.plugin.emit('dialog-tune-ready', {});
  } catch (e) {
    /* 忽略 */
  }
})();
