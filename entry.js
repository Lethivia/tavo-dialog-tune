/*!
 * 对话微调 (Dialog Tune) — 插件入口
 *
 * 入口负责声明式动作的 handler：
 *   - 输入框「+」菜单里的「对话微调」：微调当前输入草稿；
 *   - 最后一条消息 action bar 里的「对话微调」：微调最后一条回复。
 *
 * 面板本身由 /chat 片段渲染，入口通过插件事件总线与它通信。
 */
(function () {
  'use strict';

  var i18n = tavo.plugin.i18n;
  var panelReady = false;

  try {
    tavo.plugin.on('dialog-tune-ready', function () {
      panelReady = true;
    });
  } catch (e) {
    /* 旧版本没有事件总线时降级为不可用提示 */
  }

  /**
   * 面板由聊天页片段承载，而片段跑在独立 iframe 里，
   * 入口这边无法可靠探测它是否就绪——所以不再做前置判断，
   * 直接发事件，由宿主回执；800ms 内没有回执才给出明确提示。
   */
  function open(payload) {
    var acknowledged = false;
    var unsubscribe = tavo.plugin.on('dialog-tune-opened', function () {
      acknowledged = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    });
    tavo.plugin.emit('dialog-tune-open', payload);
    setTimeout(function () {
      if (acknowledged) return;
      tavo.utils.toast(i18n.t('runtime.panelUnavailable'));
    }, 800);
  }

  /* 插件 iframe 之间的中转：消息片段把请求投给共同父窗口，
     这里再经插件事件总线转给聊天页宿主（宿主会在自己那一层做同样的监听，
     这里是第二道保险）。不做回执，避免事件总线不通时误取消消息侧的兜底。 */
  try {
    window.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || data.__dialogTune !== 'open' || !data.request) return;
      tavo.plugin.emit('dialog-tune-open-remote', data.request);
    });
  } catch (e) {
    /* 忽略 */
  }

  /* 输入框「+」菜单 */
  tavo.plugin.onInputAction('dialog-tune', async function () {
    open({ kind: 'input' });
  });

  /* 最后一条消息 action bar */
  tavo.plugin.onLastMessageAction('dialog-tune-last', async function (context) {
    if (!context || !context.messageId) return;
    open({
      kind: 'message',
      messageId: context.messageId,
      role: context.role
    });
  });
})();
