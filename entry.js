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
   * 面板由聊天页片段承载，并挂在宿主页面文档上。
   * 入口这边做一次辅助探测（宿主页面文档里有没有面板），
   * 但不把它当作前置条件——真正的判据是宿主的回执。
   */
  /** 面板是否真的处于打开状态（存在但隐藏不算） */
  function panelVisible() {
    try {
      var candidates = [];
      if (typeof document !== 'undefined') candidates.push(document);
      var frame = window.frameElement;
      if (frame && frame.ownerDocument) candidates.push(frame.ownerDocument);
      for (var i = 0; i < candidates.length; i++) {
        var sheet = candidates[i].querySelector('.dt-sheet-root');
        if (sheet && !sheet.hidden) return true;
      }
    } catch (e) {
      /* 忽略 */
    }
    return false;
  }

  function open(payload) {
    var acknowledged = false;
    var unsubscribe = tavo.plugin.on('dialog-tune-opened', function () {
      acknowledged = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    });
    tavo.plugin.emit('dialog-tune-open', payload);
    setTimeout(function () {
      if (acknowledged || panelVisible()) return;
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

})();
