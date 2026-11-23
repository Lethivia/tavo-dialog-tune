/*!
 * 对话微调 (Dialog Tune) — 共享核心
 *
 * 该脚本同时被 /chat 与 /messages 两个 HTML 片段加载。
 * 通过 window.__dialogTune__ 保证同一文档内只初始化一次；
 * 若两个片段位于不同文档（例如被放进 iframe），各自持有一份独立实例，
 * 功能仍然完整，只是面板不再共享。
 *
 * 设计约束（来自产品决策）：
 *   1. 只做「点微调 → 输指令与选项 → 生成 → 应用」这一条主链路；
 *   2. 不做相似度校验、不做自动重写、不做选区局部微调、不做输出清洗；
 *   3. 最小化改写完全由「引导提示词」引导，设置页可编辑；
 *   4. 应用到消息时写入为原生候选版本，撤销交给 Tavo 原生的版本切换。
 */
(function () {
  'use strict';

  var PLUGIN_ID = 'io.github.dialogtune.dialog-tune';
  var ASSET_BASE = '/plugins/' + PLUGIN_ID + '/ui/';
  var NS = '__dialogTune__';
  if (window[NS] && window[NS].version) return;

  /* =========================================================
   * 基础工具
   * ======================================================= */

  function t(key, params) {
    try {
      var i18n = tavo.plugin.i18n;
      return i18n ? i18n.t(key, params) : key;
    } catch (e) {
      return key;
    }
  }

  function cfg(key, fallback) {
    try {
      var value = tavo.plugin.config.get(key);
      return value === null || value === undefined || value === '' ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isFinite(n) ? n : fallback;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 生成中的加载圈 */
  /** 清空容器子节点，可保留指定节点 */
  function clearChildren(node, keep) {
    var children = Array.prototype.slice.call(node.children);
    children.forEach(function (child) {
      if (child !== keep) node.removeChild(child);
    });
  }

  function spinner() {
    var node = el('span', 'dt-spinner');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  /** 带加载态的按钮 */
  function actionButton(className, label, busy) {
    var node = button(className, '');
    if (busy) {
      node.classList.add('is-busy');
      node.appendChild(spinner());
    }
    node.appendChild(el('span', 'dt-btn__label', label));
    return node;
  }

  function button(className, text, ariaLabel) {
    var node = el('button', className, text);
    node.type = 'button';
    if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
    return node;
  }

  /** 归一化空白，用于比较与查找 */
  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function charCount(text) {
    return String(text || '').length;
  }

  /* =========================================================
   * 状态
   * ======================================================= */

  var state = {
    /** 面板 DOM 引用 */
    dom: null,
    /** 面板数据模型 */
    model: null,
    /** 上次的开关设置（跨聊天记忆） */
    prefs: { useMemory: false, recentN: 0 },
    prefsLoaded: false,
    /** 本文档是否承载面板（由聊天页片段认领） */
    isHost: false,
    /** 最近一次已处理的跨上下文请求 id，用于去重 */
    lastRequestId: null,
    lastFocused: null
  };

  var PREFS_KEY = 'dialog_tune_prefs';

  /** 当前下拉菜单的触发按钮 */
  var menuToggle = null;

  /* =========================================================
   * 设置项
   * ======================================================= */

  function settings() {
    return {
      enabled: cfg('enabled', true) !== false,
      showInlineButton: cfg('showInlineButton', true) !== false,
      defaultUseMemory: cfg('defaultUseMemory', false) === true,
      defaultRecentN: toInt(cfg('defaultRecentN', 0), 0),
      maxRecentN: clamp(toInt(cfg('maxRecentN', 50), 50), 0, 200),
      autoApply: cfg('autoApply', false) === true,
      contentLanguage: String(cfg('contentLanguage', 'source')),
      guidePrompt: String(cfg('guidePrompt', ''))
    };
  }

  /* =========================================================
   * 偏好（记住玩家上一次的开关调整）
   * ======================================================= */

  function loadPrefs() {
    /* 每次打开都重新读：面板可能运行在另一个文档里，缓存会读到旧值 */
    var conf = settings();
    state.prefs.useMemory = conf.defaultUseMemory === true;
    state.prefs.recentN = clamp(conf.defaultRecentN, 0, conf.maxRecentN);
    return tavo.variable
      .get(PREFS_KEY, 'global')
      .then(function (value) {
        if (value && typeof value === 'object') {
          state.prefs.useMemory = value.useMemory === true;
          state.prefs.recentN = clamp(toInt(value.recentN, 0), 0, conf.maxRecentN);
        }
        return state.prefs;
      })
      .catch(function () {
        return state.prefs;
      });
  }

  function savePrefs() {
    var model = state.model;
    if (!model) return Promise.resolve();
    state.prefs.useMemory = model.useMemory;
    state.prefs.recentN = model.recentN;
    return tavo.variable
      .set(PREFS_KEY, { useMemory: model.useMemory, recentN: model.recentN }, 'global')
      .catch(function () {});
  }

  /* =========================================================
   * 样式注入（面板可能被 /messages 片段触发，因此自行确保样式已加载）
   * ======================================================= */

  function ensureStyles() {
    if (document.querySelector('link[data-dt-style]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ASSET_BASE + 'css/panel.css';
    link.setAttribute('data-dt-style', '1');
    document.head.appendChild(link);
  }

  /* =========================================================
   * 宿主安全边界
   * ======================================================= */

  /** 读取宿主提供的安全边界（顶栏 / 输入框 / 系统安全区） */
  function readInsets() {
    var result = { topSafe: 0, topBar: 0, bottomInput: 0, bottomSafe: 0 };
    try {
      if (tavo.ui && typeof tavo.ui.getInsets === 'function') {
        var snapshot = tavo.ui.getInsets();
        if (snapshot) {
          Object.keys(result).forEach(function (key) {
            var value = snapshot[key];
            if (typeof value === 'number' && isFinite(value)) result[key] = value;
          });
          return result;
        }
      }
    } catch (e) {
      /* 旧版本没有该接口，走下面的兜底 */
    }

    /* 兜底：宿主会把边界写成内联 CSS 变量，从承载元素上读回来 */
    try {
      var host = document.querySelector('[style*="--tavo-inset-"]');
      if (host && window.getComputedStyle) {
        var computed = getComputedStyle(host);
        Object.keys(result).forEach(function (key) {
          var name = '--tavo-inset-' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
          var value = parseFloat(computed.getPropertyValue(name));
          if (isFinite(value)) result[key] = value;
        });
      }
    } catch (e) {
      /* 忽略 */
    }
    return result;
  }

  function applyInsets() {
    if (!state.dom || !state.dom.root) return;
    var insets = readInsets();
    state.dom.root.style.setProperty('--dt-inset-top', (insets.topBar || 0) + 'px');
    state.dom.root.style.setProperty('--dt-inset-bottom', (insets.bottomInput || 0) + 'px');
  }

  /* =========================================================
   * 上下文组装
   * ======================================================= */

  /** 取被微调消息之前最近的 N 条（不含隐藏消息） */
  function collectRecentMessages(model) {
    var n = model.recentN;
    if (!n || n <= 0) return Promise.resolve([]);
    var targetId = model.target && model.target.messageId;
    return tavo.message.find([], {}).then(function (all) {
      var list = Array.isArray(all) ? all : [];
      var index = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === targetId) {
          index = i;
          break;
        }
      }
      var range;
      if (index >= 0) {
        range = [Math.max(0, index - n), index - 1];
      } else {
        range = [-n, -1];
      }
      if (range[1] < range[0]) return [];
      return tavo.message.find(range, { hidden: false }).then(function (items) {
        return Array.isArray(items) ? items : [];
      });
    });
  }

  function collectMemory() {
    return tavo.memory.current().then(function (memory) {
      if (!memory || memory.enabled !== true) return [];
      var list = Array.isArray(memory.memories) ? memory.memories : [];
      return list.filter(function (item) {
        return typeof item === 'string' && item.trim();
      });
    });
  }

  /**
   * 组装最终提示词：
   *   引导提示词 → （可选）长记忆 → （可选）最近 N 条对话 → 原文 → 玩家指令 → 输出要求
   * 上下文默认只有「当前被选中的那一段内容」。
   */
  function buildPrompt(model) {
    var conf = settings();
    var parts = [];

    if (conf.guidePrompt) parts.push(conf.guidePrompt);

    return Promise.all([model.useMemory ? collectMemory() : [], collectRecentMessages(model)])
      .then(function (collected) {
        var memories = collected[0] || [];
        var recent = collected[1] || [];

        if (memories.length) {
          parts.push(t('prompt.memoryBlock', { memory: memories.map(function (m) {
            return '- ' + m;
          }).join('\n') }));
        }

        if (recent.length) {
          var dialogue = recent
            .map(function (item) {
              var who = item.role === 'user' ? t('role.user') : t('role.assistant');
              return who + t('role.separator') + item.content;
            })
            .join('\n');
          parts.push(t('prompt.recentBlock', { dialogue: dialogue }));
        }

        parts.push(t('prompt.sourceBlock', { source: model.source }));
        parts.push(t('prompt.instructionBlock', { instruction: model.instruction }));

        if (conf.contentLanguage === 'app') {
          var locale = 'zh-CN';
          try {
            locale = tavo.plugin.i18n.requestedLocale || tavo.plugin.i18n.locale || locale;
          } catch (e) {}
          parts.push(t('prompt.outputLanguageApp', { locale: locale }));
        } else {
          parts.push(t('prompt.outputLanguageSource'));
        }

        parts.push(t('prompt.outputRule'));
        return parts.join('\n\n');
      });
  }

  /* =========================================================
   * 差异计算（仅用于预览高亮，不参与任何判断）
   * ======================================================= */

  var TOKEN_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]|[A-Za-z0-9_'’-]+|\s+|[^\s]/g;

  function tokenize(text) {
    var out = [];
    var match;
    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(String(text || ''))) !== null) {
      out.push(match[0]);
    }
    return out;
  }

  /**
   * 词元级最长公共子序列差异。
   * 返回 [{type:'equal'|'add'|'del', text}]
   */
  function diffTokens(a, b) {
    var n = a.length;
    var m = b.length;
    var width = m + 1;
    var table = new Uint16Array((n + 1) * width);

    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }

    var segments = [];
    var x = 0;
    var y = 0;
    function push(type, text) {
      var last = segments[segments.length - 1];
      if (last && last.type === type) last.text += text;
      else segments.push({ type: type, text: text });
    }

    while (x < n && y < m) {
      if (a[x] === b[y]) {
        push('equal', a[x]);
        x++;
        y++;
      } else if (table[(x + 1) * width + y] >= table[x * width + y + 1]) {
        push('del', a[x]);
        x++;
      } else {
        push('add', b[y]);
        y++;
      }
    }
    while (x < n) push('del', a[x++]);
    while (y < m) push('add', b[y++]);

    return segments;
  }

  /** 局部细化的上限：超过就整块标记，不再逐字算 */
  var REFINE_LIMIT = 4000;

  /** 保留换行的按行切分 */
  function splitLines(text) {
    var parts = String(text || '').split('\n');
    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      lines.push(i < parts.length - 1 ? parts[i] + '\n' : parts[i]);
    }
    return lines;
  }

  /**
   * 把「删掉的片段」和「新增的片段」逐字对齐，得到更细的差异。
   */
  function pushRefined(segments, delText, addText) {
    if (!delText) {
      if (addText) segments.push({ type: 'add', text: addText });
      return;
    }
    if (!addText) {
      segments.push({ type: 'del', text: delText });
      return;
    }
    if (delText.length > REFINE_LIMIT || addText.length > REFINE_LIMIT) {
      segments.push({ type: 'del', text: delText });
      segments.push({ type: 'add', text: addText });
      return;
    }
    var refined = diffTokens(tokenize(delText), tokenize(addText));
    for (var i = 0; i < refined.length; i++) segments.push(refined[i]);
  }

  /**
   * 差异分段：先按行对齐（便宜，长文本也不吃内存），
   * 再对「被替换的行」做逐字细化。
   * 不设长度上限——任何长度的文本都能标出差异。
   */
  function buildDiff(original, tuned) {
    var oText = String(original || '');
    var tText = String(tuned || '');
    if (oText === tText) return [];

    var ops = diffTokens(splitLines(oText), splitLines(tText));
    var segments = [];
    var i = 0;
    while (i < ops.length) {
      if (ops[i].type === 'equal') {
        segments.push({ type: 'equal', text: ops[i].text });
        i++;
        continue;
      }
      var dels = [];
      var adds = [];
      while (i < ops.length && ops[i].type !== 'equal') {
        if (ops[i].type === 'del') dels.push(ops[i].text);
        else adds.push(ops[i].text);
        i++;
      }
      pushRefined(segments, dels.join(''), adds.join(''));
    }
    return segments;
  }

  /** 差异统计：新增与删除了多少字 */
  function diffStats(segments) {
    var added = 0;
    var removed = 0;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].type === 'add') added += segments[i].text.length;
      else if (segments[i].type === 'del') removed += segments[i].text.length;
    }
    return { added: added, removed: removed };
  }

  /* =========================================================
   * 面板：创建与渲染
   * ======================================================= */

  function buildSheet() {
    ensureStyles();
    var root = el('div', 'dt-sheet-root');
    root.hidden = true;

    var backdrop = el('div', 'dt-backdrop');
    backdrop.addEventListener('click', function () {
      closeSheet();
    });

    var sheet = el('section', 'dt-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'dt-sheet-title');

    /* ---- 头部 ---- */
    var head = el('header', 'dt-sheet__head');
    var titles = el('div', 'dt-sheet__titles');
    var title = el('h2', 'dt-sheet__title', t('runtime.title'));
    title.id = 'dt-sheet-title';
    title.setAttribute('data-dt-t', 'runtime.title');
    var subtitle = el('p', 'dt-sheet__subtitle');
    titles.appendChild(title);
    titles.appendChild(subtitle);

    var closeBtn = button('dt-icon-btn dt-sheet__close', '✕', t('runtime.close'));
    closeBtn.setAttribute('data-dt-t-aria', 'runtime.close');
    closeBtn.addEventListener('click', function () {
      closeSheet();
    });

    head.appendChild(titles);
    head.appendChild(closeBtn);

    /* ---- 主体：输入态 ---- */
    var body = el('div', 'dt-sheet__body');

    var controls = el('div', 'dt-controls');

    var field = el('label', 'dt-field');
    var fieldLabel = el('span', 'dt-field__label', t('runtime.field.instruction'));
    fieldLabel.setAttribute('data-dt-t', 'runtime.field.instruction');
    var textarea = el('textarea', 'dt-textarea');
    textarea.rows = 3;
    textarea.placeholder = t('runtime.field.instructionPlaceholder');
    textarea.setAttribute('data-dt-t-ph', 'runtime.field.instructionPlaceholder');
    textarea.setAttribute('aria-label', t('runtime.field.instruction'));
    field.appendChild(fieldLabel);
    field.appendChild(textarea);

    /* 长记忆开关 */
    var memoryRow = el('div', 'dt-row');
    var memoryInfo = el('div', 'dt-row__info');
    var memoryLabel = el('span', 'dt-row__label', t('runtime.switch.memory'));
    memoryLabel.setAttribute('data-dt-t', 'runtime.switch.memory');
    var memoryHint = el('span', 'dt-row__hint', t('runtime.switch.memoryHint'));
    memoryHint.setAttribute('data-dt-t', 'runtime.switch.memoryHint');
    memoryInfo.appendChild(memoryLabel);
    memoryInfo.appendChild(memoryHint);
    var memorySwitch = button('dt-switch', '');
    memorySwitch.setAttribute('role', 'switch');
    memorySwitch.setAttribute('aria-label', t('runtime.switch.memory'));
    memorySwitch.setAttribute('data-dt-t-aria', 'runtime.switch.memory');
    var memoryKnob = el('span', 'dt-switch__knob');
    memorySwitch.appendChild(memoryKnob);
    memoryRow.appendChild(memoryInfo);
    memoryRow.appendChild(memorySwitch);

    /* 最近 N 条 */
    var recentRow = el('div', 'dt-row');
    var recentInfo = el('div', 'dt-row__info');
    var recentLabel = el('span', 'dt-row__label', t('runtime.switch.recent'));
    recentLabel.setAttribute('data-dt-t', 'runtime.switch.recent');
    var recentHint = el('span', 'dt-row__hint', t('runtime.switch.recentHint'));
    recentHint.setAttribute('data-dt-t', 'runtime.switch.recentHint');
    recentInfo.appendChild(recentHint);
    var stepper = el('div', 'dt-stepper');
    var minus = button('dt-stepper__btn', '−', t('runtime.switch.recentMinus'));
    minus.setAttribute('data-dt-t-aria', 'runtime.switch.recentMinus');
    var number = el('input', 'dt-stepper__input');
    number.setAttribute('data-dt-t-aria', 'runtime.switch.recent');
    number.type = 'number';
    number.inputMode = 'numeric';
    number.min = '0';
    number.setAttribute('aria-label', t('runtime.switch.recent'));
    var plus = button('dt-stepper__btn', '+', t('runtime.switch.recentPlus'));
    plus.setAttribute('data-dt-t-aria', 'runtime.switch.recentPlus');
    var unit = el('span', 'dt-stepper__unit', t('runtime.switch.recentUnit'));
    unit.setAttribute('data-dt-t', 'runtime.switch.recentUnit');
    stepper.appendChild(minus);
    stepper.appendChild(number);
    stepper.appendChild(plus);
    stepper.appendChild(unit);
    recentRow.appendChild(recentInfo);
    recentRow.appendChild(stepper);

    var privacy = el('p', 'dt-note', t('runtime.privacy'));
    privacy.setAttribute('data-dt-t', 'runtime.privacy');

    var switches = el('div', 'dt-switches');
    switches.appendChild(memoryRow);
    switches.appendChild(recentRow);
    switches.appendChild(privacy);

    controls.appendChild(field);

    /* ---- 主体：预览态 ---- */
    var preview = el('div', 'dt-stage dt-stage--preview');
    preview.setAttribute('data-stage', 'preview');
    preview.hidden = true;

    var cands = el('div', 'dt-cands');
    var previewError = el('p', 'dt-note dt-note--error');
    previewError.hidden = true;
    var diffWrap = el('div', 'dt-diff');
    var tunedBlock = el('div', 'dt-diff__block');
    var diffHead = el('div', 'dt-diff__head');
    var diffTitle = el('span', 'dt-diff__title', t('runtime.diff.tuned'));
    diffTitle.setAttribute('data-dt-t', 'runtime.diff.tuned');
    var diffStat = el('span', 'dt-diff__stat');
    diffHead.appendChild(diffTitle);
    diffHead.appendChild(diffStat);
    tunedBlock.appendChild(diffHead);
    var tunedBody = el('div', 'dt-diff__body dt-diff__body--tuned');
    tunedBlock.appendChild(tunedBody);

    diffWrap.appendChild(tunedBlock);
    preview.appendChild(previewError);
    preview.appendChild(cands);
    preview.appendChild(diffWrap);

    body.appendChild(controls);
    body.appendChild(switches);
    body.appendChild(preview);

    /* ---- 底部 ---- */
    var foot = el('footer', 'dt-sheet__foot');
    var footLeft = el('div', 'dt-foot__left');
    var footRight = el('div', 'dt-foot__right');
    var menu = el('div', 'dt-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    footRight.appendChild(menu);

    foot.appendChild(footLeft);
    foot.appendChild(footRight);

    sheet.appendChild(head);
    sheet.appendChild(body);
    sheet.appendChild(foot);
    root.appendChild(backdrop);
    root.appendChild(sheet);
    document.body.appendChild(root);

    state.dom = {
      root: root,
      sheet: sheet,
      subtitle: subtitle,
      closeBtn: closeBtn,
      controls: controls,
      switches: switches,
      preview: preview,
      textarea: textarea,
      memorySwitch: memorySwitch,
      recentHint: recentHint,
      number: number,
      minus: minus,
      plus: plus,
      unit: unit,
      privacy: privacy,
      cands: cands,
      previewError: previewError,
      diffStat: diffStat,
      tunedBody: tunedBody,
      footLeft: footLeft,
      footRight: footRight,
      menu: menu
    };

    wireSheetEvents();
    applyStrings();
    applyInsets();
    try {
      if (tavo.ui && typeof tavo.ui.onInsetsChanged === 'function') {
        tavo.ui.onInsetsChanged(applyInsets);
      }
    } catch (e) {
      /* 忽略 */
    }
    return state.dom;
  }

  /** 低频操作菜单 */
  function buildMenu(isInput) {
    var dom = state.dom;
    if (!dom) return;
    dom.menu.textContent = '';
    var items = isInput
      ? [{ label: t('runtime.copy'), run: copyCurrent }]
      : [
          { label: t('runtime.appendAsNew'), run: applyAsNewMessage },
          { label: t('runtime.applyToInput'), run: applyToInput },
          { label: t('runtime.copy'), run: copyCurrent }
        ];
    items.forEach(function (item) {
      var node = button('dt-menu__item', item.label);
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', function () {
        closeMenu();
        item.run();
      });
      dom.menu.appendChild(node);
    });
  }

  function toggleMenu(open) {
    var dom = state.dom;
    if (!dom) return;
    dom.menu.hidden = !open;
    if (menuToggle) menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) document.addEventListener('pointerdown', onMenuOutside, true);
    else document.removeEventListener('pointerdown', onMenuOutside, true);
  }

  function closeMenu() {
    toggleMenu(false);
  }

  function onMenuOutside(event) {
    var dom = state.dom;
    if (dom && dom.menu.contains(event.target)) return;
    if (menuToggle && menuToggle.contains(event.target)) return;
    closeMenu();
  }

  /** 刷新面板里所有静态文案（语言切换时调用） */
  function applyStrings() {
    var dom = state.dom;
    if (!dom || !dom.root) return;
    var nodes = dom.root.querySelectorAll('[data-dt-t]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-dt-t');
      if (key === 'runtime.privacy' && state.model && state.model.error) continue;
      node.textContent = t(key);
    }
    var placeholders = dom.root.querySelectorAll('[data-dt-t-ph]');
    for (var j = 0; j < placeholders.length; j++) {
      placeholders[j].placeholder = t(placeholders[j].getAttribute('data-dt-t-ph'));
    }
    var labels = dom.root.querySelectorAll('[data-dt-t-aria]');
    for (var k = 0; k < labels.length; k++) {
      labels[k].setAttribute('aria-label', t(labels[k].getAttribute('data-dt-t-aria')));
    }
    updateFooterState();
  }

  function wireSheetEvents() {
    var dom = state.dom;

    dom.memorySwitch.addEventListener('click', function () {
      if (!state.model) return;
      state.model.useMemory = !state.model.useMemory;
      savePrefs();
      render();
    });

    function commitRecent() {
      if (!state.model) return;
      var max = settings().maxRecentN;
      var value = clamp(toInt(dom.number.value, 0), 0, max);
      dom.number.value = String(value);
      state.model.recentN = value;
      savePrefs();
      render();
    }

    dom.number.addEventListener('change', commitRecent);
    dom.number.addEventListener('blur', commitRecent);
    dom.minus.addEventListener('click', function () {
      dom.number.value = String(clamp(toInt(dom.number.value, 0) - 1, 0, settings().maxRecentN));
      commitRecent();
    });
    dom.plus.addEventListener('click', function () {
      dom.number.value = String(clamp(toInt(dom.number.value, 0) + 1, 0, settings().maxRecentN));
      commitRecent();
    });

    dom.textarea.addEventListener('input', function () {
      if (state.model) state.model.instruction = dom.textarea.value;
    });

    dom.textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        confirmCompose();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !state.dom || state.dom.root.hidden) return;
      if (!state.dom.menu.hidden) {
        closeMenu();
        return;
      }
      closeSheet();
    });
  }

  /* =========================================================
   * 面板：渲染
   * ======================================================= */

  /** 只更新已有底部按钮的可用状态，不重建节点 */
  function updateFooterState() {
    var dom = state.dom;
    var model = state.model;
    if (!dom || !model || !dom.buttons) return;
    var busy = !!model.busy;
    if (dom.buttons.confirm) {
      dom.buttons.confirm.disabled = busy;
      dom.buttons.confirm.classList.toggle('is-busy', busy);
      var label = dom.buttons.confirm.querySelector('.dt-btn__label');
      if (label) label.textContent = busy ? t('runtime.generating') : t('runtime.confirm');
      toggleSpinner(dom.buttons.confirm, busy);
    }
    if (dom.buttons.reroll) {
      dom.buttons.reroll.disabled = busy;
      var rerollLabel = dom.buttons.reroll.querySelector('.dt-btn__label');
      if (rerollLabel) rerollLabel.textContent = t('runtime.reroll');
      toggleSpinner(dom.buttons.reroll, busy);
    }
    if (dom.buttons.main) dom.buttons.main.disabled = busy;
    if (dom.buttons.toggle) dom.buttons.toggle.disabled = busy;
  }

  /** 加载圈的挂载与卸载 */
  function toggleSpinner(node, busy) {
    var existing = node.querySelector('.dt-spinner');
    if (busy && !existing) {
      node.insertBefore(spinner(), node.firstChild);
    } else if (!busy && existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function render() {
    var dom = state.dom;
    var model = state.model;
    if (!dom || !model) return;

    var isPreview = model.stage === 'preview';

    /* 微调要求与上下文开关在结果页同样保留：改完可以直接「重新生成」 */
    dom.preview.hidden = !isPreview;
    /* 输入框只在生成过程中禁用，生成结束立即可改 */
    dom.textarea.disabled = !!model.busy;

    dom.subtitle.textContent = model.target.label;

    var max = settings().maxRecentN;
    dom.number.max = String(max);
    /* 正在输入时不要覆盖玩家键入的值 */
    if (document.activeElement !== dom.number) {
      dom.number.value = String(clamp(model.recentN, 0, max));
    }
    dom.memorySwitch.setAttribute('aria-checked', model.useMemory ? 'true' : 'false');
    dom.memorySwitch.classList.toggle('is-on', model.useMemory);
    dom.recentHint.textContent = t('runtime.switch.recentHint');
    dom.privacy.textContent = t('runtime.privacy');

    closeMenu();

    /* 底部按钮只在「阶段/目标类型」变化时重建。
       之前每次 render 都重建，导致用户按下按钮时数字框失焦 → render()
       → 按钮节点被摘除 → 浏览器不再派发 click（首击必丢）。 */
    var footKey = model.stage + ':' + (model.target ? model.target.kind : '');
    if (dom.footKey === footKey) {
      /* 底部结构不变：只更新状态，内容区照常刷新 */
      updateFooterState();
      renderBody(isPreview);
      return;
    }
    dom.footKey = footKey;
    clearChildren(dom.footLeft);
    clearChildren(dom.footRight, dom.menu);

    if (!isPreview) {
      var cancelBtn = button('dt-ghost-btn', t('runtime.cancel'));
      cancelBtn.addEventListener('click', function () {
        closeSheet();
      });
      dom.footLeft.appendChild(cancelBtn);

      var confirmBtn = actionButton(
        'dt-primary-btn',
        model.busy ? t('runtime.generating') : t('runtime.confirm'),
        model.busy
      );
      confirmBtn.disabled = !!model.busy;
      confirmBtn.addEventListener('click', function () {
        confirmCompose();
      });
      dom.footRight.appendChild(confirmBtn);
      dom.buttons = { stage: 'compose', confirm: confirmBtn };
    } else {
      var reroll = actionButton('dt-ghost-btn', t('runtime.reroll'), model.busy);
      reroll.disabled = !!model.busy;
      reroll.addEventListener('click', function () {
        /* 重新生成使用玩家当前改过的微调要求 */
        if (state.model) state.model.instruction = state.dom.textarea.value.trim();
        runGenerate(true);
      });
      dom.footLeft.appendChild(reroll);
      dom.buttons = { stage: 'preview', reroll: reroll };

      /* 主按钮 + 下拉：把低频操作收进菜单，窄屏也不会换行 */
      var isInput = model.target.kind === 'input';
      var split = el('div', 'dt-split');
      var mainBtn = button(
        'dt-primary-btn dt-split__main',
        isInput ? t('runtime.applyToInput') : t('runtime.applyToMessage')
      );
      mainBtn.disabled = !!model.busy;
      mainBtn.addEventListener('click', function () {
        if (isInput) applyToInput();
        else applyToMessage();
      });

      var toggle = button('dt-primary-btn dt-split__toggle', '');
      toggle.setAttribute('aria-haspopup', 'menu');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', t('runtime.moreActions'));
      toggle.appendChild(el('span', 'dt-caret'));
      menuToggle = toggle;
      toggle.addEventListener('click', function (event) {
        event.stopPropagation();
        toggleMenu(dom.menu.hidden);
      });

      split.appendChild(mainBtn);
      split.appendChild(toggle);
      dom.footRight.appendChild(split);
      dom.buttons.main = mainBtn;
      dom.buttons.toggle = toggle;
      buildMenu(isInput);
    }

    renderBody(isPreview);
  }

  /** 内容区刷新：预览结果或输入态提示 */
  function renderBody(isPreview) {
    var dom = state.dom;
    var model = state.model;
    if (!dom || !model) return;
    if (isPreview) {
      renderPreview();
      return;
    }
    if (model.error) {
      dom.privacy.textContent = model.error;
      dom.privacy.classList.add('is-error');
    } else {
      dom.privacy.textContent = t('runtime.privacy');
      dom.privacy.classList.remove('is-error');
    }
  }

  function renderPreview() {
    var dom = state.dom;
    var model = state.model;
    var text = model.candidates[model.activeIndex] || '';

    if (model.error) {
      dom.previewError.hidden = false;
      dom.previewError.textContent = model.error;
    } else {
      dom.previewError.hidden = true;
      dom.previewError.textContent = '';
    }

    /* 历次结果切换 */
    dom.cands.textContent = '';
    if (model.candidates.length > 1) {
      model.candidates.forEach(function (candidate, index) {
        var chip = button('dt-chip', String(index + 1));
        chip.setAttribute('aria-label', t('runtime.candidateLabel', { index: index + 1 }));
        if (index === model.activeIndex) chip.classList.add('is-active');
        chip.addEventListener('click', function () {
          model.activeIndex = index;
          render();
        });
        dom.cands.appendChild(chip);
      });
    }

    /* 只展示微调后的正文，差异直接内联高亮 */
    dom.tunedBody.textContent = '';
    var segments = buildDiff(model.source, text);
    var stats = diffStats(segments);

    segments.forEach(function (segment) {
      if (segment.type === 'equal') {
        dom.tunedBody.appendChild(document.createTextNode(segment.text));
      } else if (segment.type === 'add') {
        dom.tunedBody.appendChild(el('span', 'dt-diff__add', segment.text));
      } else {
        dom.tunedBody.appendChild(el('span', 'dt-diff__del', segment.text));
      }
    });

    /* 把差异量直接写出来：这样「没有差异」和「高亮坏了」在界面上能分辨 */
    if (stats.added || stats.removed) {
      dom.diffStat.textContent = t('runtime.diff.stats', {
        added: stats.added,
        removed: stats.removed
      });
      dom.diffStat.classList.remove('is-empty');
    } else {
      dom.diffStat.textContent = t('runtime.diff.same');
      dom.diffStat.classList.add('is-empty');
    }

    scrollToFirstDiff();
  }

  function scrollToFirstDiff() {
    var dom = state.dom;
    if (!dom) return;
    var marker = dom.tunedBody.querySelector('.dt-diff__add, .dt-diff__del');
    if (!marker || typeof marker.scrollIntoView !== 'function') return;
    try {
      marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {
      marker.scrollIntoView();
    }
  }

  /* =========================================================
   * 面板：打开与关闭
   * ======================================================= */

  function openSheet(target, options) {
    var conf = settings();
    if (!conf.enabled) return Promise.resolve(false);

    if (!state.dom) buildSheet();
    /* inline：在当前上下文内以普通文档流展开（宿主不可用时的降级） */
    if (state.dom) {
      state.dom.root.classList.toggle('dt-sheet-root--inline', !!(options && options.inline));
    }
    state.lastFocused = document.activeElement;

    return loadPrefs()
      .then(function () {
        if (target.kind === 'message') {
          return tavo.message.get(target.messageId).then(function (message) {
            if (!message) throw new Error(t('error.messageMissing'));
            var source = message.content || '';
            return {
              source: source,
              label: t('runtime.target.message', {
                role: message.role === 'user' ? t('role.user') : t('role.assistant'),
                count: charCount(source)
              })
            };
          });
        }
        return tavo.input.get().then(function (draft) {
          var source = draft || '';
          return {
            source: source,
            label: t('runtime.target.input', { count: charCount(source) })
          };
        });
      })
      .then(function (resolved) {
        if (!resolved.source || !resolved.source.trim()) {
          tavo.utils.toast(t('error.emptyTarget'));
          return false;
        }
        state.model = {
          target: {
            kind: target.kind,
            messageId: target.messageId,
            role: target.role,
            label: resolved.label
          },
          source: resolved.source,
          instruction: '',
          useMemory: state.prefs.useMemory,
          recentN: clamp(state.prefs.recentN, 0, conf.maxRecentN),
          stage: 'compose',
          candidates: [],
          activeIndex: 0,
          busy: false,
          error: null
        };
        state.dom.root.hidden = false;
        state.dom.root.classList.add('is-open');
        /* 每次打开都是一张空白的指令表，切换开关不会清掉玩家已输入的内容 */
        state.dom.textarea.value = '';
        render();
        setTimeout(function () {
          try {
            state.dom.textarea.focus();
          } catch (e) {}
        }, 60);
        return true;
      })
      .catch(function (error) {
        tavo.utils.toast((error && error.message) || t('error.unknown'));
        return false;
      });
  }

  function closeSheet() {
    if (!state.dom) return;
    state.dom.root.hidden = true;
    state.dom.root.classList.remove('is-open');
    state.dom.root.classList.remove('dt-sheet-root--inline');
    if (state.dom.root.parentNode && state.dom.root.parentNode !== document.body) {
      document.body.appendChild(state.dom.root);
    }
    state.model = null;
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
      try {
        state.lastFocused.focus();
      } catch (e) {}
    }
    state.lastFocused = null;
  }

  /* =========================================================
   * 面板：生成与应用
   * ======================================================= */

  function confirmCompose() {
    var model = state.model;
    if (!model || model.busy) return;
    var instruction = state.dom.textarea.value.trim();
    if (!instruction) {
      state.dom.textarea.focus();
      tavo.utils.toast(t('error.instructionRequired'));
      return;
    }
    model.instruction = instruction;
    model.useMemory = state.dom.memorySwitch.getAttribute('aria-checked') === 'true';
    model.recentN = clamp(toInt(state.dom.number.value, 0), 0, settings().maxRecentN);
    savePrefs();
    runGenerate(false);
  }

  function runGenerate(isReroll) {
    var model = state.model;
    if (!model || model.busy) return;
    model.busy = true;
    model.error = null;
    render();

    buildPrompt(model)
      .then(function (prompt) {
        /* 不设超时：等不及的玩家会自己取消，由玩家决定节奏 */
        return tavo.generate(prompt, { context: false });
      })
      .then(function (text) {
        /* 期间可能已经切换了目标（面板被重新打开），这时结果没有归属，丢弃并提示 */
        if (state.model !== model) {
          throw Object.assign(new Error(t('error.targetChanged')), { silent: true });
        }
        var result = text === null || text === undefined ? '' : String(text);
        if (!result.trim()) throw new Error(t('error.emptyResult'));
        model.candidates.push(result);
        model.activeIndex = model.candidates.length - 1;
        model.stage = 'preview';
        /* 设置里开启「自动应用」时，生成完直接落盘，不进预览 */
        if (settings().autoApply) {
          if (model.target.kind === 'input') applyToInput();
          else applyToMessage();
        }
      })
      .catch(function (error) {
        /* 失败时保持当前阶段，原文不会被改动 */
        if (error && error.silent) {
          tavo.utils.toast(t('error.targetChanged'));
          return;
        }
        model.error = (error && error.message) ? error.message : t('error.generateFailed');
      })
      .then(function () {
        model.busy = false;
        render();
      });
  }

  function currentText() {
    var model = state.model;
    if (!model) return '';
    return model.candidates[model.activeIndex] || '';
  }

  function copyCurrent() {
    var text = currentText();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          tavo.utils.toast(t('runtime.copied'));
        },
        function () {
          legacyCopy(text);
        }
      );
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    var area = el('textarea', 'dt-hidden-copy');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    tavo.utils.toast(ok ? t('runtime.copied') : t('error.copyFailed'));
  }

  function applyToMessage() {
    var model = state.model;
    if (!model) return;
    var text = currentText();
    if (!text) return;
    var messageId = model.target.messageId;

    /* 旧版本可能根本没有候选版本能力，此时退化为直接覆盖 */
    var canUseVariant =
      typeof tavo.message.variant === 'object' &&
      tavo.message.variant !== null &&
      typeof tavo.message.variant.create === 'function';

    function applyPlain() {
      return tavo.message.update({ id: messageId, content: text }).then(function (updatedId) {
        tavo.utils.toast(updatedId ? t('runtime.appliedPlain') : t('error.applyFailed'));
        return updatedId;
      });
    }

    Promise.resolve()
      .then(function () {
        if (!canUseVariant) return applyPlain();
        return tavo.message.variant
          .create(messageId, { content: text }, { select: true })
          .then(function (variantId) {
            if (variantId === null || variantId === undefined) {
              /* 候选存储不可用时退化为直接覆盖 */
              return applyPlain();
            }
            tavo.utils.toast(t('runtime.applied'));
            return variantId;
          })
          .catch(function () {
            return applyPlain();
          });
      })
      .then(function () {
        closeSheet();
      })
      .catch(function (error) {
        tavo.utils.toast((error && error.message) || t('error.applyFailed'));
      });
  }

  function applyAsNewMessage() {
    var model = state.model;
    if (!model) return;
    var text = currentText();
    if (!text) return;
    var payload = { content: text };
    if (model.target.role === 'user') {
      payload.role = 'user';
    } else {
      payload.role = 'assistant';
    }
    tavo.message
      .get(model.target.messageId)
      .then(function (message) {
        if (message && message.characterId && payload.role === 'assistant') {
          payload.characterId = message.characterId;
        }
        return tavo.message.append(payload);
      })
      .then(function (newId) {
        tavo.utils.toast(newId ? t('runtime.appended') : t('error.appendFailed'));
        closeSheet();
      })
      .catch(function (error) {
        tavo.utils.toast((error && error.message) || t('error.appendFailed'));
      });
  }

  function applyToInput() {
    var text = currentText();
    if (!text) return;
    tavo.input
      .set(text)
      .then(function () {
        tavo.utils.toast(t('runtime.appliedToInput'));
        closeSheet();
      })
      .catch(function (error) {
        tavo.utils.toast((error && error.message) || t('error.applyFailed'));
      });
  }

  /* =========================================================
   * 面板宿主与跨上下文请求
   *
   * 消息片段可能运行在与聊天页不同的文档（例如 iframe）里，
   * 此时若就地渲染面板，fixed 定位会被限制在气泡容器内——面板既不在
   * 屏幕底部，也小到无法操作。所以面板统一由聊天页级片段承载，
   * 消息片段只负责发请求。
   * ======================================================= */

  var REQUEST_KEY = 'dialog_tune_request';
  var CHANNEL_NAME = 'dialog-tune';

  /* 同源广播：这是唯一能跨「兄弟 iframe」的通道
   * （/messages 与 /chat 是并列的插件 iframe，postMessage 只往祖先走） */
  var channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) {
    channel = null;
  }

  /** 待本地兜底处理的请求 */
  var pendingRequest = null;

  /** 认领面板宿主（由聊天页片段调用） */
  function claimHost() {
    state.isHost = true;
  }

  function makeRequestId() {
    return 'dt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 宿主侧：处理来自其它上下文的打开请求（按 id 去重） */
  function handleRequest(request) {
    if (!request || !request.id) return;
    if (state.lastRequestId === request.id) return;
    state.lastRequestId = request.id;
    pendingRequest = null;
    openSheet({
      kind: request.kind,
      messageId: request.messageId || null,
      role: request.role || null
    });
  }

  /** 回执：告诉发起方「已有人接手」，让它不要再本地兜底打开 */
  function acknowledge(request, source) {
    if (!request || !request.id) return;
    if (channel) {
      try {
        channel.postMessage({ type: 'ack', id: request.id });
      } catch (e) {
        /* 忽略 */
      }
    }
    try {
      if (source && source.postMessage) {
        source.postMessage({ __dialogTune: 'ack', id: request.id }, '*');
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dialogTune: 'ack', id: request.id }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 非宿主收到广播时，继续往上级窗口转发，层层上抛直到找到宿主 */
  function forwardUpward(request, source) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dialogTune: 'open', request: request }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  /**
   * 打开微调面板。本文档是宿主时直接打开；
   * 否则把请求转发给宿主（同文档 DOM 事件 → 上级窗口 postMessage → 聊天作用域信箱）。
   */
  function requestOpen(target, anchor) {
    if (!settings().enabled) return;
    if (state.isHost) {
      openSheet(target);
      return;
    }

    var request = {
      id: makeRequestId(),
      kind: target.kind,
      messageId: target.messageId || null,
      role: target.role || null
    };

    /* 先登记待兜底的请求：广播是同步投递的，回执可能先于下面的赋值到达 */
    pendingRequest = { id: request.id, target: target, anchor: anchor || null };

    /* 1) 同源广播：跨兄弟 iframe 的可靠通道 */
    if (channel) {
      try {
        channel.postMessage({ type: 'open', request: request });
      } catch (e) {
        /* 忽略 */
      }
    }

    /* 2) 同一文档 */
    try {
      document.dispatchEvent(
        new CustomEvent('dialog-tune-request', { detail: request, bubbles: true })
      );
    } catch (e) {
      /* 忽略 */
    }

    /* 3) 上级与顶层窗口：宿主会在共同父窗口上监听 message 来接单 */
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dialogTune: 'open', request: request }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
    try {
      if (window.top && window.top !== window && window.top !== window.parent) {
        window.top.postMessage({ __dialogTune: 'open', request: request }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }

    /* 4) 聊天作用域信箱 */
    tavo.variable
      .set(REQUEST_KEY, request, 'chat')
      .catch(function () {});

    /* 5) 兜底：350ms 内没人接手，就地打开，保证点击一定有反应 */
    setTimeout(function () {
      if (!pendingRequest || pendingRequest.id !== request.id) return;
      /* 信箱通道没有回执，但宿主处理完会清掉信箱——所以兜底前再确认一次：
         信箱里已经没有这条请求，就说明宿主接手了，不要重复展开。 */
      tavo.variable
        .get(REQUEST_KEY, 'chat')
        .then(function (value) {
          if (!pendingRequest || pendingRequest.id !== request.id) return;
          if (value && value.id === request.id) {
            /* 确实没人接手：就地展开，保证点击有反应 */
            var fallback = pendingRequest;
            pendingRequest = null;
            if (fallback.anchor && fallback.anchor.appendChild) {
              try {
                fallback.anchor.appendChild(state.dom.root);
              } catch (e) {
                /* 忽略 */
              }
            }
            openSheet(fallback.target, { inline: true });
          }
        })
        .catch(function () {
          if (!pendingRequest || pendingRequest.id !== request.id) return;
          var fallback = pendingRequest;
          pendingRequest = null;
          openSheet(fallback.target, { inline: true });
        });
    }, 350);
  }

  /* 监听同源广播：宿主接手并回执；非宿主继续上抛 */
  if (channel) {
    channel.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data) return;
      if (data.type === 'open' && data.request) {
        if (state.isHost) {
          handleRequest(data.request);
          acknowledge(data.request);
        } else {
          forwardUpward(data.request);
        }
      } else if (data.type === 'ack') {
        /* 有人接手了，本地兜底不必再打开 */
        pendingRequest = null;
      }
    });
  }

  /* 监听来自祖先窗口的回执与请求 */
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data) return;
    if (data.__dialogTune === 'ack') {
      pendingRequest = null;
      return;
    }
    if (data.__dialogTune === 'open' && data.request) {
      if (state.isHost) {
        handleRequest(data.request);
        acknowledge(data.request, event.source);
      } else {
        forwardUpward(data.request, event.source);
      }
    }
  });

  /* =========================================================
   * 对外接口
   * ======================================================= */

  window[NS] = {
    version: '1.0.2',
    pluginId: PLUGIN_ID,
    t: t,
    settings: settings,
    open: openSheet,
    close: closeSheet,
    requestOpen: requestOpen,
    applyStrings: applyStrings,
    claimHost: claimHost,
    handleRequest: handleRequest,
    isHost: function () {
      return state.isHost;
    },
    isEnabled: function () {
      return settings().enabled;
    }
  };

  /* 预建面板 DOM：避免首次打开的抖动，也让入口可以探测面板是否就绪 */
  try {
    buildSheet();
  } catch (e) {
    /* 宿主 DOM 尚未就绪时忽略，打开面板时会重建 */
  }
})();
