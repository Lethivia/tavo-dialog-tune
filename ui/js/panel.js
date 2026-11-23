/*!
 * 对话微调 — 聊天页（/chat/body/end）装配
 *
 * 这个片段是「面板宿主」：微调面板由它承载，因此能铺满聊天页视口、
 * 贴在屏幕底部，而不会被消息气泡的容器限制住。
 *
 * 负责：
 *   1. 认领面板宿主；
 *   2. 接收 entry 分发的插件事件并打开面板；
 *   3. 接收其它上下文（消息片段）转发过来的打开请求；
 *   4. 聊天切换时收起面板；语言切换时重渲染。
 */
(function () {
  'use strict';

  var api = window.__dialogTune__;
  if (!api) return;

  var REQUEST_KEY = 'dialog_tune_request';

  /* 认领宿主：面板只在这里创建 */
  api.claimHost();

  /* ---- entry → 面板（官方插件事件总线） ---- */
  tavo.plugin.on('dialog-tune-open', function (payload) {
    if (!payload) return;
    if (payload.kind === 'message') {
      api.open({
        kind: 'message',
        messageId: payload.messageId,
        role: payload.role
      });
    } else {
      api.open({ kind: 'input' });
    }
  });

  /* ---- 同一文档内的请求 ---- */
  document.addEventListener('dialog-tune-request', function (event) {
    api.handleRequest(event && event.detail);
  });

  /* ---- 跨文档（消息片段在 iframe 里） ---- */
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (data && data.__dialogTune === 'open') api.handleRequest(data.request);
  });

  /* ---- 聊天作用域信箱兜底 ---- */
  setInterval(function () {
    tavo.variable
      .get(REQUEST_KEY, 'chat')
      .then(function (value) {
        if (!value || !value.id) return;
        api.handleRequest(value);
        return tavo.variable.unset(REQUEST_KEY, 'chat').catch(function () {});
      })
      .catch(function () {});
  }, 400);

  /* ---- 聊天切换 ---- */
  tavo.plugin.on('chat:closed', function () {
    api.close();
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
