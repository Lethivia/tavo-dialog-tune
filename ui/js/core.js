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
    var node = PAGE.doc.createElement(tag);
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

  /**
   * 宿主页面文档与窗口。
   * 插件片段跑在独立 iframe 里，若把面板建在片段自己的文档中，
   * fixed 定位会被限制在那个 iframe 的范围内（面板不在屏幕底部、也小得没法用）。
   * 社区插件的通行做法是把 UI 挂到宿主页面文档上，用 frameElement 拿到。
   */
  function pageContext() {
    var doc = document;
    var win = window;
    try {
      var frame = window.frameElement;
      if (frame && frame.ownerDocument) {
        doc = frame.ownerDocument;
        win = doc.defaultView || window;
      }
    } catch (e) {
      /* 跨域时取不到，退回当前文档 */
    }
    return { doc: doc, win: win };
  }

  var PAGE = pageContext();

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
      thinkingFamily: String(cfg('thinkingFamily', 'openai')),
      thinkingPlacement: String(cfg('thinkingPlacement', 'extraBody')),
      thinkingCustomBody: String(cfg('thinkingCustomBody', '')),
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
    if (PAGE.doc.querySelector('link[data-dt-style]')) return;
    var link = PAGE.doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = ASSET_BASE + 'css/panel.css';
    link.setAttribute('data-dt-style', '1');
    PAGE.doc.head.appendChild(link);
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
      var host = PAGE.doc.querySelector('[style*="--tavo-inset-"]');
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
   * 思考模式：模型族 → 档位 → 请求参数
   *
   * 只影响「微调」这一次请求（tavo.generate 的 settings 是逐请求覆盖），
   * 不会改动用户自己的 API 设置。
   * ======================================================= */

  /**
   * 每个模型族的思考参数。
   *
   * 全部按各家官方文档逐条核对（README「思考模式」一节附了链接）：
   *   DeepSeek   api-docs.deepseek.com/guides/thinking_mode/
   *   智谱 GLM   docs.bigmodel.cn/cn/guide/capabilities/thinking
   *   小米 MiMo   mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md
   *   OpenAI     platform.openai.com/docs/guides/reasoning
   *   Anthropic  platform.claude.com/docs/en/build-with-claude/thinking
   *   Gemini     ai.google.dev/gemini-api/docs/thinking
   *   xAI Grok   docs.x.ai/developers/model-capabilities/text/reasoning
   *   Kimi       platform.kimi.ai/docs/guide/use-reasoning-effort
   *   Qwen       alibabacloud.com/help/en/model-studio/deep-thinking
   *
   * 注意各家「关闭思考」的语义并不统一（disabled / none / minimal / 省略参数），
   * 不能跨厂商复用同一个值；强制思考的型号干脆不提供关闭项（否则 400）。
   */
  var THINKING_PROFILES = {
    openai: {
      doc: 'https://platform.openai.com/docs/guides/reasoning',
      levels: [
        { key: 'off', body: { reasoning_effort: 'none' } },
        { key: 'minimal', body: { reasoning_effort: 'minimal' } },
        { key: 'low', body: { reasoning_effort: 'low' } },
        { key: 'medium', body: { reasoning_effort: 'medium' } },
        { key: 'high', body: { reasoning_effort: 'high' } },
        { key: 'xhigh', body: { reasoning_effort: 'xhigh' } }
      ]
    },
    deepseek: {
      doc: 'https://api-docs.deepseek.com/guides/thinking_mode/',
      levels: [
        { key: 'off', body: { thinking: { type: 'disabled' } } },
        { key: 'low', body: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
        { key: 'high', body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
        { key: 'max', body: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } }
      ]
    },
    glm: {
      doc: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking',
      /* GLM-5.3 强制思考：官方明确 disabled 会 400，故不提供关闭项 */
      levels: [
        { key: 'low', body: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
        { key: 'high', body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
        { key: 'max', body: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } }
      ]
    },
    mimo: {
      doc: 'https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md',
      /* 官方 Chat 端点只有开关，没有 reasoning_effort */
      levels: [
        { key: 'off', body: { thinking: { type: 'disabled' } } },
        { key: 'on', body: { thinking: { type: 'enabled' } } }
      ]
    },
    anthropic: {
      doc: 'https://platform.claude.com/docs/en/build-with-claude/thinking',
      levels: [
        /* 4.6–4.8 不传 thinking 即为关闭；5.x 会 400，用手册里的手动 JSON 更稳 */
        { key: 'off', body: {} },
        { key: 'low', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } },
        { key: 'medium', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } } },
        { key: 'high', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } },
        { key: 'xhigh', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } } },
        { key: 'max', body: { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } } }
      ]
    },
    gemini: {
      doc: 'https://ai.google.dev/gemini-api/docs/thinking',
      /* 这里用经典 generateContent 的驼峰写法；Interactions API 是 snake_case，
         需要时用面板里的手动 JSON 直接填 */
      levels: [
        { key: 'minimal', body: { generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } } } },
        { key: 'low', body: { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } } },
        { key: 'medium', body: { generationConfig: { thinkingConfig: { thinkingLevel: 'MEDIUM' } } } },
        { key: 'high', body: { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } } },
        { key: 'xhigh', body: { generationConfig: { thinkingConfig: { thinkingLevel: 'XHIGH' } } } }
      ]
    },
    grok: {
      doc: 'https://docs.x.ai/developers/model-capabilities/text/reasoning',
      /* 官方原文：Reasoning cannot be disabled */
      levels: [
        { key: 'low', body: { reasoning_effort: 'low' } },
        { key: 'medium', body: { reasoning_effort: 'medium' } },
        { key: 'high', body: { reasoning_effort: 'high' } },
        { key: 'xhigh', body: { reasoning_effort: 'xhigh' } }
      ]
    },
    kimi: {
      doc: 'https://platform.kimi.ai/docs/guide/use-reasoning-effort',
      /* K3 系列不支持 thinking，改用顶层 reasoning_effort，且思考恒开 */
      levels: [
        { key: 'low', body: { reasoning_effort: 'low' } },
        { key: 'high', body: { reasoning_effort: 'high' } },
        { key: 'max', body: { reasoning_effort: 'max' } }
      ]
    },
    qwen: {
      doc: 'https://www.alibabacloud.com/help/en/model-studio/deep-thinking',
      levels: [
        { key: 'off', body: { enable_thinking: false } },
        { key: 'minimal', body: { enable_thinking: true, reasoning_effort: 'minimal' } },
        { key: 'low', body: { enable_thinking: true, reasoning_effort: 'low' } },
        { key: 'medium', body: { enable_thinking: true, reasoning_effort: 'medium' } },
        { key: 'high', body: { enable_thinking: true, reasoning_effort: 'high' } },
        { key: 'xhigh', body: { enable_thinking: true, reasoning_effort: 'xhigh' } }
      ]
    }
  };

  /** 按模型族填充档位下拉：各家的档位枚举不同，强制思考的型号也不提供关闭项 */
  function fillThinkingLevels(family, current) {
    var dom = state.dom;
    if (!dom || !dom.levelSelect) return;
    var profile = THINKING_PROFILES[family];
    dom.levelSelect.textContent = '';
    var keys = [];
    if (profile) {
      for (var i = 0; i < profile.levels.length; i++) keys.push(profile.levels[i].key);
    }
    keys.push('custom');
    for (var j = 0; j < keys.length; j++) {
      var option = el('option', '', t('runtime.thinking.level.' + keys[j]));
      option.value = keys[j];
      dom.levelSelect.appendChild(option);
    }
    var valid = false;
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === current) valid = true;
    }
    dom.levelSelect.value = valid ? current : keys[0];
    return dom.levelSelect.value;
  }

  /** 取某个模型族某一档位对应的请求字段 */
  function thinkingLevelBody(family, level) {
    var profile = THINKING_PROFILES[family];
    if (!profile || !level) return {};
    for (var i = 0; i < profile.levels.length; i++) {
      if (profile.levels[i].key === level) return profile.levels[i].body || {};
    }
    return {};
  }

  /** 该模型族是否提供「关闭思考」这一档（强制思考的型号没有） */
  function familySupportsOff(family) {
    var profile = THINKING_PROFILES[family];
    if (!profile) return false;
    for (var i = 0; i < profile.levels.length; i++) {
      if (profile.levels[i].key === 'off') return true;
    }
    return false;
  }

  /** 解析思考参数（返回要并入 settings 的对象） */
  function resolveThinkingBody(level, family, customJson) {
    if (!level || level === 'off') return {};
    if (level === 'custom') {
      var raw = String(customJson || '').trim();
      if (!raw) return {};
      try {
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }
    return thinkingLevelBody(family, level);
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
  function diffTokens(a, b, merge) {
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
      /* merge 为 false 时不合并同类相邻段：单位级对齐需要逐个单位来配对 */
      var last = segments[segments.length - 1];
      if (merge === false) {
        segments.push({ type: type, text: text });
        return;
      }
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

  /** 单位级对齐的规模上限：超过就整块处理，避免大内存 */
  var UNIT_DIFF_LIMIT = 4000000;
  /** 单对单位的逐字细化上限：超过就整块标记 */
  var REFINE_LIMIT = 2000;
  /** 逐字细化的总预算：超出后改为按单位整体标记，避免生成过多 DOM 节点 */
  var SEGMENT_BUDGET = 600;
  /** 只有相似度达到这个值，才认为「删掉的这段」和「新增的这段」是同一处的改写 */
  var PAIR_THRESHOLD = 0.5;
  /** 未配对单位的输出上限：超过就合并成整块 */
  var TAIL_LIMIT = 400;
  /** 相似度计算里的 LCS 规模上限 */
  var SIMILARITY_DIFF_LIMIT = 1000000;
  /** 最终分段总数上限（分段数即 DOM 节点数） */
  var SEGMENT_HARD_LIMIT = 700;

  /** 保留换行的按行切分；结尾的空行不算一个单位 */
  function splitLines(text) {
    var parts = String(text || '').split('\n');
    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      if (i < parts.length - 1) lines.push(parts[i] + '\n');
      else if (parts[i] !== '') lines.push(parts[i]);
    }
    return lines;
  }

  /**
   * 切分「对齐单位」。
   * byLines 决定粒度；调用方必须保证两段文本用同一种粒度，
   * 否则单位不可比，会把整段误判成全部替换。
   */
  function splitUnits(text, byLines) {
    var str = String(text || '');
    if (!str) return [];
    if (byLines) return splitLines(str);
    var units = str.match(/[^，。！？；：、,.!?;:\s]+[，。！？；：、,.!?;:\s]*/g);
    if (units && units.length >= 8) return units;
    /* 没有标点的长文本：按固定长度切块，至少能定位到块级别 */
    if (str.length > REFINE_LIMIT * 2) {
      var chunks = [];
      for (var i = 0; i < str.length; i += REFINE_LIMIT) {
        chunks.push(str.slice(i, i + REFINE_LIMIT));
      }
      return chunks;
    }
    return units && units.length ? units : [str];
  }

  /** 字符级 LCS 比率（带规模上限，超限返回 0） */
  function lcsRatio(a, b) {
    var n = a.length;
    var m = b.length;
    if (!n || !m) return 0;
    if (n * m > SIMILARITY_DIFF_LIMIT) return 0;
    var width = m + 1;
    var table = new Uint16Array((n + 1) * width);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          a.charAt(i) === b.charAt(j)
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    return (2 * table[0]) / (n + m);
  }

  /**
   * 两个单位的相似度：取「公共前后缀占比」与「字符级 LCS 比率」的较大者。
   * 只看前后缀时，开头被改就会把整段判死；只看 LCS 又会丢掉尾部信息。
   */
  function unitSimilarity(a, b) {
    var minLen = Math.min(a.length, b.length);
    var pre = 0;
    while (pre < minLen && a.charAt(pre) === b.charAt(pre)) pre++;
    var suf = 0;
    while (suf < minLen - pre && a.charAt(a.length - 1 - suf) === b.charAt(b.length - 1 - suf)) suf++;
    var edge = (pre + suf) / Math.max(a.length, b.length, 1);
    var lcs = lcsRatio(a, b);
    return Math.max(edge, lcs);
  }

  /**
   * 把「删掉的单位」和「新增的单位」逐字对齐，得到更细的差异。
   */
  function pushRefinedPair(segments, delText, addText, budget) {
    if (!delText) {
      if (addText) segments.push({ type: 'add', text: addText });
      return;
    }
    if (!addText) {
      segments.push({ type: 'del', text: delText });
      return;
    }
    /* 预算用尽或片段过长：整块标记（改动很大时逐字意义不大） */
    if (budget.remaining <= 0 || delText.length > REFINE_LIMIT || addText.length > REFINE_LIMIT) {
      segments.push({ type: 'del', text: delText });
      segments.push({ type: 'add', text: addText });
      return;
    }
    var refined = diffTokens(tokenize(delText), tokenize(addText));
    budget.remaining -= refined.length;
    for (var i = 0; i < refined.length; i++) segments.push(refined[i]);
  }

  /**
   * 差异分段：先按「单位」（行或句）做 LCS 对齐——这一步很便宜，
   * 长文本也不吃内存；再对被替换的单位逐字细化。
   * 没有长度上限：任何长度的文本都能定位到改动所在。
   */
  function buildDiff(original, tuned) {
    var oText = String(original || '');
    var tText = String(tuned || '');
    /* 完全相同也要返回一段 equal：否则预览区会是空的 */
    if (oText === tText) return oText ? [{ type: 'equal', text: oText }] : [];

    /* 两段文本必须用同一种切分粒度，否则单位不可比 */
    var byLines = oText.indexOf('\n') >= 0 || tText.indexOf('\n') >= 0;
    var oSource = oText;
    var tSource = tText;
    if (byLines) {
      /* 统一补上结尾换行，保证「最后一行」的结构也一致 */
      if (oSource.charAt(oSource.length - 1) !== '\n') oSource += '\n';
      if (tSource.charAt(tSource.length - 1) !== '\n') tSource += '\n';
    }

    var oUnits = splitUnits(oSource, byLines);
    var tUnits = splitUnits(tSource, byLines);

    /* 规模太大时不做对齐，直接整块标记（改动本来就很大） */
    if (oUnits.length * tUnits.length > UNIT_DIFF_LIMIT) {
      return [
        { type: 'del', text: oText },
        { type: 'add', text: tText }
      ];
    }

    var ops = diffTokens(oUnits, tUnits, false);
    var segments = [];
    var budget = { remaining: SEGMENT_BUDGET };
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
      /* 只有「一对一」且确实相似时才逐字细化。
         数量不等（例如插入一段 + 改写一段）说明多出来的是独立新增，
         硬凑成一对会把不相干的两段配在一起，产生误导。 */
      var oneToOne = dels.length === adds.length && dels.length > 0;
      /* 未配对的部分按单位逐个保留：这样「哪一段被改」的信息不会丢 */
      var tailDel = [];
      var tailAdd = [];

      if (oneToOne) {
        for (var k = 0; k < dels.length; k++) {
          if (budget.remaining <= 0) {
            tailDel.push(dels[k]);
            tailAdd.push(adds[k]);
            continue;
          }
          if (unitSimilarity(dels[k], adds[k]) >= PAIR_THRESHOLD) {
            pushRefinedPair(segments, dels[k], adds[k], budget);
          } else {
            /* 不是同一处的改写：整段标出，不做逐字对齐 */
            tailDel.push(dels[k]);
            tailAdd.push(adds[k]);
          }
        }
      } else {
        for (var d = 0; d < dels.length; d++) tailDel.push(dels[d]);
        for (var a = 0; a < adds.length; a++) tailAdd.push(adds[a]);
      }

      /* 单位太多时合并成整块，避免 DOM 节点失控 */
      if (tailDel.length + tailAdd.length > TAIL_LIMIT) {
        if (tailDel.length) segments.push({ type: 'del', text: tailDel.join('') });
        if (tailAdd.length) segments.push({ type: 'add', text: tailAdd.join('') });
      } else {
        for (var d2 = 0; d2 < tailDel.length; d2++) {
          segments.push({ type: 'del', text: tailDel[d2] });
        }
        for (var a2 = 0; a2 < tailAdd.length; a2++) {
          segments.push({ type: 'add', text: tailAdd[a2] });
        }
      }
    }
    /* 合并相邻同类段：视觉上一样，但 DOM 节点少一个数量级 */
    var merged = mergeSegments(segments);

    /* 全文皆改（没有任何公共部分）：塌缩成「整块删除 + 整块新增」，
       避免出现几百个没有信息量的红绿块。 */
    var hasCommon = false;
    for (var mi = 0; mi < merged.length; mi++) {
      if (merged[mi].type === 'equal' && merged[mi].text) {
        hasCommon = true;
        break;
      }
    }
    if (!hasCommon && oText && tText) {
      return [
        { type: 'del', text: oText },
        { type: 'add', text: tText }
      ];
    }

    /* 分段总数硬上限：分段数即 DOM 节点数，超了就合并成整块 */
    if (merged.length > SEGMENT_HARD_LIMIT) {
      var collapsedDel = '';
      var collapsedAdd = '';
      for (var ci = 0; ci < merged.length; ci++) {
        if (merged[ci].type === 'del') collapsedDel += merged[ci].text;
        else if (merged[ci].type === 'add') collapsedAdd += merged[ci].text;
      }
      return [
        { type: 'del', text: collapsedDel },
        { type: 'add', text: collapsedAdd }
      ];
    }
    /* 去掉为了对齐补上的那个结尾换行 */
    if (byLines && merged.length) {
      var last = merged[merged.length - 1];
      if (last.text.charAt(last.text.length - 1) === '\n') {
        last.text = last.text.slice(0, -1);
        if (!last.text) merged.pop();
      }
    }
    return merged;
  }

  /**
   * 只合并相邻的「公共」段（纯文本，节点开销低）；
   * 新增/删除段按单位保留，避免把「这一段被改写」显示成「整块被替换」。
   */
  function mergeSegments(segments) {
    var merged = [];
    for (var i = 0; i < segments.length; i++) {
      var last = merged[merged.length - 1];
      if (last && last.type === 'equal' && segments[i].type === 'equal') {
        last.text += segments[i].text;
      } else {
        merged.push({ type: segments[i].type, text: segments[i].text });
      }
    }
    return merged;
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

    /* 思考模式：模型族 + 档位（已知族直接给选项，未知族给手动 JSON） */
    var thinkingRow = el('div', 'dt-row dt-row--thinking');
    var thinkingInfo = el('div', 'dt-row__info');
    var thinkingLabel = el('span', 'dt-row__label', t('runtime.thinking.label'));
    thinkingLabel.setAttribute('data-dt-t', 'runtime.thinking.label');
    var thinkingHint = el('span', 'dt-row__hint', t('runtime.thinking.hint'));
    thinkingHint.setAttribute('data-dt-t', 'runtime.thinking.hint');
    thinkingInfo.appendChild(thinkingLabel);
    thinkingInfo.appendChild(thinkingHint);

    var thinkingControls = el('div', 'dt-row__controls');
    var familySelect = el('select', 'dt-select');
    var levelSelect = el('select', 'dt-select');
    var FAMILY_KEYS = [
      'openai', 'deepseek', 'glm', 'mimo', 'anthropic', 'gemini', 'grok', 'kimi', 'qwen', 'custom'
    ];
    FAMILY_KEYS.forEach(function (key) {
      var option = el('option', '', t('runtime.thinking.family.' + key));
      option.value = key;
      familySelect.appendChild(option);
    });
    familySelect.setAttribute('aria-label', t('runtime.thinking.label'));
    levelSelect.setAttribute('aria-label', t('runtime.thinking.level.label'));
    thinkingControls.appendChild(familySelect);
    thinkingControls.appendChild(levelSelect);
    thinkingRow.appendChild(thinkingInfo);
    thinkingRow.appendChild(thinkingControls);

    /* 手动填写 HTTP body */
    var customField = el('label', 'dt-field dt-field--custom');
    var customLabel = el('span', 'dt-field__label', t('runtime.thinking.custom.label'));
    customLabel.setAttribute('data-dt-t', 'runtime.thinking.custom.label');
    var customArea = el('textarea', 'dt-textarea dt-textarea--mono');
    customArea.rows = 3;
    customArea.placeholder = t('runtime.thinking.custom.placeholder');
    customArea.setAttribute('data-dt-t-ph', 'runtime.thinking.custom.placeholder');
    customField.appendChild(customLabel);
    customField.appendChild(customArea);
    customField.hidden = true;

    var privacy = el('p', 'dt-note', t('runtime.privacy'));
    privacy.setAttribute('data-dt-t', 'runtime.privacy');

    var switches = el('div', 'dt-switches');
    switches.appendChild(memoryRow);
    switches.appendChild(recentRow);
    switches.appendChild(thinkingRow);
    switches.appendChild(customField);
    switches.appendChild(privacy);

    controls.appendChild(field);

    /* ---- 主体：预览态 ---- */
    var preview = el('div', 'dt-stage dt-stage--preview');
    preview.setAttribute('data-stage', 'preview');
    preview.hidden = true;

    var cands = el('div', 'dt-cands');
    var previewError = el('p', 'dt-note dt-note--error');
    previewError.hidden = true;

    /* 生成中的状态行：实时计时 + 提示，避免"是不是卡死了"的疑惑 */
    var status = el('div', 'dt-status');
    status.hidden = true;
    var statusText = el('span', 'dt-status__text');
    var statusTimer = el('span', 'dt-status__timer');
    status.appendChild(statusText);
    status.appendChild(statusTimer);
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
    preview.appendChild(status);
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
    PAGE.doc.body.appendChild(root);

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
      familySelect: familySelect,
      levelSelect: levelSelect,
      customArea: customArea,
      customField: customField,
      recentHint: recentHint,
      number: number,
      minus: minus,
      plus: plus,
      unit: unit,
      privacy: privacy,
      cands: cands,
      previewError: previewError,
      status: status,
      statusText: statusText,
      statusTimer: statusTimer,
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
    if (open) PAGE.doc.addEventListener('pointerdown', onMenuOutside, true);
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

    dom.familySelect.addEventListener('change', function () {
      if (!state.model) return;
      state.model.thinkingFamily = dom.familySelect.value;
      var level = fillThinkingLevels(state.model.thinkingFamily, state.model.thinkingLevel);
      state.model.thinkingLevel = level;
      render();
    });
    dom.levelSelect.addEventListener('change', function () {
      if (state.model) state.model.thinkingLevel = dom.levelSelect.value;
      render();
    });
    dom.customArea.addEventListener('input', function () {
      if (state.model) state.model.thinkingCustom = dom.customArea.value;
    });

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

    PAGE.doc.addEventListener('keydown', function (event) {
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

    if (model.busy) {
      dom.status.hidden = false;
      dom.statusText.textContent = t('runtime.status.generating');
    } else {
      dom.status.hidden = true;
    }

    var max = settings().maxRecentN;
    dom.number.max = String(max);
    /* 正在输入时不要覆盖玩家键入的值 */
    if (document.activeElement !== dom.number) {
      dom.number.value = String(clamp(model.recentN, 0, max));
    }
    dom.memorySwitch.setAttribute('aria-checked', model.useMemory ? 'true' : 'false');
    dom.memorySwitch.classList.toggle('is-on', model.useMemory);
    dom.recentHint.textContent = t('runtime.switch.recentHint');
    dom.familySelect.value = model.thinkingFamily || 'openai';
    /* 档位可能因模型族不同而变化（各家枚举不同），确保下拉与模型一致 */
    var level = fillThinkingLevels(model.thinkingFamily || 'openai', model.thinkingLevel);
    model.thinkingLevel = level;
    dom.customField.hidden = model.thinkingLevel !== 'custom';
    if (document.activeElement !== dom.customArea) {
      dom.customArea.value = model.thinkingCustom || '';
    }
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
        dom.tunedBody.appendChild(PAGE.doc.createTextNode(segment.text));
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

  function openSheet(target) {
    var conf = settings();
    if (!conf.enabled) return Promise.resolve(false);

    if (!state.dom) buildSheet();
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
          thinkingFamily: conf.thinkingFamily,
          thinkingLevel: 'off',
          thinkingCustom: conf.thinkingCustomBody || '',
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
    if (state.dom.root.parentNode && state.dom.root.parentNode !== PAGE.doc.body) {
      PAGE.doc.body.appendChild(state.dom.root);
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

  /** 生成期间的状态行：显示已等待时长 */
  function startStatusTimer() {
    stopStatusTimer();
    var started = Date.now();
    state.statusTimer = setInterval(function () {
      if (!state.dom) return;
      var seconds = Math.round((Date.now() - started) / 1000);
      state.dom.statusTimer.textContent = t('runtime.status.waiting', { seconds: seconds });
    }, 1000);
  }

  function stopStatusTimer() {
    if (state.statusTimer) {
      clearInterval(state.statusTimer);
      state.statusTimer = null;
    }
    if (state.dom) {
      state.dom.status.hidden = true;
      state.dom.statusTimer.textContent = '';
    }
  }

  function runGenerate(isReroll) {
    var model = state.model;
    if (!model || model.busy) return;
    model.busy = true;
    model.error = null;
    render();
    startStatusTimer();

    buildPrompt(model)
      .then(function (prompt) {
        /* 不设超时：等不及的玩家会自己取消，由玩家决定节奏 */
        var options = { context: false };
        var extra = resolveThinkingBody(
          model.thinkingLevel,
          model.thinkingFamily,
          model.thinkingCustom
        );
        if (extra && Object.keys(extra).length) {
          /* 只覆盖这一次请求的模型参数，不动用户自己的 API 设置 */
          var placement = settings().thinkingPlacement;
          options.settings =
            placement === 'flat'
              ? extra
              : { extraBody: extra };
        }
        return tavo.generate(prompt, options);
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
        var message = (error && error.message) ? error.message : t('error.generateFailed');
        /* 思考参数是未文档化能力：若模型侧报错，多半是它不认这个字段 */
        if (model.thinkingLevel && model.thinkingLevel !== 'off' && looksLikeParamRejection(message)) {
          model.error = t('error.thinkingParamRejected', { detail: message });
        } else {
          model.error = message;
        }
      })
      .then(function () {
        model.busy = false;
        stopStatusTimer();
        render();
      });
  }

  /** 判断报错是否像是「模型不认这个参数」 */
  function looksLikeParamRejection(message) {
    var text = String(message || '').toLowerCase();
    var hints = [
      'unsupported',
      'unrecognized',
      'unknown',
      'invalid_request_error',
      'unexpected',
      'not permitted',
      'extra_body',
      'reasoning_effort',
      'thinking'
    ];
    for (var i = 0; i < hints.length; i++) {
      if (text.indexOf(hints[i]) >= 0) return true;
    }
    return false;
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
    PAGE.doc.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    if (area.parentNode) area.parentNode.removeChild(area);
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

  var CHANNEL_NAME = 'dialog-tune';
  var EVENT_REQUEST = 'dialog-tune-request';
  var EVENT_ACK = 'dialog-tune-ack';

  /* 同源广播：作为主通道之外的备用 */
  var channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) {
    channel = null;
  }

  /** 待宿主接手的请求 */
  var pendingRequest = null;

  /** 认领面板宿主（由聊天页片段调用）：面板只建一份，且建在宿主页面文档上 */
  function claimHost() {
    state.isHost = true;
    if (!state.dom) {
      try {
        buildSheet();
      } catch (e) {
        /* 宿主页面尚未就绪，打开面板时会重建 */
      }
    }
  }

  function makeRequestId() {
    return 'dt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 在「宿主页面窗口」上派发自定义事件。
   * 这是社区插件的通行做法：两个片段都能通过
   * window.frameElement.ownerDocument.defaultView 拿到同一个宿主窗口，
   * 在它上面收发 CustomEvent 即可互通（跨 iframe 最省事的一条路）。
   */
  function emitOnPage(name, detail) {
    try {
      var event;
      try {
        event = new CustomEvent(name, { detail: detail });
      } catch (e) {
        event = PAGE.doc.createEvent('CustomEvent');
        event.initCustomEvent(name, false, false, detail);
      }
      PAGE.win.dispatchEvent(event);
      return true;
    } catch (e) {
      return false;
    }
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

  /** 回执：告诉发起方「已有人接手」，让它不要再等 */
  function acknowledge(request) {
    if (!request || !request.id) return;
    emitOnPage(EVENT_ACK, { id: request.id });
    if (channel) {
      try {
        channel.postMessage({ type: 'ack', id: request.id });
      } catch (e) {
        /* 忽略 */
      }
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dialogTune: 'ack', id: request.id }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 非宿主收到请求时继续往上级窗口转发 */
  function forwardUpward(request) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dialogTune: 'open', request: request }, '*');
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  /**
   * 打开微调面板。
   * 本文档是宿主时直接打开；否则把请求发给宿主：
   *   1) 宿主页面窗口的 CustomEvent（主通道，同步送达）
   *   2) 同源广播
   *   3) 同一文档的 DOM 事件
   *   4) 上级 / 顶层窗口的 postMessage
   * 都不通时给出明确提示——面板已经挂在宿主页面上，没法再退回气泡里展开。
   */
  function requestOpen(target) {
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

    /* 先登记：通道是同步送达的，回执可能先于下面的赋值到达 */
    pendingRequest = { id: request.id, target: target };

    /* 1) 宿主页面窗口事件 */
    emitOnPage(EVENT_REQUEST, request);

    /* 2) 同源广播 */
    if (channel) {
      try {
        channel.postMessage({ type: 'open', request: request });
      } catch (e) {
        /* 忽略 */
      }
    }

    /* 3) 同一文档 */
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_REQUEST, { detail: request, bubbles: true })
      );
    } catch (e) {
      /* 忽略 */
    }

    /* 4) 上级与顶层窗口 */
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

    /* 5) 兜底：600ms 内没人接手，给出明确提示而不是无声无息 */
    setTimeout(function () {
      if (!pendingRequest || pendingRequest.id !== request.id) return;
      pendingRequest = null;
      tavo.utils.toast(t('runtime.panelUnavailable'));
    }, 600);
  }

  /* 宿主页面窗口：请求与回执 */
  try {
    PAGE.win.addEventListener(EVENT_REQUEST, function (event) {
      var request = event && event.detail;
      if (!request) return;
      if (state.isHost) {
        handleRequest(request);
        acknowledge(request);
      } else {
        forwardUpward(request);
      }
    });
    PAGE.win.addEventListener(EVENT_ACK, function (event) {
      var detail = event && event.detail;
      /* 只认自己的那次回执，否则会被别的请求的迟到回执误清 */
      if (detail && pendingRequest && detail.id === pendingRequest.id) {
        pendingRequest = null;
      }
    });
  } catch (e) {
    /* 忽略 */
  }

  /* 同源广播：宿主接手并回执；非宿主继续上抛 */
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
        if (pendingRequest && data.id === pendingRequest.id) pendingRequest = null;
      }
    });
  }

  /* 来自祖先窗口的回执与请求 */
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data) return;
    if (data.__dialogTune === 'ack') {
      if (pendingRequest && data.id === pendingRequest.id) pendingRequest = null;
      return;
    }
    if (data.__dialogTune === 'open' && data.request) {
      if (state.isHost) {
        handleRequest(data.request);
        acknowledge(data.request);
      } else {
        forwardUpward(data.request);
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
    /* 差异算法对外暴露，便于独立验证与排查 */
    diff: buildDiff,
    claimHost: claimHost,
    handleRequest: handleRequest,
    isHost: function () {
      return state.isHost;
    },
    isEnabled: function () {
      return settings().enabled;
    }
  };

})();
