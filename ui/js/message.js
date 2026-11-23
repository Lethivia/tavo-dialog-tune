/*!
 * 对话微调 — 消息片段（/messages/end?role=user|character）
 *
 * 每条消息挂载一次，负责：
 *   1. 读取当前消息（tavo.message.current()）；
 *   2. 定位该消息在 DOM 中的容器，注册到核心，供长按浮标定位目标；
 *   3. 渲染行内「微调」按钮（可在设置页关闭）。
 */
(function () {
  'use strict';

  var api = window.__dialogTune__;
  if (!api) return;

  var root = document.getElementById('dt-message-root');
  if (!root) return;

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** 从片段根节点向上找到最内层「包含消息正文」的祖先，作为这条消息的容器 */
  function findMessageElement(content) {
    var needle = normalize(content).slice(0, 24);
    var node = root;
    for (var depth = 0; depth < 12 && node; depth++) {
      if (needle && normalize(node.textContent).indexOf(needle) >= 0) {
        return node;
      }
      node = node.parentElement;
    }
    return root.parentElement || root;
  }

  function renderButton(record) {
    var conf = api.settings();
    if (!conf.enabled || !conf.showInlineButton) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.setAttribute('data-dt-role', record.role === 'user' ? 'user' : 'assistant');
    root.setAttribute('data-dt-message-id', String(record.id));

    var btn = root.querySelector('[data-dt-action="tune"]');
    if (!btn) return;
    btn.setAttribute('aria-label', api.t('runtime.inlineButtonLabel'));
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      api.open({ kind: 'message', messageId: record.id, role: record.role });
    });
  }

  (function init() {
    if (typeof tavo.message.current !== 'function') {
      root.hidden = true;
      return;
    }
    tavo.message
      .current()
      .then(function (message) {
        if (!message || message.hidden) {
          root.hidden = true;
          return;
        }
        var content = message.content || '';
        if (!content.trim()) {
          root.hidden = true;
          return;
        }

        var record = {
          id: message.id,
          role: message.role,
          content: content,
          el: findMessageElement(content)
        };
        api.registerMessage(record);
        renderButton(record);
      })
      .catch(function () {
        root.hidden = true;
      });
  })();
})();
