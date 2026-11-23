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
      find(range, filter = {}) {
        let list = store.messages.slice();
        if (filter.role) list = list.filter((m) => m.role === filter.role);
        if (filter.hidden === false) list = list.filter((m) => m.hidden !== true);
        if (typeof range === 'number') return Promise.resolve(list.slice(range, range + 1));
        if (Array.isArray(range)) {
          const start = range[0] < 0 ? Math.max(0, list.length + range[0]) : range[0];
          const end = range[1] < 0 ? list.length + range[1] : range[1];
          if (range.length === 1) return Promise.resolve(list.slice(start));
          return Promise.resolve(list.slice(start, end + 1));
        }
        return Promise.resolve(list);
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
          return Promise.resolve(42);
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

  return { tavo, store, CONFIG };
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
