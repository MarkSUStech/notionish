/* ============ Theme: load theme.json + theme.user.json, apply CSS variables ============ */
(function (global) {
  "use strict";

  const Theme = {
    BASE_URL: "theme.json",
    USER_URL: "theme.user.json",
    cache: null,

    /** deep-merge two plain objects; override wins on scalars */
    deepMerge(base, override) {
      const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
      const out = {};
      const b = base && typeof base === "object" && !Array.isArray(base) ? base : {};
      const o = override && typeof override === "object" && !Array.isArray(override) ? override : {};
      Object.keys(b).forEach(k => {
        if (isObj(b[k]) && isObj(o[k])) out[k] = this.deepMerge(b[k], o[k]);
        else out[k] = o[k] !== undefined ? o[k] : b[k];
      });
      Object.keys(o).forEach(k => { if (!(k in out)) out[k] = o[k]; });
      return out;
    },

    mode() {
      const root = global.document && document.documentElement;
      return root && root.getAttribute && root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },

    applyVars(vars) {
      const root = global.document && document.documentElement;
      if (!root || !root.style || !root.style.setProperty) return;
      Object.keys(vars || {}).forEach(k => {
        if (vars[k] != null) root.style.setProperty("--" + k, vars[k]);
      });
    },

    applyCurrent() {
      const theme = this.cache || { light: {}, dark: {} };
      this.applyVars(theme[this.mode()] || {});
    },

    async load() {
      let base = { light: {}, dark: {} };
      try {
        const r = await fetch(this.BASE_URL);
        if (r.ok) base = await r.json();
      } catch (e) { /* keep CSS fallback defaults */ }
      let user = null;
      try {
        const r = await fetch(this.USER_URL);
        if (r.ok) user = await r.json();
      } catch (e) { /* no user override */ }
      this.cache = user ? this.deepMerge(base, user) : base;
      this.applyCurrent();
      return this.cache;
    },
  };

  global.Theme = Theme;
})(window);
