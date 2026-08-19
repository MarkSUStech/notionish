/* ============ MermaidR: Mermaid diagram rendering (CDN + graceful fallback) ============ */
(function (global) {
  "use strict";

  const MermaidR = {
    _loaded: typeof mermaid !== "undefined",
    _loading: false,
    _waiters: [],
    _idSeq: 0,

    ensure() {
      if (this._loaded || this._loading) return;
      this._loading = true;
      const urls = [
        "vendor/mermaid/mermaid.min.js",
        "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js",
        "https://unpkg.com/mermaid@10.9.1/dist/mermaid.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js",
      ];
      const loadFirst = (list, cb) => {
        if (!list.length) { cb(false); return; }
        const s = document.createElement("script");
        s.src = list[0];
        let settled = false;
        s.onload = () => { if (!settled) { settled = true; cb(true); } };
        s.onerror = () => { if (!settled) { settled = true; loadFirst(list.slice(1), cb); } };
        document.head.appendChild(s);
      };
      loadFirst(urls, (ok) => {
        this._loaded = ok && typeof mermaid !== "undefined";
        this._loading = false;
        this._flush();
      });
    },

    _flush() {
      const w = this._waiters;
      this._waiters = [];
      w.forEach(fn => { try { fn(); } catch (e) {} });
    },

    ready(cb) {
      if (this._loaded && typeof mermaid !== "undefined") { cb(); return; }
      this._waiters.push(cb);
      this.ensure();
    },

    isLoaded() { return this._loaded && typeof mermaid !== "undefined"; },

    render(source) {
      return new Promise(resolve => {
        if (!this.isLoaded()) { resolve({ ok: false, error: "Mermaid 库未加载（离线或网络受限）" }); return; }
        const id = "mmd-" + (++this._idSeq);
        try {
          mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
          const result = mermaid.render(id, String(source == null ? "" : source));
          if (result && typeof result.then === "function") {
            result.then(r => resolve({ ok: true, svg: r && r.svg || "", id }))
              .catch(e => resolve({ ok: false, error: (e && e.message) || "渲染失败" }));
          } else {
            resolve({ ok: true, svg: (result && result.svg) || "", id });
          }
        } catch (e) {
          resolve({ ok: false, error: (e && e.message) || "渲染失败" });
        }
      });
    },
  };

  global.MermaidR = MermaidR;
})(window);
