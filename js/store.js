/* ============ Data store: model, persistence, CRUD ============ */
(function (global) {
  "use strict";

  const LS_KEY = "notionish_v2";

  const PROP_TYPES = ["text", "number", "select", "multi_select", "date", "checkbox", "url", "relation", "rollup", "formula"];
  const BLOCK_TYPES = new Set(["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout", "divider", "code", "snippet", "mermaid", "question", "flashcard", "image", "embed", "pdf", "highlight", "pdfimage", "html", "bookmark", "file", "table", "equation", "page", "database", "toc", "template", "breadcrumb", "columns", "column"]);
  const SAFE_COLORS = new Set(["#787774", "#9f6b53", "#d9730d", "#caa63b", "#448361", "#337ea9", "#9065b0", "#c14c8d", "#d44c47", "#f1f1ef", "#f4eeee", "#fbecdd", "#fbf3db", "#edf3ec", "#e7f3f8", "#f6f3f9", "#faedf4", "#fdebec"]);

  function safeUrl(value, kind) {
    const s = typeof value === "string" ? value.trim() : "";
    if (!s) return null;
    if (kind === "image" && /^data:image\/[\w.+-]+;base64,/i.test(s)) return s;
    if (kind === "file" && /^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    return null;
  }

  function safeIcon(value) {
    const s = typeof value === "string" ? value.trim() : "";
    return s && !/[<>]/.test(s) && Array.from(s).length <= 8 ? s : null;
  }

  function normalizeSegments(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 10000).map(seg => {
      if (!seg || typeof seg !== "object") return { t: "" };
      const out = { t: typeof seg.t === "string" ? seg.t : "" };
      ["b", "i", "u", "s", "c"].forEach(k => { if (seg[k]) out[k] = 1; });
      if (typeof seg.math === "string") out.math = seg.math.slice(0, 10000);
      if (typeof seg.mention === "string") out.mention = seg.mention;
      const link = safeUrl(seg.link);
      if (link) out.link = link;
      if (SAFE_COLORS.has(seg.color)) out.color = seg.color;
      if (SAFE_COLORS.has(seg.bg)) out.bg = seg.bg;
      return out;
    });
  }

  function normalizeBlock(value, depth) {
    if (!value || typeof value !== "object" || depth > 20) return null;
    const type = BLOCK_TYPES.has(value.type) ? value.type : "paragraph";
    const attrs = value.attrs && typeof value.attrs === "object" ? value.attrs : {};
    const outAttrs = {};
    if (typeof attrs.language === "string") outAttrs.language = attrs.language.slice(0, 40);
    if (typeof attrs.source === "string") outAttrs.source = attrs.source.slice(0, 1000000);
    if (typeof attrs.name === "string") outAttrs.name = attrs.name.slice(0, 500);
    if (typeof attrs.title === "string") outAttrs.title = attrs.title.slice(0, 1000);
    if (typeof attrs.pageId === "string") outAttrs.pageId = attrs.pageId;
    if (typeof attrs.qid === "string") outAttrs.qid = attrs.qid;
    if (typeof attrs.fid === "string") outAttrs.fid = attrs.fid;
    if (typeof attrs.highlightId === "string") outAttrs.highlightId = attrs.highlightId;
    if (typeof attrs.sourcePageId === "string") outAttrs.sourcePageId = attrs.sourcePageId;
    if (typeof attrs.hlText === "string") outAttrs.hlText = attrs.hlText.slice(0, 5000);
    if (Number.isInteger(attrs.hlPage)) outAttrs.hlPage = Math.max(1, Math.min(10000, attrs.hlPage));
    if (typeof attrs.imageId === "string") outAttrs.imageId = attrs.imageId;
    if (Number.isInteger(attrs.imgPage)) outAttrs.imgPage = Math.max(1, Math.min(10000, attrs.imgPage));
    if (typeof attrs.imgThumb === "string") outAttrs.imgThumb = attrs.imgThumb.slice(0, 500000);
    if (Number.isInteger(attrs.cols)) outAttrs.cols = Math.max(1, Math.min(20, attrs.cols));
    if (typeof attrs.header === "boolean") outAttrs.header = attrs.header;
    if (Number.isInteger(attrs.page)) outAttrs.page = Math.max(1, Math.min(10000, attrs.page));
    const mediaKind = type === "image" ? "image" : (type === "file" || type === "pdf") ? "file" : null;
    const src = safeUrl(attrs.src, mediaKind);
    const url = safeUrl(attrs.url);
    if (src) outAttrs.src = src;
    if (url) outAttrs.url = url;
    const icon = safeIcon(attrs.icon);
    if (icon) outAttrs.icon = icon;
    if (Array.isArray(attrs.caption)) outAttrs.caption = normalizeSegments(attrs.caption);
    if (Array.isArray(attrs.rows)) outAttrs.rows = attrs.rows.slice(0, 1000).map(row => Array.isArray(row) ? row.slice(0, 50).map(normalizeSegments) : []);
    return {
      id: typeof value.id === "string" ? value.id : U.uid("blk"), type,
      text: normalizeSegments(value.text), checked: !!value.checked, folded: !!value.folded,
      indent: Math.max(0, Math.min(5, Number(value.indent) || 0)),
      children: Array.isArray(value.children) ? value.children.slice(0, 10000).map(x => normalizeBlock(x, depth + 1)).filter(Boolean) : [],
      attrs: outAttrs, color: SAFE_COLORS.has(value.color) ? value.color : null,
      comments: Array.isArray(value.comments) ? value.comments.slice(0, 1000).map(c => ({ id: typeof c.id === "string" ? c.id : U.uid("cm"), text: typeof c.text === "string" ? c.text.slice(0, 10000) : "", createdAt: Number(c.createdAt) || Date.now() })) : [],
    };
  }

  function normalizePage(value, fallbackId) {
    if (!value || typeof value !== "object") return null;
    const id = typeof value.id === "string" ? value.id : fallbackId;
    if (!id) return null;
    const database = !!value.database;
    const isCode = !!value.code;
    const page = {
      id, parentId: typeof value.parentId === "string" ? value.parentId : "root",
      title: normalizeSegments(value.title), icon: safeIcon(value.icon), cover: null,
      database, schema: null,
      code: isCode, codeData: isCode ? {
        language: ["python", "c", "cpp", "java"].includes(value.codeData && value.codeData.language) ? value.codeData.language : "python",
        source: typeof (value.codeData && value.codeData.source) === "string" ? value.codeData.source.slice(0, 1000000) : "",
      } : null,
      web: !!value.web,
      url: typeof value.url === "string" ? value.url.slice(0, 5000000) : "",
      pdf: !!value.pdf,
      page: (Number.isInteger(Number(value.page)) && Number(value.page) > 0) ? Math.min(10000, Number(value.page)) : 1,
      highlights: Array.isArray(value.highlights) ? value.highlights.slice(0, 5000).map(h => ({
        id: typeof h.id === "string" ? h.id : U.uid("hl"),
        page: Number.isInteger(h.page) ? h.page : 1,
        text: typeof h.text === "string" ? h.text.slice(0, 5000) : "",
        color: typeof h.color === "string" ? h.color : "#ffe58f",
        rects: Array.isArray(h.rects) ? h.rects.slice(0, 200).map(r => (Array.isArray(r) ? r.map(Number).slice(0, 4) : [])).filter(r => r.length === 4) : [],
      })).filter(h => h.id) : [],
      images: Array.isArray(value.images) ? value.images.slice(0, 500).map(im => ({
        id: typeof im.id === "string" ? im.id : U.uid("img"),
        page: Number.isInteger(im.page) ? im.page : 1,
        x: Number(im.x) || 0,
        y: Number(im.y) || 0,
        w: Number(im.w) || 0,
        h: Number(im.h) || 0,
        dataUrl: typeof im.dataUrl === "string" ? im.dataUrl.slice(0, 500000) : "",
      })).filter(im => im.id && im.dataUrl) : [],
      children: Array.isArray(value.children) ? value.children.slice(0, 10000).map(x => normalizeBlock(x, 0)).filter(Boolean) : [],
      props: value.props && typeof value.props === "object" && !Array.isArray(value.props) ? U.clone(value.props) : {},
      favorite: !!value.favorite, createdAt: Number(value.createdAt) || Date.now(), updatedAt: Number(value.updatedAt) || Date.now(),
      deleted: !!value.deleted, deletedAt: value.deletedAt == null ? null : Number(value.deletedAt) || null,
    };
    const cover = typeof value.cover === "string" && value.cover.startsWith("linear-gradient(") ? value.cover : safeUrl(value.cover, "image");
    if (cover) page.cover = cover;
    if (database) {
      const props = value.schema && Array.isArray(value.schema.props) ? value.schema.props : [];
      page.schema = { props: props.slice(0, 200).map(p => {
        const type = PROP_TYPES.includes(p && p.type) ? p.type : "text";
        const out = defaultProp(p && typeof p.name === "string" ? p.name.slice(0, 200) : "属性", type, p && typeof p.id === "string" ? p.id : null);
        out.options = p && Array.isArray(p.options) ? p.options.filter(x => typeof x === "string").slice(0, 500) : [];
        if (type === "relation") out.relation = { dbId: p.relation && typeof p.relation.dbId === "string" ? p.relation.dbId : null };
        if (type === "rollup") out.rollup = p.rollup && typeof p.rollup === "object" ? U.clone(p.rollup) : { relationPropId: null, targetPropId: null, aggregate: "count_all" };
        if (type === "formula") out.formula = { expr: p.formula && typeof p.formula.expr === "string" ? p.formula.expr.slice(0, 10000) : "" };
        return out;
      }) };
      if (!page.schema.props.length) page.schema.props.push(defaultProp("名称"));
      page.viewState = value.viewState && typeof value.viewState === "object" ? U.clone(value.viewState) : undefined;
    }
    return page;
  }

  function defaultProp(name, type, id) {
    return { id: id || U.uid("prop"), name: name || "属性", type: type || "text", options: [] };
  }

  function normalizeQuestion(value, fallbackId) {
    if (!value || typeof value !== "object") return null;
    const type = ["single", "multiple", "judge", "fill", "short_answer"].includes(value.type) ? value.type : "single";
    const answer = type === "multiple"
      ? (Array.isArray(value.answer) ? value.answer.filter(Number.isInteger).map(x => Math.max(0, x)).slice(0, 100) : [])
      : type === "judge" ? (value.answer === true)
      : type === "fill" ? (Array.isArray(value.answer) ? value.answer.filter(x => typeof x === "string").slice(0, 100) : (typeof value.answer === "string" ? value.answer : ""))
      : typeof value.answer === "string" || Number.isInteger(value.answer) ? value.answer : null;
    return {
      id: typeof value.id === "string" ? value.id : fallbackId || U.uid("q"),
      type,
      prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 10000) : "",
      options: ["single", "multiple"].includes(type) && Array.isArray(value.options) ? value.options.filter(x => typeof x === "string").slice(0, 100) : [],
      answer,
      explanation: typeof value.explanation === "string" ? value.explanation.slice(0, 10000) : "",
      pageId: typeof value.pageId === "string" ? value.pageId : null,
      blockId: typeof value.blockId === "string" ? value.blockId : null,
      createdAt: Number(value.createdAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
    };
  }

  function normalizeFlashcard(value, fallbackId) {
    if (!value || typeof value !== "object") return null;
    return {
      id: typeof value.id === "string" ? value.id : fallbackId || U.uid("f"),
      front: typeof value.front === "string" ? value.front.slice(0, 10000) : "",
      back: typeof value.back === "string" ? value.back.slice(0, 10000) : "",
      pageId: typeof value.pageId === "string" ? value.pageId : null,
      blockId: typeof value.blockId === "string" ? value.blockId : null,
      createdAt: Number(value.createdAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
    };
  }

  function newPage(parentId, opts) {
    opts = opts || {};
    const now = Date.now();
    return {
      id: U.uid("pg"),
      parentId: parentId || "root",
      title: opts.title ? [{ t: opts.title }] : [],
      icon: opts.icon || null,
      cover: opts.cover || null,
      database: !!opts.database,
      schema: opts.database ? { props: [defaultProp("名称"), defaultProp("状态", "select")] } : null,
      code: !!opts.code,
      codeData: opts.code ? { language: opts.language || "python", source: opts.source || "" } : null,
      web: !!opts.web,
      url: (opts.web || opts.pdf) && typeof opts.url === "string" ? opts.url : "",
      pdf: !!opts.pdf,
      page: (opts.pdf && Number.isInteger(opts.page) && opts.page > 0) ? opts.page : 1,
      highlights: [],
      images: [],
      children: [],
      props: {},
      favorite: false,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      deletedAt: null,
    };
  }

  function newBlock(type, text) {
    const b = {
      id: U.uid("blk"),
      type: type || "paragraph",
      text: typeof text === "string" && text ? [{ t: text }] : (Array.isArray(text) ? text : []),
      checked: false,
      folded: false,
      indent: 0,
      children: [],
      attrs: {},
      color: null,
    };
    if (type === "todo") b.checked = false;
    return b;
  }

  /* ---------------- formula engine (safe, no eval) ---------------- */
  const Formula = (function () {
    function tokenize(src) {
      const s = String(src == null ? "" : src);
      const toks = [];
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"' || c === "'") {
          const q = c; let j = i + 1, out = "";
          while (j < s.length && s[j] !== q) {
            if (s[j] === "\\" && j + 1 < s.length) { out += s[j + 1]; j += 2; }
            else { out += s[j]; j++; }
          }
          toks.push({ t: "str", v: out });
          i = j + 1;
          continue;
        }
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] || ""))) {
          let j = i, dot = false;
          while (j < s.length && (/[0-9]/.test(s[j]) || (s[j] === "." && !dot))) { if (s[j] === ".") dot = true; j++; }
          toks.push({ t: "num", v: parseFloat(s.slice(i, j)) });
          i = j;
          continue;
        }
        if (/[a-zA-Z_\u4e00-\u9fa5]/.test(c)) {
          let j = i;
          while (j < s.length && /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(s[j])) j++;
          toks.push({ t: "word", v: s.slice(i, j) });
          i = j;
          continue;
        }
        const two = s.slice(i, i + 2);
        if (["==", "!=", "<=", ">=", "&&", "||"].indexOf(two) >= 0) { toks.push({ t: two }); i += 2; continue; }
        if ("+-*/%<>!(),".indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
        i++;
      }
      return toks;
    }

    function toNum(v) { if (typeof v === "number") return v; if (v === true) return 1; if (v === false) return 0; const n = parseFloat(v); return isNaN(n) ? 0 : n; }
    function toStr(v) {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      if (Array.isArray(v)) return v.map(toStr).join(", ");
      return String(v);
    }
    function toBool(v) {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") return v.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      return !!v;
    }
    function cmp(op, a, b) {
      if (op === "==") return a == b;
      if (op === "!=") return a != b;
      const x = toNum(a), y = toNum(b);
      if (op === "<") return x < y;
      if (op === "<=") return x <= y;
      if (op === ">") return x > y;
      if (op === ">=") return x >= y;
      return false;
    }

    function parse(toks, scope) {
      let p = 0;
      const peek = () => toks[p];
      const next = () => toks[p++];
      function callFn(name, args) {
        switch (name) {
          case "prop": return scope ? scope.get(toStr(args[0])) : null;
          case "if": return args.length >= 3 ? (toBool(args[0]) ? args[1] : args[2]) : (toBool(args[0]) ? args[1] : null);
          case "concat": return args.map(toStr).join("");
          case "round": { const n = toNum(args[0]); const d = args[1] == null ? 0 : Math.max(0, Math.min(10, Math.floor(toNum(args[1])))); const f = Math.pow(10, d); return Math.round(n * f) / f; }
          case "floor": return Math.floor(toNum(args[0]));
          case "ceil": return Math.ceil(toNum(args[0]));
          case "abs": return Math.abs(toNum(args[0]));
          case "max": return Math.max.apply(null, args.map(toNum));
          case "min": return Math.min.apply(null, args.map(toNum));
          case "length": { const a = args[0]; return Array.isArray(a) ? a.length : toStr(a).length; }
          case "empty": return !toBool(args[0]);
          case "toNumber": return toNum(args[0]);
          case "now": return Date.now();
          case "format": return toStr(args[0]);
          case "contains": return toStr(args[0]).indexOf(toStr(args[1])) >= 0;
          case "join": return Array.isArray(args[0]) ? args[0].map(toStr).join(toStr(args[1] || ", ")) : toStr(args[0]);
          case "lower": return toStr(args[0]).toLowerCase();
          case "upper": return toStr(args[0]).toUpperCase();
          case "trim": return toStr(args[0]).trim();
          case "replace": return toStr(args[0]).split(toStr(args[1])).join(toStr(args[2]));
          default: throw new Error("未知函数：" + name);
        }
      }
      function expr() { return or(); }
      function or() {
        let left = and();
        while (peek() && (peek().t === "||" || (peek().t === "word" && peek().v === "or"))) { next(); left = toBool(left) || toBool(and()); }
        return left;
      }
      function and() {
        let left = c();
        while (peek() && (peek().t === "&&" || (peek().t === "word" && peek().v === "and"))) { next(); left = toBool(left) && toBool(c()); }
        return left;
      }
      function c() {
        let left = add();
        while (peek() && ["==", "!=", "<", "<=", ">", ">="].indexOf(peek().t) >= 0) {
          const op = next().t; left = cmp(op, left, add());
        }
        return left;
      }
      function add() {
        let left = mul();
        while (peek() && (peek().t === "+" || peek().t === "-")) {
          const op = next().t; const right = mul();
          if (op === "+" && (typeof left === "string" || typeof right === "string")) left = toStr(left) + toStr(right);
          else if (op === "+") left = toNum(left) + toNum(right);
          else left = toNum(left) - toNum(right);
        }
        return left;
      }
      function mul() {
        let left = unary();
        while (peek() && ["*", "/", "%"].indexOf(peek().t) >= 0) {
          const op = next().t; const right = unary();
          if (op === "*") left = toNum(left) * toNum(right);
          else if (op === "/") { const d = toNum(right); left = d === 0 ? 0 : toNum(left) / d; }
          else { const d = toNum(right); left = d === 0 ? 0 : toNum(left) % d; }
        }
        return left;
      }
      function unary() {
        if (peek() && peek().t === "!") { next(); return !toBool(unary()); }
        if (peek() && peek().t === "-") { next(); return -toNum(unary()); }
        if (peek() && peek().t === "+") { next(); return toNum(unary()); }
        if (peek() && peek().t === "word" && peek().v === "not") { next(); return !toBool(unary()); }
        return primary();
      }
      function primary() {
        const tk = peek();
        if (!tk) throw new Error("公式不完整");
        if (tk.t === "num") { next(); return tk.v; }
        if (tk.t === "str") { next(); return tk.v; }
        if (tk.t === "(") { next(); const v = expr(); if (peek() && peek().t === ")") next(); return v; }
        if (tk.t === "word") {
          next();
          const name = tk.v;
          if (name === "true") return true;
          if (name === "false") return false;
          if (name === "null") return null;
          if (peek() && peek().t === "(") {
            next();
            const args = [];
            if (peek() && peek().t !== ")") {
              args.push(expr());
              while (peek() && peek().t === ",") { next(); args.push(expr()); }
            }
            if (peek() && peek().t === ")") next();
            return callFn(name, args);
          }
          return scope ? scope.get(name) : null;
        }
        throw new Error("无法解析公式");
      }
      return expr();
    }

    return { eval: function (src, scope) { return parse(tokenize(src), scope || null); } };
  })();

  /* ---------- IndexedDB persistence (large content: PDF / images / files) ---------- */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("no-indexeddb")); return; }
      const req = indexedDB.open("notionish_store", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("indexeddb-blocked"));
    });
  }

  function idbGet(key) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => { try { db.close(); } catch (e) {} };
    }));
  }

  function idbPut(key, value) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => { try { db.close(); } catch (e) {}; resolve(); };
      tx.onerror = () => { try { db.close(); } catch (e) {}; reject(tx.error); };
    }));
  }

  const Store = {
    LS_KEY,
    PROP_TYPES,

    state: null,
    currentPageId: null,
    dirty: false,

    async boot() {
      try { localStorage.removeItem("notionish_v1"); } catch (e) {} // 清理旧版数据
      let saved = null;
      let fromFallback = false;
      // 主存储：服务端文件（浏览器和 Electron 共享）
      try {
        const res = await fetch("/api/state");
        const json = await res.json();
        if (json && json.pages) saved = json;
      } catch (e) { saved = null; }
      // 回退：IndexedDB（本地）
      if (!saved || !saved.pages) {
        try {
          const raw = await idbGet("workspace");
          if (raw) saved = JSON.parse(raw);
        } catch (e) { saved = null; }
      }
      // 回退：localStorage（旧数据迁移 / 小数据）
      if (!saved || !saved.pages) {
        try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { saved = null; }
        if (saved && saved.pages) fromFallback = true;
      }
      if (saved && saved.pages) {
        this.state = saved;
        this.migrate(fromFallback);
      } else {
        this.state = this.seed();
      }
      this.applyTheme();
      this.applyLayout();
      const s0 = JSON.stringify(this.state);
      this._lastJson = s0;
      this.history = { undo: [s0], redo: [], last: s0 };
      return this;
    },

    migrate(forcePersist) {
      // Normalize persisted data from older local workspace versions.
      const s = this.state;
      s.pages = s.pages || {};
      s.settings = s.settings || {};
      if (!s.settings.theme) s.settings.theme = "light";
      if (!s.settings.pageWidth) s.settings.pageWidth = "760px";
      if (s.settings.lineHeight == null) s.settings.lineHeight = 1.62;
      if (!s.settings.fontFamily) s.settings.fontFamily = "default";
      if (s.settings.fontSize == null) s.settings.fontSize = 16;
      s.trashOrder = s.trashOrder || [];
      s.reminders = s.reminders || [];
      s.versions = s.versions || {};
      s.templates = s.templates || [];
      s.questions = s.questions || {};
      s.flashcards = s.flashcards || {};
      Object.values(s.pages).forEach(p => {
        if (!p.children) p.children = [];
        if (!p.props) p.props = {};
        if (p.deleted == null) p.deleted = false;
        if (!p.schema) p.schema = null;
        if (p.database && (!p.schema || !p.schema.props)) p.schema = { props: [defaultProp("名称"), defaultProp("状态", "select")] };
      });
      s.questions = Object.fromEntries(Object.entries(s.questions).map(([id, q]) => [id, normalizeQuestion(q, id)]).filter(([, q]) => q));
      s.flashcards = Object.fromEntries(Object.entries(s.flashcards).map(([id, f]) => [id, normalizeFlashcard(f, id)]).filter(([, f]) => f));
      // 迁移：确保「试卷」文件夹存在于 root 下（旧数据库转普通文件夹，或新建）
      if (!s._examFolderMigrated) {
        let examFolder = Object.values(s.pages).find(p => p.parentId === "root" && !p.deleted && U.segsText(p.title) === "试卷");
        if (examFolder) {
          // 旧数据库转普通文件夹
          if (examFolder.database) { examFolder.database = false; examFolder.schema = null; }
        } else {
          // 不存在则新建
          examFolder = { id: U.uid("pg"), createdAt: Date.now(), updatedAt: Date.now(), parentId: "root", title: [{ t: "试卷" }], icon: "📋", children: [], props: {}, database: false, schema: null, order: 99, deleted: false, deletedAt: null };
          s.pages[examFolder.id] = examFolder;
        }
        s._examFolderMigrated = true;
        forcePersist = true;
      }
      // 数据若已来自 IndexedDB，则此前已持久化；仅当从 localStorage 回退迁移时才需要立即落盘，
      // 避免每次启动都对整份工作区做一次冗余的全量序列化与写入。
      if (forcePersist) this.save(true);
    },
    seed() {
      const blk = (type, text, extra) => Object.assign(newBlock(type, text), extra || {});

      // ── 1. 欢迎页 ──
      const welcome = newPage("root", { title: "欢迎使用 Notionish", icon: "👋", cover: "linear-gradient(135deg,#667eea 0%,#764ba2 100%)" });
      welcome.order = 0;
      const wT1 = blk("toggle", "⌨️ 输入方式");
      wT1.children = [
        blk("bullet", "输入 / 呼出块菜单，插入标题、列表、待办、代码、表格、公式等 20+ 种块"),
        blk("bullet", "输入 # - 1. [] > 后按空格，快速 Markdown 转换"),
        blk("bullet", "选中文字弹出格式工具栏：加粗、斜体、下划线、颜色、链接"),
      ];
      const wT2 = blk("toggle", "🖱 操作技巧");
      wT2.children = [
        blk("bullet", "悬停块左侧 ⋮⋮ 手柄 → 拖拽排序、嵌套、多选批量删除"),
        blk("bullet", "右键块 → 转换为其他类型、复制、移至其他页面"),
        blk("bullet", "Ctrl+K 全文搜索 · Ctrl+N 新建页面 · Ctrl+\\ 切换主题"),
      ];
      welcome.children = [
        blk("heading1", "欢迎来到 Notionish 🎉"),
        blk("paragraph", "一款完全在浏览器本地运行的 Notion 风格笔记应用。数据保存在你自己的设备上，离线可用、随取随写。"),
        blk("callout", "想快速上手？展开下面的小抄，或者用右上角的 AI 助手直接说「帮我写一篇笔记」。", { attrs: { icon: "🚀" } }),
        blk("heading2", "✨ 快速上手"),
        wT1,
        wT2,
        blk("divider"),
        blk("heading2", "∑ 数学公式"),
        blk("paragraph", "行内公式：质能方程 $E = mc^2$，欧拉公式 $e^{i\\pi} + 1 = 0$。"),
        blk("equation", "$$\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}$$"),
        blk("heading2", "🗄 数据库"),
        blk("paragraph", "左侧的「项目任务看板」是一个数据库，支持表格 / 看板 / 列表 / 画廊 / 日历 / 时间线六种视图，并可添加筛选与排序。"),
        blk("quote", "先写起来，再慢慢变好。"),
      ];

      // ── 2. 项目任务看板（数据库） ──
      const tasks = newPage("root", { title: "项目任务看板", icon: "🗄", database: true, cover: "linear-gradient(135deg,#f093fb 0%,#f5576c 100%)" });
      tasks.order = 1;
      tasks.schema = { props: [
        defaultProp("名称", "text"),
        defaultProp("状态", "select", "prop_status"),
        defaultProp("优先级", "select", "prop_prio"),
        defaultProp("负责人", "text"),
        defaultProp("截止日期", "date"),
        defaultProp("进度", "number"),
      ] };
      tasks.schema.props[1].options = ["待办", "进行中", "已完成"];
      tasks.schema.props[2].options = ["低", "中", "高", "紧急"];
      const pStatus = tasks.schema.props[1], pPrio = tasks.schema.props[2];
      const pOwner = tasks.schema.props[3], pDate = tasks.schema.props[4], pProgress = tasks.schema.props[5];
      const rowDefs = [
        ["完成产品需求文档", "已完成", "高", "李明", "2025-01-06", 100],
        ["搭建应用骨架", "已完成", "高", "王芳", "2025-01-10", 100],
        ["实现块编辑器", "进行中", "高", "张伟", "2025-01-18", 65],
        ["实现数据库六视图", "进行中", "中", "张伟", "2025-01-25", 40],
        ["编写使用文档", "待办", "低", "赵敏", null, 0],
        ["发布 1.0 版本", "待办", "紧急", "全员", "2025-02-01", 0],
      ];
      const rowPages = [];
      rowDefs.forEach((rr, i) => {
        const row = newPage(tasks.id, { title: rr[0], icon: ["📝", "🏗", "🧱", "🗄", "📄", "🚀"][i] });
        row.order = i;
        row.props = {};
        row.props[pStatus.id] = rr[1];
        row.props[pPrio.id] = rr[2];
        row.props[pOwner.id] = rr[3];
        row.props[pDate.id] = rr[4];
        row.props[pProgress.id] = rr[5];
        if (i === 2) row.children = [blk("todo", "完成 contenteditable 序列化与回车拆分", { checked: true }), blk("bullet", "斜杠菜单 + Markdown 快捷输入")];
        if (i === 3) row.children = [blk("todo", "表格视图 + 属性编辑", { checked: true }), blk("bullet", "看板 / 日历 / 时间线视图")];
        rowPages.push(row);
      });

      // ── 3. 产品例会纪要 ──
      const notes = newPage("root", { title: "产品例会纪要", icon: "📝", cover: "linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)" });
      notes.order = 2;
      const toggle = blk("toggle", "一、上周进展");
      toggle.children = [
        blk("bullet", "块编辑器已完成富文本序列化"),
        blk("bullet", "数据库公式 / 关联 / 汇总上线"),
      ];
      notes.children = [
        blk("heading1", "产品例会纪要 · 第 12 次"),
        blk("paragraph", "时间：2025 年 1 月 14 日 10:00 · 地点：线上会议 · 记录人：赵敏"),
        toggle,
        blk("heading2", "二、本周计划"),
        blk("todo", "发布 beta 测试版"),
        blk("todo", "补齐导出 Markdown / PDF"),
        blk("heading2", "三、待决策事项"),
        blk("table", null, { attrs: { cols: 3, header: true, rows: [
          [{ t: "议题" }, { t: "负责人" }, { t: "状态" }],
          [{ t: "是否加入实时协作" }, { t: "李明" }, { t: "待定" }],
          [{ t: "主题色方案" }, { t: "王芳" }, { t: "已定：保持简洁" }],
        ] } }),
        blk("heading2", "四、技术备忘"),
        blk("code", null, { attrs: { language: "javascript", source: "// 示例：保存逻辑\nfunction save() {\n  localStorage.setItem('data', JSON.stringify(state));\n}" } }),
        blk("quote", "先做减法，把核心体验做到 90 分，再谈扩展。"),
        blk("callout", "下次会议：2025-01-21 10:00", { attrs: { icon: "📅" } }),
      ];

      // ── 4. 公式速查 ──
      const formula = newPage("root", { title: "公式速查", icon: "🧮", cover: "linear-gradient(135deg,#43e97b 0%,#38f9d7 100%)" });
      formula.order = 3;
      formula.children = [
        blk("heading1", "LaTeX 公式速查"),
        blk("paragraph", "行内公式用一对美元符号，行间公式用两对美元符号（回车后渲染）。"),
        blk("heading2", "常用公式"),
        blk("equation", "$$E = mc^2$$"),
        blk("equation", "$$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$"),
        blk("equation", "$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$"),
        blk("equation", "$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$"),
        blk("heading2", "行内示例"),
        blk("paragraph", "极限 $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$，积分 $\\int_0^1 x^2 \\, dx = \\frac{1}{3}$，集合 $A \\cup B$。"),
      ];

      // ── 5. 试卷（文件夹） ──
      const exam = newPage("root", { title: "试卷", icon: "📋", cover: "linear-gradient(135deg,#a18cd1 0%,#fbc2eb 100%)" });
      exam.order = 4;
      exam.children = [
        blk("paragraph", "这里存放 AI 生成的试卷。使用 AI 助手的「出试卷」工具，AI 会从题库中 RAG 检索相关题目并自动组卷。"),
      ];

      // ── 6. 灵感收藏 ──
      const ideas = newPage("root", { title: "灵感收藏", icon: "💡", cover: "linear-gradient(135deg,#fa709a 0%,#fee140 100%)" });
      ideas.order = 5;
      const iT1 = blk("toggle", "📚 想读的书");
      iT1.children = [
        blk("todo", "《黑客与画家》", { checked: true }),
        blk("todo", "《设计中的设计》"),
        blk("todo", "《奇点临近》"),
      ];
      const iT2 = blk("toggle", "✍️ 写作灵感");
      iT2.children = [
        blk("bullet", "本地优先应用为什么值得做？"),
        blk("bullet", "从零写一个编辑器学到的 10 件事"),
        blk("bullet", "AI 辅助笔记的边界在哪里"),
      ];
      ideas.children = [
        blk("heading1", "灵感收藏 💡"),
        blk("quote", "想象力比知识更重要。—— 爱因斯坦"),
        blk("callout", "任何想法都可以先记在这里，稍后再整理成正式笔记。", { attrs: { icon: "📌" } }),
        blk("heading2", "想做的事"),
        blk("todo", "每天写 10 分钟日记", { checked: true }),
        blk("todo", "维护一个公开的技术博客"),
        iT1,
        iT2,
        blk("divider"),
        blk("callout", "灵感会过期，记下来才是你的。", { attrs: { icon: "⏳" } }),
      ];

      const pages = {};
      [welcome, tasks, notes, formula, exam, ideas].concat(rowPages).forEach(p => pages[p.id] = p);
      return {
        pages,
        settings: { theme: "light", pageWidth: "760px", lineHeight: 1.62, fontFamily: "default", fontSize: 16 },
        trashOrder: [],
        reminders: [],
        versions: {},
        templates: [],
        questions: {},
        flashcards: {},
        seq: 0,
      };
    },

    save(force) {
      if (!force && !this.dirty) return;
      this.dirty = false;
      const json = JSON.stringify(this.state);
      this._lastJson = json;
      // 主存储：服务端文件（浏览器和 Electron 共享，防抖 2s）
      if (!this._serverSaveTimer) {
        this._serverSaveTimer = setTimeout(() => {
          this._serverSaveTimer = null;
          fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.state) }).catch(e => {});
        }, 2000);
      }
      // 镜像：IndexedDB（本地备份）
      if (typeof indexedDB !== "undefined") {
        idbPut("workspace", json).catch(e => console.error("IndexedDB 保存失败", e));
      }
      // 镜像：localStorage（尽力而为，用于跨标签页同步与旧版兼容）
      if (json.length <= 5 * 1024 * 1024) {
        try { localStorage.setItem(LS_KEY, json); } catch (e) { /* 满时忽略，IndexedDB 已保存 */ }
      }
    },

    markDirty() {
      this.dirty = true;
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.save(), 400);
      if (!this._snapPending) this._snapPending = true;
      if (this._snapTimer) clearTimeout(this._snapTimer);
      this._snapTimer = setTimeout(() => this.commitHistory(), 800);
    },

    commitHistory() {
      if (!this.history) return;
      if (this._snapTimer) clearTimeout(this._snapTimer);
      this._snapTimer = null;
      this._snapPending = false;
      // 自上次 save 后若无新改动，复用已序列化的字符串，避免重复全量 JSON.stringify。
      const current = (!this.dirty && this._lastJson) ? this._lastJson : JSON.stringify(this.state);
      if (current !== this.history.last) {
        this.history.undo.push(current);
        if (this.history.undo.length > 120) this.history.undo.shift();
        this.history.last = current;
        this.history.redo = [];
      }
      const pid = this.currentPageId;
      if (pid) this.recordVersion(this.getPage(pid));
    },

    /* ---------- undo / redo (in-memory) ---------- */
    undo() {
      if (!this.history) return false;
      this.commitHistory();
      if (this.history.undo.length <= 1) return false;
      const current = this.history.undo.pop();
      this.history.redo.push(current);
      const previous = this.history.undo[this.history.undo.length - 1];
      this.state = JSON.parse(previous);
      this.history.last = previous;
      this.save(true);
      return true;
    },
    redo() {
      if (!this.history) return false;
      this.commitHistory();
      if (!this.history.redo.length) return false;
      const next = this.history.redo.pop();
      this.history.undo.push(next);
      this.state = JSON.parse(next);
      this.history.last = next;
      this.save(true);
      return true;
    },

    /* ---------- version history (persisted, coarse) ---------- */
    recordVersion(page) {
      if (!page) return;
      const data = { title: U.clone(page.title), children: U.clone(page.children), props: U.clone(page.props), schema: U.clone(page.schema) };
      const versions = this.state.versions = this.state.versions || {};
      const arr = versions[page.id] || (versions[page.id] = []);
      const last = arr[arr.length - 1];
      if (last && JSON.stringify(last.data) === JSON.stringify(data)) return;
      arr.push({ at: Date.now(), data });
      if (arr.length > 10) arr.shift();
    },
    getVersions(pageId) {
      return (this.state.versions && this.state.versions[pageId] || []).slice().reverse();
    },
    restoreVersion(pageId, at) {
      const arr = this.state.versions && this.state.versions[pageId] || [];
      const v = arr.find(x => x.at === at);
      const page = this.getPage(pageId);
      if (!v || !page) return false;
      page.title = U.clone(v.data.title);
      page.children = U.clone(v.data.children);
      page.props = U.clone(v.data.props);
      if (v.data.schema) page.schema = U.clone(v.data.schema);
      this.touch(page);
      this.markDirty();
      return true;
    },

    applyTheme() {
      document.documentElement.setAttribute("data-theme", this.state.settings.theme || "light");
      if (global.Theme && global.Theme.applyCurrent) global.Theme.applyCurrent();
    },

    /** 应用布局设置（页宽 / 行间距 / 字号 / 字体）为 CSS 变量 */
    applyLayout() {
      const s = this.state.settings || {};
      const root = document.documentElement;
      if (!root || !root.style || !root.style.setProperty) return;
      root.style.setProperty("--page-width", s.pageWidth || "760px");
      root.style.setProperty("--line-height", String(s.lineHeight == null ? 1.62 : s.lineHeight));
      // 字体
      const fontMap = {
        default: '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "SimSun", serif',
        mono: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
        hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Hiragino Sans GB", sans-serif',
        song: '"Noto Serif SC", "Source Han Serif SC", "SimSun", "STSong", serif',
        kai: '"KaiTi", "STKaiti", "AR PL UKai CN", "Kai", serif',
      };
      const ff = fontMap[s.fontFamily] || fontMap.default;
      root.style.setProperty("--font-editor", ff);
      root.style.setProperty("--font-ui", ff);
      root.style.setProperty("--editor-font-size", (s.fontSize || 16) + "px");
    },

    /* ---------- page lookups ---------- */
    getPage(id) { return this.state.pages[id] || null; },

    getRootPages() {
      return Object.values(this.state.pages)
        .filter(p => p.parentId === "root" && !p.deleted)
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
    },

    getChildren(pageId) {
      return Object.values(this.state.pages)
        .filter(p => p.parentId === pageId && !p.deleted)
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
    },

    /** all non-deleted pages (for search / link picker) */
    allPages() {
      return Object.values(this.state.pages).filter(p => !p.deleted);
    },

    /** breadcrumb chain: [root..., page] */
    breadcrumb(pageId) {
      const chain = [];
      let cur = this.getPage(pageId);
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        chain.unshift(cur);
        cur = cur.parentId === "root" ? null : this.getPage(cur.parentId);
      }
      return chain;
    },

    /** nested tree of pages for sidebar */
    pageTree() {
      const build = (parentId) => this.getChildren(parentId).map(p => ({ page: p, children: build(p.id) }));
      return build("root");
    },

    /* ---------- page CRUD ---------- */
    createPage(parentId, opts) {
      opts = opts || {};
      const p = newPage(parentId, opts);
      // assign order at end
      const sibs = this.getChildren(parentId);
      p.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
      this.state.pages[p.id] = p;
      this.markDirty();
      return p;
    },

    codeExtension(language) {
      return ({ python: ".py", c: ".c", cpp: ".cpp", java: ".java" })[language] || ".txt";
    },

    setCodeSource(id, source) {
      const p = this.getPage(id);
      if (!p || !p.codeData) return false;
      p.codeData.source = String(source == null ? "" : source);
      this.markDirty();
      return true;
    },

    /** collect a code project: entry page plus descendant code files, flat */
    collectCodeProject(pageId) {
      const entry = this.getPage(pageId);
      if (!entry || !entry.code) return null;
      const files = [];
      const used = {};
      const push = (page) => {
        const language = (page.codeData && page.codeData.language) || entry.codeData.language || "python";
        const base = (U.segsText(page.title).trim() || "main").replace(/[\\/:*?"<>|]/g, "_");
        const ext = this.codeExtension(language);
        let name = base + ext, i = 2;
        while (used[name]) name = base + "_" + (i++) + ext;
        used[name] = true;
        files.push({ path: name, language, content: (page.codeData && page.codeData.source) || "", isEntry: page.id === entry.id });
      };
      push(entry);
      const walk = (list) => list.forEach(child => { if (child.code) push(child); walk(this.getChildren(child.id)); });
      walk(this.getChildren(entry.id));
      return { entry: files[0].path, language: entry.codeData.language || "python", files };
    },

    /** pure table row/column mutation; returns normalized { rows, cols } */
    tableMutate(rows, cols, op, index) {
      const norm = (r) => (Array.isArray(r) ? r : []).map(c => Array.isArray(c) ? c : (c ? [c] : []));
      rows = (Array.isArray(rows) ? rows : []).map(norm);
      cols = Math.max(1, cols || (rows[0] ? rows[0].length : 2));
      rows.forEach(r => { while (r.length < cols) r.push([{ t: "" }]); r.length = cols; });
      if (op === "addRow") {
        const row = []; for (let i = 0; i < cols; i++) row.push([{ t: "" }]);
        const at = index == null ? rows.length : Math.min(rows.length, Math.max(0, index + 1));
        rows.splice(at, 0, row);
      } else if (op === "addCol") {
        const at = index == null ? cols : Math.min(cols, Math.max(0, index + 1));
        rows.forEach(r => r.splice(at, 0, [{ t: "" }]));
        cols += 1;
      } else if (op === "delRow") {
        if (rows.length > 1) rows.splice(Math.max(0, Math.min(rows.length - 1, index == null ? rows.length - 1 : index)), 1);
      } else if (op === "delCol") {
        if (cols > 1) {
          const at = Math.max(0, Math.min(cols - 1, index == null ? cols - 1 : index));
          rows.forEach(r => r.splice(at, 1));
          cols -= 1;
        }
      }
      return { rows, cols };
    },

    /* ---------- central question & flashcard storage ---------- */
    createQuestion(pageId, blockId, data) {
      data = data || {};
      const q = {
        id: U.uid("q"),
        type: ["single", "multiple", "judge", "fill", "short_answer"].includes(data.type) ? data.type : "single",
        prompt: typeof data.prompt === "string" ? data.prompt : "",
        options: Array.isArray(data.options) ? data.options.filter(x => typeof x === "string") : [],
        answer: data.answer == null ? null : data.answer,
        explanation: typeof data.explanation === "string" ? data.explanation : "",
        pageId: pageId || null, blockId: blockId || null, createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.state.questions = this.state.questions || {};
      this.state.questions[q.id] = normalizeQuestion(q, q.id);
      const page = this.getPage(pageId);
      const blk = page && blockId ? this.findBlock(page, blockId) : null;
      if (blk) blk.attrs.qid = q.id;
      this.markDirty();
      return q;
    },
    updateQuestion(id, patch) {
      const q = this.state.questions && this.state.questions[id];
      if (!q || !patch) return null;
      if (patch.type && ["single", "multiple", "judge", "fill", "short_answer"].includes(patch.type)) q.type = patch.type;
      if (typeof patch.prompt === "string") q.prompt = patch.prompt;
      if (Array.isArray(patch.options)) q.options = patch.options.filter(x => typeof x === "string");
      if ("answer" in patch) q.answer = patch.answer;
      if (typeof patch.explanation === "string") q.explanation = patch.explanation;
      q.updatedAt = Date.now();
      this.state.questions[id] = normalizeQuestion(q, id);
      this.markDirty();
      return this.state.questions[id];
    },
    deleteQuestion(id) {
      if (!this.state.questions || !this.state.questions[id]) return false;
      delete this.state.questions[id];
      this.markDirty();
      return true;
    },
    getQuestion(id) { return (this.state.questions && this.state.questions[id]) || null; },
    getQuestions() { return Object.values(this.state.questions || {}).sort((a, b) => a.createdAt - b.createdAt); },

    /** 创建题目块并插入页面末尾，关联中央存储的题目（AI 生成题目时使用） */
    createQuestionBlock(pageId, data) {
      const page = this.getPage(pageId);
      if (!page) return null;
      const blk = newBlock("question");
      this.insertBlock(page, blk);
      const question = this.createQuestion(pageId, blk.id, data);
      return { block: blk, question };
    },

    createFlashcard(pageId, blockId, data) {
      data = data || {};
      const f = {
        id: U.uid("f"),
        front: typeof data.front === "string" ? data.front : "",
        back: typeof data.back === "string" ? data.back : "",
        pageId: pageId || null, blockId: blockId || null, createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.state.flashcards = this.state.flashcards || {};
      this.state.flashcards[f.id] = normalizeFlashcard(f, f.id);
      const page = this.getPage(pageId);
      const blk = page && blockId ? this.findBlock(page, blockId) : null;
      if (blk) blk.attrs.fid = f.id;
      this.markDirty();
      return f;
    },
    updateFlashcard(id, patch) {
      const f = this.state.flashcards && this.state.flashcards[id];
      if (!f || !patch) return null;
      if (typeof patch.front === "string") f.front = patch.front;
      if (typeof patch.back === "string") f.back = patch.back;
      f.updatedAt = Date.now();
      this.state.flashcards[id] = normalizeFlashcard(f, id);
      this.markDirty();
      return this.state.flashcards[id];
    },
    deleteFlashcard(id) {
      if (!this.state.flashcards || !this.state.flashcards[id]) return false;
      delete this.state.flashcards[id];
      this.markDirty();
      return true;
    },
    getFlashcard(id) { return (this.state.flashcards && this.state.flashcards[id]) || null; },
    getFlashcards() { return Object.values(this.state.flashcards || {}).sort((a, b) => a.createdAt - b.createdAt); },

    /** 创建闪卡块并插入页面末尾，关联中央存储的闪卡（AI 生成闪卡时使用） */
    createFlashcardBlock(pageId, data) {
      const page = this.getPage(pageId);
      if (!page) return null;
      const blk = newBlock("flashcard");
      this.insertBlock(page, blk);
      const flashcard = this.createFlashcard(pageId, blk.id, data);
      return { block: blk, flashcard };
    },

    /** find all blocks (across pages) that reference a PDF highlight id */
    findHighlightRefs(highlightId) {
      const refs = [];
      const walk = (page, blocks) => (blocks || []).forEach(b => {
        if (b.attrs && b.attrs.highlightId === highlightId) refs.push({ pageId: page.id, blockId: b.id, text: b.attrs.hlText || "" });
        if (b.children && b.children.length) walk(page, b.children);
      });
      Object.values(this.state.pages || {}).forEach(p => { if (!p.deleted) walk(p, p.children); });
      return refs;
    },

    /** find all blocks (across pages) that reference a PDF image id */
    findImageRefs(imageId) {
      const refs = [];
      const walk = (page, blocks) => (blocks || []).forEach(b => {
        if (b.attrs && b.attrs.imageId === imageId) refs.push({ pageId: page.id, blockId: b.id });
        if (b.children && b.children.length) walk(page, b.children);
      });
      Object.values(this.state.pages || {}).forEach(p => { if (!p.deleted) walk(p, p.children); });
      return refs;
    },

    deletePage(id, permanent) {
      const p = this.getPage(id);
      if (!p) return false;
      if (permanent) {
        // 递归永久删除子页面
        Object.values(this.state.pages).filter(c => c.parentId === id).forEach(c => this.deletePage(c.id, true));
        // 从父级的 children 数组中移除
        if (p.parentId) {
          const parent = this.getPage(p.parentId);
          if (parent && parent.children) {
            parent.children = parent.children.filter(c => c.id !== id);
          }
        }
        delete this.state.pages[id];
        if (this.state.versions) delete this.state.versions[id];
        this.state.reminders = (this.state.reminders || []).filter(r => r.pageId !== id);
        this.state.trashOrder = (this.state.trashOrder || []).filter(tid => tid !== id);
      } else {
        this.setPageDeleted(id, true);
      }
      this.markDirty();
      return true;
    },

    setPageDeleted(id, deleted) {
      const p = this.getPage(id);
      if (!p) return;
      if (deleted) {
        this.trashPage(p);
      } else {
        this.restorePage(p);
      }
      this.markDirty();
    },

    trashPage(p) {
      p.deleted = true;
      p.deletedAt = Date.now();
      Object.values(this.state.pages).forEach(c => {
        if (c.parentId === p.id && !c.deleted) this.trashPage(c);
      });
    },

    restorePage(p) {
      const parentTrashTime = p.deletedAt;
      p.deleted = false;
      p.deletedAt = null;
      // 只恢复与父页面一起被删除的子页面（相同 deletedAt）
      Object.values(this.state.pages).forEach(c => {
        if (c.parentId === p.id && c.deleted && c.deletedAt === parentTrashTime) this.restorePage(c);
      });
    },

    getTrashPages() {
      return Object.values(this.state.pages).filter(p => p.deleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    },

    duplicatePage(id) {
      const src = this.getPage(id);
      if (!src) return null;
      const copy = U.clone(src);
      copy.id = U.uid("pg");
      copy.createdAt = Date.now();
      copy.updatedAt = Date.now();
      copy.deleted = false;
      copy.deletedAt = null;
      copy.title = src.title.length ? U.clone(src.title) : [{ t: "未命名" }];
      copy.children = U.clone(src.children);
      copy.schema = U.clone(src.schema);
      copy.props = U.clone(src.props);
      const remapBlocks = (blocks) => blocks.forEach(b => {
        b.id = U.uid("blk");
        if (b.attrs && b.attrs.pageId) b.attrs.pageId = copy.id;
        if (b.children && b.children.length) remapBlocks(b.children);
      });
      remapBlocks(copy.children);
      const sibs = this.getChildren(src.parentId);
      copy.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
      this.state.pages[copy.id] = copy;
      // duplicate child pages recursively
      Object.values(this.state.pages).forEach(c => {
        if (c.parentId === src.id && !c.deleted) {
          const cc = this.duplicatePage(c.id);
          if (cc) cc.parentId = copy.id;
        }
      });
      this.markDirty();
      return copy;
    },

    isPageDescendant(pageId, possibleDescendantId) {
      let cur = this.getPage(possibleDescendantId);
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        if (cur.parentId === pageId) return true;
        seen.add(cur.id);
        cur = cur.parentId === "root" ? null : this.getPage(cur.parentId);
      }
      return false;
    },

    canMovePage(id, newParentId) {
      const p = this.getPage(id);
      if (!p || id === newParentId) return false;
      if (newParentId !== "root" && !this.getPage(newParentId)) return false;
      return !this.isPageDescendant(id, newParentId);
    },

    movePage(id, newParentId, order) {
      const p = this.getPage(id);
      if (!this.canMovePage(id, newParentId)) return false;
      p.parentId = newParentId;
      if (order != null) p.order = order;
      else {
        const sibs = this.getChildren(newParentId);
        p.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
      }
      this.markDirty();
      return true;
    },

    /** move a page before/after a sibling; if inside=true, nest under target */
    reorderPage(id, targetId, pos, inside) {
      const p = this.getPage(id);
      const t = this.getPage(targetId);
      const nextParentId = inside ? targetId : (t && t.parentId);
      if (!p || !t || p.id === t.id || !this.canMovePage(id, nextParentId)) return false;
      if (inside) {
        p.parentId = t.id;
        const sibs = this.getChildren(t.id);
        p.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
        this.markDirty();
        return true;
      }
      const parentId = t.parentId;
      if (p.parentId !== parentId) {
        p.parentId = parentId;
        const sibs = this.getChildren(parentId);
        sibs.forEach((s, i) => { if (s.id !== p.id) s.order = i * 2 + 1; });
        const tp = sibs.find(s => s.id === t.id);
        const tOrder = tp ? tp.order : 0;
        if (pos === "before") p.order = tOrder - 0.5;
        else p.order = tOrder + 0.5;
        // normalize orders
        const all = this.getChildren(parentId).sort((a, b) => a.order - b.order);
        all.forEach((s, i) => s.order = i);
      } else {
        const sibs = this.getChildren(parentId);
        sibs.forEach((s, i) => { if (s.id !== p.id) s.order = i * 2 + 1; });
        const tp = sibs.find(s => s.id === t.id);
        const tOrder = tp ? tp.order : 0;
        p.order = pos === "before" ? tOrder - 0.5 : tOrder + 0.5;
        const all = this.getChildren(parentId).sort((a, b) => a.order - b.order);
        all.forEach((s, i) => s.order = i);
      }
      this.markDirty();
      return true;
    },

    /* ---------- block helpers ---------- */
    /** find block by id within a page (searching nested children) */
    findBlock(page, blockId) {
      if (!page) return null;
      const walk = (blocks) => {
        for (const b of blocks) {
          if (b.id === blockId) return b;
          if (b.children && b.children.length) {
            const r = walk(b.children);
            if (r) return r;
          }
        }
        return null;
      };
      return walk(page.children);
    },

    /** find parent container (array) and index of a block */
    findBlockPos(page, blockId) {
      if (!page) return null;
      const idx = page.children.findIndex(b => b.id === blockId);
      if (idx >= 0) return { list: page.children, index: idx, parent: null };
      const walk = (list) => {
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (b.children && b.children.length) {
            const j = b.children.findIndex(c => c.id === blockId);
            if (j >= 0) return { list: b.children, index: j, parent: b };
            const r = walk(b.children);
            if (r) return r;
          }
        }
        return null;
      };
      return walk(page.children);
    },

    blockContains(block, blockId) {
      if (!block || !block.children) return false;
      return block.children.some(child => child.id === blockId || this.blockContains(child, blockId));
    },

    blockAncestors(page, blockId) {
      const path = [];
      const walk = (list, parents) => {
        for (const block of list) {
          if (block.id === blockId) { path.push(...parents); return true; }
          if (block.children && walk(block.children, parents.concat(block))) return true;
        }
        return false;
      };
      walk(page ? page.children : [], []);
      return path;
    },

    moveBlockToSide(page, blockId, targetId, side) {
      if (!page || blockId === targetId || (side !== "left" && side !== "right")) return false;
      const source = this.findBlock(page, blockId);
      const target = this.findBlock(page, targetId);
      if (!source || !target || this.blockContains(source, targetId)) return false;
      const sourceColumns = this.sourceColumns(page, blockId);
      const sourcePos = this.findBlockPos(page, blockId);
      if (!sourcePos) return false;
      sourcePos.list.splice(sourcePos.index, 1);

      const targetPos = this.findBlockPos(page, targetId);
      if (!targetPos) { sourcePos.list.splice(Math.min(sourcePos.index, sourcePos.list.length), 0, source); return false; }
      const ancestors = this.blockAncestors(page, targetId);
      const targetColumn = ancestors.slice().reverse().find(b => b.type === "column");
      const columns = ancestors.slice().reverse().find(b => b.type === "columns");

      if (targetColumn && columns) {
        const columnIndex = columns.children.indexOf(targetColumn);
        if (columns.children.length < 4) {
          const column = newBlock("column");
          column.children = [source];
          columns.children.splice(columnIndex + (side === "right" ? 1 : 0), 0, column);
        } else {
          const edgeColumn = side === "left" ? columns.children[0] : columns.children[columns.children.length - 1];
          edgeColumn.children.push(source);
        }
      } else {
        const currentTargetPos = this.findBlockPos(page, targetId);
        if (!currentTargetPos) { sourcePos.list.splice(Math.min(sourcePos.index, sourcePos.list.length), 0, source); return false; }
        currentTargetPos.list.splice(currentTargetPos.index, 1);
        const left = newBlock("column"), right = newBlock("column");
        left.children = side === "left" ? [source] : [target];
        right.children = side === "left" ? [target] : [source];
        const container = newBlock("columns");
        container.children = [left, right];
        currentTargetPos.list.splice(currentTargetPos.index, 0, container);
      }
      this.normalizeColumns(page, sourceColumns);
      this.touch(page);
      this.markDirty();
      return true;
    },

    normalizeColumns(page, columns) {
      if (!page || !columns || columns.type !== "columns") return false;
      const containerPos = this.findBlockPos(page, columns.id);
      if (!containerPos) return false;
      columns.children = (columns.children || []).filter(column => column.type === "column" && (column.children || []).length);
      if (columns.children.length >= 2) return true;
      if (columns.children.length === 1) {
        containerPos.list.splice(containerPos.index, 1, ...columns.children[0].children);
      } else {
        containerPos.list.splice(containerPos.index, 1);
      }
      return true;
    },

    sourceColumns(page, blockId) {
      return this.blockAncestors(page, blockId).slice().reverse().find(block => block.type === "columns") || null;
    },

    /** insert block into page at index; returns block */
    insertBlock(page, block, index) {
      if (index == null) index = page.children.length;
      page.children.splice(index, 0, block);
      this.touch(page);
      this.markDirty();
      return block;
    },

    removeBlock(page, blockId) {
      const columns = this.sourceColumns(page, blockId);
      const pos = this.findBlockPos(page, blockId);
      if (!pos) return null;
      const [removed] = pos.list.splice(pos.index, 1);
      this.normalizeColumns(page, columns);
      // Question and flashcard entities deliberately outlive their page references.
      // This preserves a reusable local question bank when an editor block is removed.
      this.touch(page);
      this.markDirty();
      return removed;
    },

    moveBlock(page, blockId, targetId, pos) {
      const sourceColumns = this.sourceColumns(page, blockId);
      const src = this.findBlockPos(page, blockId);
      if (!src) return;
      const [blk] = src.list.splice(src.index, 1);
      if (targetId === blockId) { src.list.splice(src.index, 0, blk); this.markDirty(); return; }
      const tgt = this.findBlockPos(page, targetId);
      if (!tgt) {
        page.children.push(blk);
        this.normalizeColumns(page, sourceColumns);
        this.markDirty(); this.touch(page); return;
      }
      if (pos === "inside") {
        const tBlk = this.findBlock(page, targetId);
        if (tBlk) {
          if (tBlk.type === "toggle") {
            tBlk.children = tBlk.children || [];
            tBlk.children.push(blk);
            blk.indent = 0;
          } else if (["bullet", "numbered", "todo"].includes(tBlk.type)) {
            blk.indent = (tBlk.indent || 0) + 1;
          } else {
            tBlk.children = tBlk.children || [];
            tBlk.children.push(blk);
            blk.indent = 0;
          }
        } else {
          page.children.push(blk);
        }
      } else if (pos === "before") {
        tgt.list.splice(tgt.index, 0, blk);
      } else {
        tgt.list.splice(tgt.index + 1, 0, blk);
      }
      this.normalizeColumns(page, sourceColumns);
      this.touch(page);
      this.markDirty();
    },

    /** move multiple top-level blocks together (multi-select drag) */
    moveBlocks(page, ids, targetId, pos) {
      if (!ids || !ids.length) return;
      const entries = [];
      ids.forEach(id => {
        const p = this.findBlockPos(page, id);
        if (p && p.parent === null) entries.push({ block: p.list[p.index], index: p.index });
      });
      if (!entries.length) return;
      entries.sort((a, b) => a.index - b.index);
      let targetIdx = page.children.length;
      if (targetId) {
        const tp = this.findBlockPos(page, targetId);
        if (tp && tp.parent === null) targetIdx = (pos === "before") ? tp.index : tp.index + 1;
      }
      entries.forEach(e => {
        const p = this.findBlockPos(page, e.block.id);
        if (p) p.list.splice(p.index, 1);
      });
      const removedBefore = entries.filter(e => e.index < targetIdx).length;
      let idx = targetIdx - removedBefore;
      idx = Math.max(0, Math.min(idx, page.children.length));
      page.children.splice(idx, 0, ...entries.map(e => e.block));
      this.touch(page);
      this.markDirty();
    },

    /** find previous sibling block (same list) */
    prevBlock(page, blockId) {
      const pos = this.findBlockPos(page, blockId);
      if (!pos) return null;
      if (pos.index > 0) return pos.list[pos.index - 1];
      if (pos.parent) {
        const ppos = this.findBlockPos(page, pos.parent.id);
        if (ppos && ppos.index >= 0) return ppos.list[ppos.index];
      }
      return null;
    },

    /** find next sibling block (same list); returns null if none */
    nextBlock(page, blockId) {
      const pos = this.findBlockPos(page, blockId);
      if (!pos) return null;
      if (pos.index < pos.list.length - 1) return pos.list[pos.index + 1];
      // walk up to parent's next
      let cur = pos;
      let guard = 0;
      while (cur.parent && guard++ < 10) {
        const ppos = this.findBlockPos(page, cur.parent.id);
        if (!ppos) return null;
        if (ppos.index < ppos.list.length - 1) return ppos.list[ppos.index + 1];
        cur = ppos;
      }
      return null;
    },

    touch(page) {
      if (page) page.updatedAt = Date.now();
    },

    /* ---------- search ---------- */
    search(query) {
      query = (query || "").trim().toLowerCase();
      if (!query) return [];
      const results = [];
      const self = this;
      Object.values(this.state.pages).forEach(p => {
        if (p.deleted) return;
        const title = U.segsText(p.title);
        const hit = (text, loc) => results.push({ page: p, type: "page", title, loc });
        if (title.toLowerCase().includes(query)) { hit(title, "title"); return; }
        // search blocks
        const walk = (blocks, depth) => {
          for (const b of blocks) {
            const t = U.segsText(b.text);
            if (t && t.toLowerCase().includes(query)) {
              results.push({ page: p, type: "block", block: b, title, loc: t });
            }
            if (b.attrs && b.attrs.rows) {
              b.attrs.rows.forEach(row => {
                (row || []).forEach(cell => {
                  const ct = U.segsText(Array.isArray(cell) ? cell : (cell ? [cell] : []));
                  if (ct && ct.toLowerCase().includes(query)) {
                    results.push({ page: p, type: "block", block: b, title, loc: ct });
                  }
                });
              });
            }
            if (b.attrs && b.attrs.caption) {
              const ct = U.segsText(b.attrs.caption);
              if (ct && ct.toLowerCase().includes(query)) {
                results.push({ page: p, type: "block", block: b, title, loc: ct });
              }
            }
            if (b.children && b.children.length) walk(b.children, depth + 1);
          }
        };
        walk(p.children, 0);
        if (p.database) {
          self.getChildren(p.id).forEach(row => {
            const rt = U.segsText(row.title);
            if (rt.toLowerCase().includes(query)) results.push({ page: row, type: "page", title: rt, loc: rt });
          });
        }
      });
      // dedupe by page+type+loc
      const seen = new Set();
      return results.filter(r => {
        const k = (r.page.id) + "|" + r.type + "|" + (r.block ? r.block.id : "") + "|" + r.loc.slice(0, 40);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 50);
    },

    /** export whole workspace */
    exportJSON() {
      return JSON.stringify(this.state, null, 2);
    },

    /** import workspace (merge; returns {added, replaced}) */
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !data.pages || typeof data.pages !== "object" || Array.isArray(data.pages)) throw new Error("不是有效的 Notionish 导出文件");
      const seen = new Set(Object.keys(this.state.pages));
      let added = 0, replaced = 0;
      Object.entries(data.pages).forEach(([id, rawPage]) => {
        const page = normalizePage(rawPage, id);
        if (!page) return;
        page.id = id;
        if (seen.has(id)) { this.state.pages[id] = page; replaced++; }
        else { this.state.pages[id] = page; added++; }
      });
      Object.values(this.state.pages).forEach(page => {
        if (page.parentId !== "root" && (!this.state.pages[page.parentId] || this.isPageDescendant(page.id, page.parentId))) page.parentId = "root";
      });
      if (data.settings && (data.settings.theme === "light" || data.settings.theme === "dark")) this.state.settings.theme = data.settings.theme;
      if (data.questions && typeof data.questions === "object" && !Array.isArray(data.questions)) {
        this.state.questions = this.state.questions || {};
        Object.entries(data.questions).forEach(([id, q]) => {
          const normalized = normalizeQuestion(q, id);
          if (normalized) this.state.questions[id] = normalized;
        });
      }
      if (data.flashcards && typeof data.flashcards === "object" && !Array.isArray(data.flashcards)) {
        this.state.flashcards = this.state.flashcards || {};
        Object.entries(data.flashcards).forEach(([id, f]) => {
          const normalized = normalizeFlashcard(f, id);
          if (normalized) this.state.flashcards[id] = normalized;
        });
      }
      this.markDirty();
      this.save(true);
      return { added, replaced };
    },

    /** generate a database row (child page of database) */
    createRow(dbPage, title) {
      const row = newPage(dbPage.id, { title: title || "未命名" });
      const sibs = this.getChildren(dbPage.id);
      row.order = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
      row.props = {};
      dbPage.schema.props.forEach(prop => {
        if (prop.type === "select" && prop.options.length) row.props[prop.id] = prop.options[0];
        else if (prop.type === "checkbox") row.props[prop.id] = false;
        else if (prop.type === "number") row.props[prop.id] = null;
        else if (prop.type === "multi_select" || prop.type === "relation") row.props[prop.id] = [];
        else row.props[prop.id] = "";
      });
      this.state.pages[row.id] = row;
      this.touch(dbPage);
      this.markDirty();
      return row;
    },

    propValue(dbPage, row, prop) {
      const v = row.props[prop.id];
      if (prop.type === "multi_select") return Array.isArray(v) ? v : [];
      return v == null ? "" : v;
    },

    setPropValue(dbPage, row, prop, value) {
      row.props[prop.id] = value;
      this.touch(row);
      this.markDirty();
    },

    /** typed raw value of a property for a row */
    rawPropValue(dbPage, row, prop) {
      const v = row.props[prop.id];
      if (prop.type === "number") return v == null || v === "" ? 0 : Number(v);
      if (prop.type === "checkbox") return !!v;
      if (prop.type === "multi_select" || prop.type === "relation") return Array.isArray(v) ? v : [];
      return v == null ? "" : v;
    },

    /** computed value for formula / rollup properties (with recursion guard) */
    computedPropValue(dbPage, row, prop, seen) {
      seen = seen || new Set();
      if (seen.has(prop.id)) return "…";
      seen.add(prop.id);
      try {
        if (prop.type === "formula") {
          const expr = (prop.formula && prop.formula.expr) || "";
          const scope = {
            get(name) {
              const target = dbPage.schema.props.find(p => p.name === name || p.id === name);
              if (!target) return null;
              if (target.type === "formula" || target.type === "rollup") return Store.computedPropValue(dbPage, row, target, seen);
              return Store.rawPropValue(dbPage, row, target);
            }
          };
          try { return Formula.eval(expr, scope); } catch (e) { return "#错误: " + e.message; }
        }
        if (prop.type === "rollup") {
          return Store.computeRollup(dbPage, row, prop);
        }
        return Store.rawPropValue(dbPage, row, prop);
      } finally {
        seen.delete(prop.id);
      }
    },

    relationTargetPage(prop) {
      const dbId = prop.relation && prop.relation.dbId;
      return dbId ? Store.getPage(dbId) : null;
    },

    relationRows(dbPage, row, prop) {
      const ids = Array.isArray(row.props[prop.id]) ? row.props[prop.id] : [];
      return ids.map(id => Store.getPage(id)).filter(p => p && !p.deleted);
    },

    computeRollup(dbPage, row, prop) {
      const cfg = prop.rollup || {};
      const relProp = dbPage.schema.props.find(p => p.id === cfg.relationPropId);
      if (!relProp || relProp.type !== "relation") return "—";
      const related = Store.relationRows(dbPage, row, relProp);
      const targetDb = relProp.relation ? Store.getPage(relProp.relation.dbId) : null;
      const targetProp = targetDb ? targetDb.schema.props.find(p => p.id === cfg.targetPropId) : null;
      const agg = cfg.aggregate || "count_all";
      const vals = related.map(r => targetProp ? Store.rawPropValue(targetDb, r, targetProp) : null);
      const nonEmpty = vals.filter(v => v != null && v !== "" && !(Array.isArray(v) && v.length === 0));
      switch (agg) {
        case "count_all": return related.length;
        case "count_values": return nonEmpty.length;
        case "sum": return nonEmpty.reduce((s, v) => s + Number(v), 0);
        case "average": return nonEmpty.length ? nonEmpty.reduce((s, v) => s + Number(v), 0) / nonEmpty.length : 0;
        case "min": return nonEmpty.length ? Math.min.apply(null, nonEmpty.map(Number)) : "";
        case "max": return nonEmpty.length ? Math.max.apply(null, nonEmpty.map(Number)) : "";
        case "unique": return Array.from(new Set(nonEmpty.map(v => Array.isArray(v) ? v.join(",") : String(v)))).join(", ");
        case "show_original": return nonEmpty.map(v => Array.isArray(v) ? v.join(", ") : String(v)).join(", ");
        case "earliest_date": return nonEmpty.slice().sort()[0] || "";
        case "latest_date": return nonEmpty.slice().sort().pop() || "";
        default: return related.length;
      }
    },

    /** find database page that owns this row */
    ownerDb(row) {
      return row.parentId === "root" ? null : this.getPage(row.parentId);
    },

    /** inline table block helpers */
    tableData(block) {
      return block.attrs && block.attrs.rows ? block.attrs.rows : [];
    },


    /* ---------- Markdown / display value export ---------- */
    displayPropValue(dbPage, row, prop) {
      const v = this.computedPropValue(dbPage, row, prop);
      if (prop.type === "checkbox") return v ? "✓" : "";
      if (Array.isArray(v)) return v.map(x => {
        const p = this.getPage(x);
        return p ? (U.segsText(p.title) || "未命名") : String(x);
      }).join(", ");
      return v == null ? "" : String(v);
    },

    segToMarkdown(segs) {
      let out = "";
      (segs || []).forEach(s => {
        if (s.mention) {
          const p = this.getPage(s.mention);
          out += (p && !p.deleted) ? ("@[" + (U.segsText(p.title) || "未命名") + "]") : "@已删除页面";
          return;
        }
        if (s.math != null) { out += "$" + s.math + "$"; return; }
        let t = s.t || "";
        if (s.c) t = "\u0060" + t + "\u0060";
        else if (s.b) t = "**" + t + "**";
        if (s.i) t = "_" + t + "_";
        if (s.s) t = "~~" + t + "~~";
        if (s.link) t = "[" + t + "](" + s.link + ")";
        out += t;
      });
      return out;
    },

    tableToMarkdown(block) {
      const rows = (block.attrs.rows || []).map(r => (r || []).map(c => this.segToMarkdown(Array.isArray(c) ? c : (c ? [c] : []))));
      if (!rows.length) return "";
      const ncol = block.attrs.cols || rows[0].length;
      let out = "";
      rows.forEach((r, i) => {
        const cells = [];
        for (let c = 0; c < ncol; c++) cells.push(r[c] || "");
        out += "| " + cells.join(" | ") + " |\n";
        if (i === 0 && block.attrs.header) out += "| " + cells.map(() => "---").join(" | ") + " |\n";
      });
      return out + "\n";
    },

    blockToMarkdown(block, depth) {
      depth = depth || 0;
      const indent = "  ".repeat(Math.min(5, block.indent || 0));
      const text = this.segToMarkdown(block.text);
      const children = (block.children || []).map(c => this.blockToMarkdown(c, depth + 1)).join("");
      switch (block.type) {
        case "heading1": return "# " + text + "\n\n";
        case "heading2": return "## " + text + "\n\n";
        case "heading3": return "### " + text + "\n\n";
        case "bullet": return indent + "- " + text + "\n";
        case "numbered": return indent + "1. " + text + "\n";
        case "todo": return indent + "- [" + (block.checked ? "x" : " ") + "] " + text + "\n";
        case "toggle": return indent + "▸ " + text + "\n" + children;
        case "quote": return indent + "> " + text + "\n";
        case "callout": return indent + "> " + (block.attrs.icon || "💡") + " " + text + "\n";
        case "code": return "\u0060\u0060\u0060" + (block.attrs.language || "") + "\n" + (block.attrs.source || "") + "\n\u0060\u0060\u0060\n\n";
        case "divider": return "---\n\n";
        case "equation": return "$$\n" + text + "\n$$\n\n";
        case "image": return "![" + (block.attrs.caption ? this.segToMarkdown(block.attrs.caption) : "图片") + "](" + (block.attrs.src || "") + ")\n\n";
        case "embed": return (block.attrs.url || "") + "\n\n";
        case "bookmark": return "[" + (block.attrs.title || block.attrs.url || "") + "](" + (block.attrs.url || "") + ")\n\n";
        case "file": return "📎 " + (block.attrs.name || "") + "\n\n";
        case "table": return this.tableToMarkdown(block);
        case "page": { const t = this.getPage(block.attrs.pageId); return "📄 " + (t ? (U.segsText(t.title) || "未命名") : "子页面") + "\n\n"; }
        case "database": { const t = this.getPage(block.attrs.pageId); return "🗄 " + (t ? (U.segsText(t.title) || "数据库") : "数据库") + "\n\n"; }
        default: return (text ? text + "\n\n" : "");
      }
    },

    pageToMarkdown(page) {
      let out = "# " + (U.segsText(page.title) || "未命名") + "\n\n";
      if (page.database) {
        out += "| " + page.schema.props.map(p => p.name).join(" | ") + " |\n";
        out += "| " + page.schema.props.map(() => "---").join(" | ") + " |\n";
        this.getChildren(page.id).forEach(row => {
          const cells = page.schema.props.map(p => this.segToMarkdown([{ t: this.displayPropValue(page, row, p) }]));
          out += "| " + cells.join(" | ") + " |\n";
        });
        out += "\n";
      }
      (page.children || []).forEach(b => { out += this.blockToMarkdown(b); });
      return out;
    },

    /* ---------- page templates ---------- */
    addTemplate(item) {
      this.state.templates = this.state.templates || [];
      item.id = item.id || U.uid("tpl");
      this.state.templates.push(item);
      this.markDirty();
      return item;
    },
    removeTemplate(id) {
      this.state.templates = (this.state.templates || []).filter(t => t.id !== id);
      this.markDirty();
    },
    getTemplates() { return this.state.templates || []; },
    createPageFromTemplate(tplId, parentId) {
      const tpl = (this.state.templates || []).find(t => t.id === tplId);
      if (!tpl) return null;
      const d = tpl.data || {};
      const page = this.createPage(parentId || "root", { title: d.title ? U.segsText(d.title) : "未命名", icon: d.icon || "📄" });
      const remap = (b) => { b.id = U.uid("blk"); (b.children || []).forEach(remap); };
      page.children = U.clone(d.children || []);
      page.children.forEach(remap);
      this.markDirty();
      return page;
    },

    /* ---------- reminders ---------- */
    addReminder(item) {
      this.state.reminders = this.state.reminders || [];
      item.id = item.id || U.uid("rem");
      item.done = !!item.done;
      this.state.reminders.push(item);
      this.markDirty();
      return item;
    },
    removeReminder(id) {
      this.state.reminders = (this.state.reminders || []).filter(r => r.id !== id);
      this.markDirty();
    },
    toggleReminder(id, done) {
      const r = (this.state.reminders || []).find(x => x.id === id);
      if (r) { r.done = !!done; this.markDirty(); }
    },
    getReminders() {
      return (this.state.reminders || []).slice().sort((a, b) => a.at - b.at);
    },
  };

  Store.newBlock = newBlock;
  Store.defaultProp = defaultProp;
  Store.newPage = newPage;
  Store.evalFormula = function (expr, scope) { return Formula.eval(expr, scope || null); };
  global.Store = Store;
})(window);
