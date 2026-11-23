/**
 * 假的 Tavo 宿主，用于自动化测试
 *
 * 刻意贴近真实行为：
 *   - plugin 事件总线在多个「文档」之间共享（真实插件的 bus 是插件级的）；
 *   - 变量按作用域隔离（chat / global）；
 *   - 消息候选（variant）真实记录调用。
 */
export function createFakeTavo(catalog) {
  const store = {
    messages: [
      { id: 1, role: 'user', content: '在吗' },
      { id: 2, role: 'assistant', content: '我在呢，今天想聊点什么？' },
      { id: 3, role: 'user', content: '讲个笑话' }
    ],
    draft: '',
    generated: [],
    variantCalls: [],
    variables: {},
    toasts: [],
    appended: [],
    currentMessage: { id: 2, role: 'assistant', content: '我在呢，今天想聊点什么？' }
  };

  const CONFIG = {
    enabled: true,
    showInlineButton: true,
    defaultUseMemory: false,
    defaultRecentN: 0,
    maxRecentN: 50,
    autoApply: false,
    contentLanguage: 'source',
    guidePrompt: 'GUIDE_PROMPT_MARKER'
  };

  const listeners = {};

  const tavo = {
    plugin: {
      i18n: {
        requestedLocale: 'zh-CN',
        locale: 'zh-CN',
        defaultLocale: 'zh-CN',
        supportedLocales: ['zh-CN', 'en'],
        t(key, params) {
          let text = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
          if (params) {
            for (const [name, value] of Object.entries(params)) {
              text = text.split(`{${name}}`).join(String(value));
            }
          }
          return text;
        },
        onChange() {
          return () => {};
        }
      },
      config: {
        get(key) {
          return Object.prototype.hasOwnProperty.call(CONFIG, key) ? CONFIG[key] : null;
        },
        all() {
          return { ...CONFIG };
        }
      },
      on(type, handler) {
        (listeners[type] = listeners[type] || []).push(handler);
        return () => {};
      },
      onInputAction(id, handler) {
        (listeners['inputActions:' + id] = listeners['inputActions:' + id] || []).push(handler);
        return () => {};
      },
      onLastMessageAction(id, handler) {
        (listeners['lastMessageActions:' + id] = listeners['lastMessageActions:' + id] || []).push(handler);
        return () => {};
      },
      onSidebarAction(id, handler) {
        (listeners['sidebar:' + id] = listeners['sidebar:' + id] || []).push(handler);
        return () => {};
      },
      emit(type, data) {
        (listeners[type] || []).forEach((handler) => handler(data));
        return Promise.resolve();
      }
    },
    message: {
      get(id) {
        return Promise.resolve(store.messages.find((m) => m.id === id) || null);
      },
      current() {
        return Promise.resolve(store.currentMessage);
      },
      /**
       * 与真实 API 一致的语义：
       *   - indexRange 按「楼层」在未过滤的列表上切片，再套用 filter；
       *   - 空数组 / 空值表示全部；
       *   - 负数从尾部计数。
       */
      find(range, filter = {}) {
        const all = store.messages.slice();
        const applyFilter = (list) => {
          let out = list;
          if (filter.role) out = out.filter((m) => m.role === filter.role);
          if (filter.hidden === false) out = out.filter((m) => m.hidden !== true);
          return out;
        };
        if (range === undefined || range === null) return Promise.resolve(applyFilter(all));
        if (typeof range === 'number') {
          /* 负数楼层从尾部计数：-1 是最后一条 */
          const idx = range < 0 ? all.length + range : range;
          return Promise.resolve(applyFilter(all.slice(idx, idx + 1)));
        }
        if (Array.isArray(range)) {
          if (range.length === 0) return Promise.resolve(applyFilter(all));
          let start = range[0];
          let end = range.length === 1 ? all.length - 1 : range[1];
          if (start < 0) start = Math.max(0, all.length + start);
          if (end < 0) end = all.length + end;
          if (range.length === 1) return Promise.resolve(applyFilter(all.slice(start)));
          return Promise.resolve(applyFilter(all.slice(start, end + 1)));
        }
        return Promise.resolve(applyFilter(all));
      },
      update(payload) {
        const target = store.messages.find((m) => m.id === payload.id);
        if (target) target.content = payload.content;
        return Promise.resolve(payload.id);
      },
      append(payload) {
        store.appended.push(payload);
        return Promise.resolve(99);
      },
      variant: {
        create(messageId, data, options) {
          store.variantCalls.push({ messageId, data, options });
          if (store.variantResult === 'reject') {
            return Promise.reject(new Error('variant unavailable'));
          }
          return Promise.resolve(store.variantResult === undefined ? 42 : store.variantResult);
        },
        list() {
          return Promise.resolve([]);
        },
        select() {
          return Promise.resolve(7);
        }
      }
    },
    input: {
      get() {
        return Promise.resolve(store.draft);
      },
      set(text) {
        store.draft = text;
        return Promise.resolve();
      }
    },
    generate(prompt, options) {
      store.generated.push({ prompt, options });
      const n = store.generated.length;
      return Promise.resolve(`我在这儿，今天想聊点${n === 1 ? '什么' : '别的'}？`);
    },
    variable: {
      get(name, scope = 'chat') {
        return Promise.resolve(store.variables[`${scope}:${name}`]);
      },
      set(name, value, scope = 'chat') {
        store.variables[`${scope}:${name}`] = value;
        return Promise.resolve();
      },
      unset(name, scope = 'chat') {
        delete store.variables[`${scope}:${name}`];
        return Promise.resolve(true);
      }
    },
    memory: {
      current() {
        return Promise.resolve({ id: 1, enabled: true, memories: ['用户喜欢简洁的回答'] });
      }
    },
    utils: {
      toast(message) {
        store.toasts.push(message);
      }
    },
    ui: {
      getInsets() {
        return { topSafe: 10, topBar: 56, bottomInput: 80, bottomSafe: 20 };
      },
      onInsetsChanged() {
        return () => {};
      }
    }
  };

  /** 触发一个已注册的 handler（模拟用户点击原生动作） */
  function fire(type, payload) {
    (listeners[type] || []).forEach((handler) => handler(payload));
  }

  /** 当前已注册的事件与动作 */
  function registered() {
    return Object.keys(listeners);
  }

  return { tavo, store, CONFIG, fire, registered };
}

/**
 * 跨「文档」共享的 BroadcastChannel 实现（jsdom 未内置）。
 * 行为对齐规范：同名频道互通，且不把消息投递回发送方。
 */
export function createBroadcastChannelFactory() {
  const channels = new Map();
  return class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.listeners = [];
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(this);
    }
    addEventListener(type, handler) {
      if (type === 'message') this.listeners.push(handler);
    }
    removeEventListener(type, handler) {
      this.listeners = this.listeners.filter((h) => h !== handler);
    }
    postMessage(data) {
      const peers = channels.get(this.name) || new Set();
      peers.forEach((peer) => {
        if (peer === this) return;
        const event = { data, type: 'message' };
        if (typeof peer.onmessage === 'function') peer.onmessage(event);
        peer.listeners.forEach((handler) => handler(event));
      });
    }
    close() {
      const peers = channels.get(this.name);
      if (peers) peers.delete(this);
    }
  };
}
