/*!
 * 对话微调 — 消息片段（/messages/end?role=user|character）
 *
 * 每条消息挂载一次，只做两件事：
 *   1. 读取当前消息（tavo.message.current()），为空/隐藏时收起自己；
 *   2. 渲染行内「微调」按钮，点击后向面板宿主发请求。
 *
 * 面板不在这里渲染：消息片段可能运行在与聊天页不同的文档里，
 * 就地渲染会让面板被限制在气泡容器中（不在屏幕底部、也无法操作）。
 */
(function () {
  'use strict';

  var api = window.__dialogTune__;
  if (!api) return;

  var root = document.getElementById('dt-message-root');
  if (!root) return;

  function renderButton(message) {
    var conf = api.settings();
    if (!conf.enabled || !conf.showInlineButton) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.setAttribute('data-dt-role', message.role === 'user' ? 'user' : 'assistant');
    root.setAttribute('data-dt-message-id', String(message.id));

    var btn = root.querySelector('[data-dt-action="tune"]');
    if (!btn) return;
    btn.setAttribute('aria-label', api.t('runtime.inlineButtonLabel'));
    var label = btn.querySelector('[data-dt-label]');
    if (label) label.textContent = api.t('actions.dialogTune');
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      api.requestOpen(
        {
          kind: 'message',
          messageId: message.id,
          role: message.role
        },
        root
      );
    });
  }

  if (typeof tavo.message.current !== 'function') {
    root.hidden = true;
    return;
  }

  /* 语言切换时刷新按钮文案 */
  try {
    tavo.plugin.i18n.onChange(function () {
      var label = root.querySelector('[data-dt-label]');
      if (label) label.textContent = api.t('actions.dialogTune');
      var btn = root.querySelector('[data-dt-action="tune"]');
      if (btn) btn.setAttribute('aria-label', api.t('runtime.inlineButtonLabel'));
    });
  } catch (e) {
    /* 旧版本没有 onChange，忽略 */
  }

  tavo.message
    .current()
    .then(function (message) {
      if (!message || message.hidden) {
        root.hidden = true;
        return;
      }
      if (!(message.content || '').trim()) {
        root.hidden = true;
        return;
      }
      renderButton(message);
    })
    .catch(function () {
      root.hidden = true;
    });
})();
