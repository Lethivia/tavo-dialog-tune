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

  /** 面板是否可用：事件标记，或直接探测文档里已挂载的面板 */
  function panelAvailable() {
    if (panelReady) return true;
    try {
      return typeof document !== 'undefined' && !!document.querySelector('.dt-sheet-root');
    } catch (e) {
      return false;
    }
  }

  function open(payload) {
    if (!panelAvailable()) {
      tavo.utils.toast(i18n.t('runtime.panelUnavailable'));
      return;
    }
    tavo.plugin.emit('dialog-tune-open', payload);
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
