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
    var opening =
      payload.kind === 'message'
        ? api.open({
            kind: 'message',
            messageId: payload.messageId,
            role: payload.role
          })
        : api.open({ kind: 'input' });
    Promise.resolve(opening).then(function (opened) {
      /* 只有真的打开了才回执，否则入口会误以为成功而不再提示 */
      if (!opened) return;
      try {
        tavo.plugin.emit('dialog-tune-opened', {});
      } catch (e) {
        /* 忽略 */
      }
    });
  });

  /* ---- entry 中转过来的请求 ---- */
  tavo.plugin.on('dialog-tune-open-remote', function (request) {
    if (!request) return;
    api.handleRequest(request);
    try {
      tavo.plugin.emit('dialog-tune-opened', {});
    } catch (e) {
      /* 忽略 */
    }
  });

  /* ---- 同一文档内的请求 ---- */
  document.addEventListener('dialog-tune-request', function (event) {
    api.handleRequest(event && event.detail);
  });

  /* ---- 跨文档（消息片段在 iframe 里） ----
   *
   * 插件片段各自跑在独立 iframe 里，/messages 与 /chat 是并列的兄弟：
   * 同源广播在它们之间不一定连通，而 postMessage 只往祖先窗口投递。
   * 可靠的做法是借「共同的父窗口」中转——消息侧把请求 postMessage 给它的
   * parent，宿主在 parent 上监听 message 事件即可收到，并可用 event.source 回执。
   * 跨域下也允许对父窗口调用 addEventListener / postMessage。
   */
  function onRelayMessage(event) {
    var data = event && event.data;
    if (!data || data.__dialogTune !== 'open' || !data.request) return;
    api.handleRequest(data.request);
    try {
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ __dialogTune: 'ack', id: data.request.id }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  window.addEventListener('message', onRelayMessage);
  /* parent 与 top 各自独立 try：一条失败不影响另一条 */
  try {
    if (window.parent && window.parent !== window) {
      window.parent.addEventListener('message', onRelayMessage);
    }
  } catch (e) {
    /* 跨域限制下忽略 */
  }
  try {
    if (window.top && window.top !== window) {
      window.top.addEventListener('message', onRelayMessage);
    }
  } catch (e) {
    /* 忽略 */
  }

  /* ---- 聊天作用域信箱兜底 ---- */
  setInterval(function () {
    tavo.variable
      .get(REQUEST_KEY, 'chat')
      .then(function (value) {
        if (!value || !value.id) return;
        api.handleRequest(value);
        /* 信箱通道没有回执，这里清掉信箱就等于告诉请求方「已接手」，
           避免请求方 350ms 后又就地展开一个面板，出现两个面板。 */
        return tavo.variable.unset(REQUEST_KEY, 'chat').catch(function () {});
      })
      .catch(function () {});
  }, 300);

  /* ---- 聊天切换 ---- */
  tavo.plugin.on('chat:closed', function () {
    api.close();
  });

  /* ---- 语言切换：完整重渲染 ---- */
  try {
    tavo.plugin.i18n.onChange(function () {
      /* 完整重渲染：刷新面板里所有静态文案，而不只是关掉面板 */
      api.applyStrings();
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
