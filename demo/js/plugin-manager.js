/* ============ Notionish Plugin System ============ */
(function (global) {
  "use strict";

  const PluginManager = {
    _plugins: {},   // id → { manifest, hooks, enabled }
    _hooks: {},     // hookName → [{ plugin, fn }]

    /** 注册一个钩子回调 */
    on(hook, fn) {
      if (!this._hooks[hook]) this._hooks[hook] = [];
      this._hooks[hook].push({ plugin: this._loadingPlugin, fn });
    },

    /** 触发钩子 */
    emit(hook, ...args) {
      const list = this._hooks[hook] || [];
      list.forEach(h => { try { h.fn(...args); } catch (e) { console.error("[Plugin]", hook, e); } });
    },

    /** 触发可异步串行的钩子：每个回调返回 Promise，依次执行 */
    async emitAsync(hook, ...args) {
      const list = this._hooks[hook] || [];
      for (const h of list) {
        try { await h.fn(...args); } catch (e) { console.error("[Plugin]", hook, e); }
      }
    },

    /** 将插件暴露给全局 */
    exposeAPI(name, obj) {
      if (!global.plugins) global.plugins = {};
      global.plugins[name] = obj;
    },

    /** 加载单个插件 */
    async loadPlugin(manifest) {
      const id = manifest.id;
      if (this._plugins[id]) return;
      this._plugins[id] = { manifest, hooks: [], enabled: true };
      this._loadingPlugin = id;
      try {
        const script = document.createElement("script");
        script.src = "plugins/" + id + "/main.js";
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = () => reject(new Error("加载失败"));
          document.head.appendChild(script);
        });
      } catch (e) {
        this._plugins[id].enabled = false;
        console.error("[Plugin]", id, e.message);
      }
      this._loadingPlugin = null;
    },

    /** 加载所有插件 */
    async loadAll() {
      try {
        const res = await fetch("/api/plugins");
        const list = await res.json();
        for (const m of (Array.isArray(list) ? list : [])) {
          await this.loadPlugin(m);
        }
      } catch (e) {
        // 服务器不可用时静默
      }
      PluginManager.emit("pluginsLoaded");
    },

    /** 获取已加载的插件 */
    getPlugins() {
      return Object.values(this._plugins).map(p => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, enabled: p.enabled }));
    },
  };

  global.PluginManager = PluginManager;
  global.plugins = {};
})(window);