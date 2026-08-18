/* ============ Util helpers ============ */
(function (global) {
  "use strict";

  /** 把 emoji 字符串按「字素」拆成数组，避免代理对 / 变体选择符被拆碎 */
  function splitEmojis(s) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), x => x.segment);
    }
    return Array.from(s);
  }

  const U = {
    /** short unique id */
    uid(prefix) {
      return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    },

    /** deep clone via JSON (our data is JSON-safe) */
    clone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); },

    /** escape HTML */
    esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },

    /** escape attribute value */
    escAttr(s) { return U.esc(s); },

    /** create element（文本参数自动翻译：整串匹配字典才翻，用户数据/拼接串返回原文） */
    el(tag, cls, html) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) {
        if (typeof html === "string" && global.I18n && I18n.lang === "en") html = U.t(html);
        e.innerHTML = html;
      }
      return e;
    },

    /** current render container (分屏时为活动窗格的 body，否则为 #content) */
    renderRoot() {
      if (global.App && App._renderTarget) return App._renderTarget;
      return document.getElementById("content");
    },

    debounce(fn, ms) {
      let t = null;
      return function () {
        const args = arguments, self = this;
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn.apply(self, args); }, ms);
      };
    },

    throttle(fn, ms) {
      let last = 0, t = null;
      return function () {
        const now = Date.now(), args = arguments, self = this;
        if (now - last >= ms) { last = now; fn.apply(self, args); return; }
        if (t) clearTimeout(t);
        t = setTimeout(() => { last = Date.now(); t = null; fn.apply(self, args); }, ms - (now - last));
      };
    },

    /** format date: 2025-01-31 or relative */
    fmtDate(ts, full) {
      if (!ts) return "";
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const pad = (n) => String(n).padStart(2, "0");
      if (full) return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      if (sameDay) return "今天 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    },

    /** simple text preview from segments */
    segsText(segs) {
      if (!Array.isArray(segs)) return "";
      return segs.map(s => (s && s.t) || "").join("");
    },

    /** first line preview */
    preview(segs, len) {
      const t = U.segsText(segs).replace(/\n/g, " ").trim();
      return t.length > (len || 80) ? t.slice(0, len || 80) + "…" : t;
    },

    /** download a file */
    download(filename, content, mime) {
      const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
    },

    /** read a File as dataURL */
    fileToDataURL(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
    },

    /** copy text to clipboard with fallback */
    copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => U.legacyCopy(text));
      }
      return Promise.resolve(U.legacyCopy(text));
    },

    legacyCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    },

    /** toast notification */
    toast(msg, ms) {
      const root = document.getElementById("toast-root");
      const t = U.el("div", "toast", U.esc(msg));
      root.appendChild(t);
      setTimeout(() => {
        t.style.transition = "opacity .25s"; t.style.opacity = "0";
        setTimeout(() => t.remove(), 260);
      }, ms || 2200);
    },

    /** simple tooltip on hover for elements with title attr (we manage custom) */
    showTooltip(x, y, text) {
      const root = document.getElementById("tooltip-root");
      const t = U.el("div", "", U.esc(text));
      root.innerHTML = "";
      root.appendChild(t);
      root.style.display = "block";
      const r = root.getBoundingClientRect();
      root.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
      root.style.top = (y + 14) + "px";
    },
    hideTooltip() {
      const root = document.getElementById("tooltip-root");
      if (root) root.style.display = "none";
    },

    /** generic modal: returns { el, body, close } */
    modal(opts) {
      const mask = U.el("div", "modal-mask");
      const m = U.el("div", "modal" + (opts.size === "lg" ? " lg" : opts.size === "sm" ? " sm" : ""));
      const head = U.el("div", "modal-head");
      head.appendChild(U.el("h3", null, U.esc(opts.title || "")));
      const closeX = U.el("button", "icon-btn", U.icon("x", { size: 16 }));
      closeX.title = U.t("关闭 (Esc)");
      head.appendChild(closeX);
      const body = U.el("div", "modal-body");
      const foot = U.el("div", "modal-foot");
      m.appendChild(head); m.appendChild(body);
      if (opts.foot) foot.appendChild(opts.foot);
      m.appendChild(foot);
      mask.appendChild(m);
      document.getElementById("modal-root").appendChild(mask);

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        mask.remove();
        if (opts.onClose) opts.onClose();
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      };
      mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
      closeX.addEventListener("click", close);
      document.addEventListener("keydown", onKey, true);
      return { el: m, head, body, foot, mask, close };
    },

    /** 统一输入弹窗（替代 prompt）：返回 Promise<string|null> */
    promptModal(opts) {
      return new Promise(resolve => {
        let settled = false;
        const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
        const m = U.modal({ title: opts.title || "", size: "sm", onClose: () => settle(null) });
        const inp = U.el("input", "modal-input");
        inp.value = opts.value || "";
        inp.placeholder = opts.placeholder || "";
        inp.autocomplete = "off";
        m.body.appendChild(inp);
        const ok = U.el("button", "db-btn primary", opts.okText || "确定");
        const cancel = U.el("button", "db-btn", "取消");
        ok.addEventListener("click", () => { settle(inp.value); m.close(); });
        cancel.addEventListener("click", () => m.close());
        inp.addEventListener("keydown", e => {
          if (e.key === "Enter") { settle(inp.value); m.close(); }
          else if (e.key === "Escape") m.close();
        });
        m.foot.appendChild(cancel); m.foot.appendChild(ok);
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    },

    /** 统一确认弹窗（替代 confirm）：返回 Promise<boolean> */
    confirmModal(opts) {
      return new Promise(resolve => {
        let settled = false;
        const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
        const m = U.modal({ title: opts.title || "", size: "sm", onClose: () => settle(false) });
        const msg = U.el("div", "modal-msg", U.esc(opts.message || ""));
        m.body.appendChild(msg);
        const ok = U.el("button", "db-btn" + (opts.danger ? " danger" : " primary"), opts.okText || "确定");
        const cancel = U.el("button", "db-btn", "取消");
        ok.addEventListener("click", () => { settle(true); m.close(); });
        cancel.addEventListener("click", () => m.close());
        m.foot.appendChild(cancel); m.foot.appendChild(ok);
        setTimeout(() => ok.focus(), 30);
      });
    },

    /** position a popover near a rect */
    placePop(pop, rect, opts) {
      opts = opts || {};
      pop.style.visibility = "hidden";
      pop.style.display = "flex";
      document.body.appendChild(pop);
      const r = pop.getBoundingClientRect();
      let x = rect.left;
      let y = opts.above ? rect.top - r.height - 6 : rect.bottom + 6;
      if (opts.alignRight) x = rect.right - r.width;
      x = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
      y = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
      pop.style.left = x + "px";
      pop.style.top = y + "px";
      pop.style.visibility = "visible";
      return r;
    },

    /** close all open popovers */
    closePopovers(except) {
      document.querySelectorAll(".popover").forEach(p => {
        if (p !== except) p.remove();
      });
    },

    /** remove an element's children */
    clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; },

    /** hex color to rgb for contrast */
    hexToRgb(hex) {
      const h = hex.replace("#", "");
      const v = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
      return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
    },

    /** pick a readable pill color from a palette by hash of text */
    pillColor(key) {
      const palette = ["p-gray", "p-blue", "p-green", "p-orange", "p-red", "p-purple", "p-yellow", "p-pink", "p-brown", "p-teal"];
      let h = 0;
      const s = String(key || "");
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return palette[h % palette.length];
    },

    /** kebab-case → PascalCase（lucide 图标名映射），如 trash-2 → Trash2 */
    iconName(name) {
      return String(name == null ? "" : name).replace(/(^|[-_ ]+)([a-zA-Z0-9])/g, (m, p1, p2) => p2.toUpperCase());
    },

    /** 递归把 lucide 图标数据 [[tag, attrs, children?]] 渲染为 SVG 字符串 */
    iconBody(nodes) {
      let out = "";
      (nodes || []).forEach(n => {
        const tag = n[0], attrs = n[1] || {}, children = n[2];
        out += "<" + tag;
        Object.keys(attrs).forEach(k => { out += " " + k + '="' + U.escAttr(attrs[k]) + '"'; });
        if (children && children.length) out += ">" + U.iconBody(children) + "</" + tag + ">";
        else out += "/>";
      });
      return out;
    },

    /** 渲染 Lucide 图标为 SVG 字符串；Lucide 未加载时返回空串安全降级 */
    icon(name, opts) {
      const L = global.lucide;
      const data = (L && L.icons && L.icons[U.iconName(name)]) || null;
      if (!data) return "";
      const o = opts || {};
      const size = o.size || 18;
      const sw = o.strokeWidth || 2;
      const cls = o.cls || "";
      const attrs =
        'xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '"' +
        ' viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
        ' stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"' +
        (cls ? ' class="' + U.escAttr(cls) + '"' : "") + ' aria-hidden="true"';
      return "<svg " + attrs + ">" + U.iconBody(data) + "</svg>";
    },

    /** 把带 data-icon 的静态元素替换为 Lucide 图标 */
    applyStaticIcons(root) {
      (root || document).querySelectorAll("[data-icon]").forEach(el => {
        const name = el.getAttribute("data-icon");
        const size = parseInt(el.getAttribute("data-icon-size") || "16", 10);
        const sw = el.getAttribute("data-icon-stroke") ? parseFloat(el.getAttribute("data-icon-stroke")) : 2;
        const svg = U.icon(name, { size, strokeWidth: sw });
        if (svg) el.innerHTML = svg;
        el.classList.add("iconed");
      });
    },

    /** 最近使用的 Emoji（localStorage，上限 24） */
    recentEmojisGet() {
      try {
        const arr = JSON.parse(localStorage.getItem("notionish_recent_emojis") || "[]");
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },

    recentEmojisAdd(emoji) {
      if (!emoji) return;
      const arr = U.recentEmojisGet().filter(e => e !== emoji);
      arr.unshift(emoji);
      try { localStorage.setItem("notionish_recent_emojis", JSON.stringify(arr.slice(0, 24))); } catch (e) { /* ignore */ }
    },

    /** emoji categories for picker */
    EMOJIS: ["😀","😁","😂","🤣","😊","😇","🙂","😉","😌","😍","🥰","😘","😜","🤪","🤨","🧐","🤓","😎","🥳","😏","😒","😞","😔","😟","😕","🙁","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕","🤑","🤠","😈","👿","👹","👺","🤡","💩","👻","💀","👽","👾","🤖","🎃","😺","😸","😹","😻","😼","😽","🙀","😿","😾","👋","🤚","🖐","✋","🖖","👌","🤌","🤏","✌","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍","💅","🤳","💪","🦾","🦵","🦶","👂","🦻","👃","🧠","🦷","🦴","👀","👁","👅","👄","💋","🩸","❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","♥️","💯","💢","💥","💫","💦","💨","🕳","💣","💬","👁🗨","🗨","🗯","💭","💤","🌍","🌎","🌏","🌐","🛰","🚀","🛸","☄","🌋","🌊","🌪","🌈","☀️","🌤","⛅","🌥","☁️","🌦","🌧","⛈","🌩","🌨","❄️","☃️","⛄","🌬","💧","☔","☂️","🌫","🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🥬","🥒","🌶","🫑","🌽","🥕","🫒","🧄","🧅","🥔","🍠","🥐","🥯","🍞","🥖","🥨","🧀","🥚","🍳","🧈","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🫓","🥪","🥙","🧆","🌮","🌯","🫔","🥗","🥘","🫕","🥫","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙","🍚","🍘","🍥","🥠","🥮","🍢","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🌰","🥜","🍯","🥛","🍼","☕","🍵","🧃","🥤","🧋","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾","🧊","🏀","⚽","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥅","🏒","🏑","🥍","🏏","🥌","🎿","⛷","🏂","🪂","🏋️","🤸","⛹️","🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🤽","🚣","🧗","🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖","🏵","🎗","🎫","🎟","🎪","🤹","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟","🎯","🎳","🎮","🎰","🧩","🚗","🚕","🚙","🚌","🚎","🏎","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🛵","🏍","🛺","🚲","🛴","🚨","🚔","🚍","🚘","🚖","🚡","🚠","🚟","🚃","🚋","🚞","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊","🚉","✈️","🛫","🛬","🛩","💺","🛰","🚀","🛸","🚁","🛶","⛵","🚤","🛥","🛳","⛴","🚢","⚓","🪝","⛽","🚧","🚦","🚥","🚏","🗺","🗿","🗽","🗼","🏰","🏯","🏟","🎡","🎢","🎠","⛲","⛱","🏖","🏝","🏜","🌋","⛰","🏔","🗻","🏕","⛺","🛖","🏠","🏡","🏘","🏚","🏗","🏭","🏢","🏬","🏣","🏤","🏥","🏦","🏨","🏪","🏫","🏩","💒","🏛","⛪","🕌","🕍","🛕","🕋","⛩","🛤","🛣","🗾","🎑","🏞","🌅","🌄","🌠","🎇","🎆","🌇","🌆","🏙","🌃","🌌","🌉","🌁","⌚","📱","📲","💻","⌨️","🖥","🖨","🖱","🖲","🕹","🗜","💽","💾","💿","📀","📼","📷","📸","📹","🎥","📽","🎞","📞","☎️","📟","📠","📺","📻","🎙","🎚","🎛","🧭","⏱","⏲","⏰","🕰","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯","🪔","🧯","🗑","🛢","💸","💵","💴","💶","💷","🪙","💰","💳","💎","⚖️","🪜","🧰","🪛","🔧","🔨","⚒","🛠","⛏","🪚","🔩","⚙️","🪤","🧱","⛓","🧲","🔫","💣","🧨","🪓","🔪","🗡","⚔️","🛡","🚬","⚰️","🪦","⚱️","🏺","🔮","📿","🧿","💈","⚗️","🔭","🔬","🕳","💊","💉","🩺","🩻","🌡","🩹","🩼","🧬","🦠","🧫","🧪","🧹","🧺","🧻","🚽","🚰","🚿","🛁","🛀","🧼","🪥","🪒","🧽","🪣","🧴","🛎","🔑","🗝","🚪","🪑","🛋","🛏","🛌","🧸","🪆","🖼","🪞","🪟","🛍","🛒","🎁","🎈","🎏","🎀","🪄","🪅","🎊","🎉","🪩","🎎","🏮","🎐","🧧","✉️","📩","📨","📧","💌","📥","📤","📦","🏷","🪧","📪","📫","📬","📭","📮","📯","📜","📃","📄","📑","🧾","📊","📈","📉","🗒","🗓","📆","📅","🗑","📇","🗃","🗳","🗄","📋","📁","📂","🗂","🗞","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🧷","🔗","📎","🖇","📐","📏","🧮","📌","📍","✂️","🖊","🖋","✒️","🖌","🖍","📝","✏️","🔍","🔎","🔏","🔐","🔒","🔓","🏳","🏴","🏁","🚩","🏳️‍🌈","⚽","🏀","🏈","⚾","🎾","🎱","🏓","🪀","🏸","🏒","🏑","🥍","🏏","🪃","🥅","⛳","🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸","🥌","🎿","⛷","🏂","🪂","🏋️‍♂️","🤼‍♀️","🤸‍♂️","⛹️‍♂️","🤺","🤾‍♂️","🏌️‍♂️","🏇","🧘‍♂️","🏄‍♂️","🏊‍♂️","🤽‍♂️","🚣‍♂️","🧗‍♂️","🚵‍♂️","🚴‍♂️","🏆","🥇","🥈","🥉","🏅","🎖","🏵","🎗","🎫","🎟","🎪","🤹‍♂️","🎭","🩰","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟","🎯","🎳","🎮","🎰","🧩","🎴","🀄","🎭","🎫","🎟","🎪","🤹","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟","🎯","🎳","🎮","🎰","🧩"],
    /** Emoji 分类（精选子集；「全部」在选择器里直接使用 U.EMOJIS） */
    EMOJI_GROUPS: [
      { id: "smileys", label: "表情", emojis: splitEmojis("😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😋😛😝😜🤪🤨🧐🤓😎🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🤭🤫🤥😶😐😑😬🙄😯😦😧😮😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿👹👺🤡💩👻💀☠️👽👾🤖🎃") },
      { id: "hands", label: "手势", emojis: splitEmojis("👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅🤳💪🦾🦵🦶👂🦻👃🧠🦷🦴👀👁👅👄💋") },
      { id: "nature", label: "自然", emojis: splitEmojis("🌍🌎🌏🌐🗺🗾🌋🗻🏔⛰🌄🌅🌆🌇🌉🌈☀️🌤⛅🌥☁️🌦🌧⛈🌩🌨❄️☃️⛄🌬💧💦☔☂️🌫🌪🌱🌲🌳🌴🌵🌾🌿☘🍀🍁🍂🍃🍄🌹🥀🌺🌸🌼🌻🌞🌝🌛🌜🌙⭐🌟✨💫🔥🌠🎇🎆") },
      { id: "food", label: "食物", emojis: splitEmojis("🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶🫑🌽🥕🫒🧄🧅🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🧈🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🫓🥪🥙🧆🌮🌯🫔🥗🥘🫕🥫🍝🍜🍲🍛🍣🍱🥟🦪🍤🍙🍚🍘🍥🥠🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪🌰🥜🍯🥛🍼☕🍵🧃🥤🧋🍶🍺🍻🥂🍷🥃🍸🍹🧉🍾🧊") },
      { id: "objects", label: "物件", emojis: splitEmojis("⌚📱💻⌨🖥🖨🖱🖲💽💾💿📀📼📷📸📹🎥📞☎📟📠📺📻🎙🎚🎛🧭⏱⏲⏰🕰⌛⏳📡🔋🔌💡🔦🕯🗑🛢💸💵💴💶💷💰💳🧾⚖🔧🔨⚒🛠⛏🔩⚙🧱⛓🧲🔫💣🧨🪓🔪🗡⚔🛡🚬⚰⚱🏺🔮📿🧿💈⚗🔭🔬🕳💊💉🩸🩹🩺🌡🧹🧺🧻🚽🚰🚿🛁🧼🧽🧴🛎🔑🗝🚪🪑🛋🛏🛌🧸🖼🛍🛒🎁🎈🎏🎀🎊🎉🎎🏮🎐✉📩📨📧💌📥📤📦🏷📪📫📬📭📮📯📜📃📄📑🧾📊📈📉🗒🗓📆📅📇🗃🗳🗄📋📁📂🗂🗞📰📓📔📒📕📗📘📙📚📖🔖🔗📎🖇📐📏🧮📌📍✂🖊🖋✒🖌🖍📝✏🔍🔎🔏🔐🔒🔓") },
      { id: "travel", label: "交通地标", emojis: splitEmojis("🚗🚕🚙🚌🚎🏎🚓🚑🚒🚐🛻🚚🚛🚜🛴🚲🛵🏍🛺🚨🚔🚍🚘🚖🚡🚠🚟🚃🚋🚞🚝🚄🚅🚈🚂🚆🚇🚊🚉✈🛫🛬🛩💺🛰🚀🛸🚁🛶⛵🚤🛥🛳⛴🚢⚓🚧⛽🚏🗽🗿🗼🏰🏯🏟🎡🎢🎠⛲⛱🏖🏝🏜🏕⛺🏠🏡🏘🏚🏗🏭🏢🏬🏣🏤🏥🏦🏨🏪🏫🏩💒🏛⛪🕌🕍🛕🕋⛩🛤🛣🗺") },
      { id: "symbols", label: "符号", emojis: splitEmojis("❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟☮✝☪🕉☸✡🔯🕎☯☦🛐⛎♈♉♊♋♌♍♎♏♐♑♒♓🆔⚛🉑☢☣📴📳🈶🈚🈸🈺🈷✴🆚💮🉐㊙㊗🈴🈵🈹🈲🅰🅱🆎🆑🅾🆘❌⭕🛑⛔📛🚫💯💢♨🚷🚯🚳🚱🔞📵🚭❗❕❓❔‼⁉🔅🔆〽⚠🚸🔱⚜🔰♻✅❇✳❎💠🌀💤🏧🚾♿🅿🈳🈂🛂🛃🛄🛅🚹🚺🚼🚻🚮🎦📶🈁🔣ℹ🔤🔡🔠🔢🔟") },
    ],

    /** Emoji 中文关键词（用于搜索增强，键为 Emoji 字符） */
    EMOJI_KEYWORDS: {
      "😀": "笑 开心 笑脸 表情", "😂": "笑 大笑 笑哭", "😊": "微笑 开心", "😍": "喜欢 爱心 爱", "🥰": "喜欢 爱",
      "😎": "酷 墨镜 自信", "🤔": "思考 想 疑问", "😭": "哭 难过 伤心", "😡": "生气 愤怒", "👍": "赞 好 支持",
      "🙏": "谢谢 拜托 祈祷", "👏": "鼓掌 表扬 厉害", "💪": "加油 力量 肌肉", "🔥": "火 热门 爆款",
      "✨": "闪光 亮点 星星", "⭐": "星 收藏 评分", "❤️": "爱心 喜欢 收藏", "💡": "想法 点子 灯泡",
      "📌": "图钉 固定 重点", "📚": "书 学习 阅读", "📝": "笔记 写 记录", "✏️": "铅笔 编辑 写",
      "🗂": "文件夹 整理", "📁": "文件夹 归档", "🗄": "数据库 归档", "🔍": "搜索 查找", "⚙": "设置 齿轮",
      "🔔": "提醒 通知 铃铛", "🌙": "月亮 夜晚 深色", "☀️": "太阳 白天 浅色", "🌍": "地球 世界",
      "🌱": "成长 种子 植物", "🌊": "海 波浪 水", "🏔": "山 高峰 山峰", "📅": "日期 日历 计划",
      "⏰": "提醒 闹钟 时间", "✅": "完成 勾选 对", "🚀": "火箭 启动 快速", "🏆": "奖杯 冠军 成就",
      "🎯": "目标 靶心 专注", "📈": "增长 上升 图表", "🧠": "大脑 学习 思维", "🔗": "链接 关联",
      "🗑": "删除 垃圾桶", "🖼": "图片 封面 相框", "🎨": "设计 调色 艺术", "🧩": "拼图 组件 模块",
      "💻": "电脑 编程 代码", "⌨": "键盘 代码 输入", "🌐": "网页 网络 全球", "📕": "书 手册 资料",
      "📄": "文件 页面 文档", "✂": "剪切 剪刀", "📋": "剪贴板 复制 清单", "🚗": "车 汽车 交通",
      "🏠": "家 房子 首页", "🎁": "礼物 赠品", "🔐": "锁 安全", "💰": "钱 财务 金钱",
    },

    /** 精选封面目录（自然 / 建筑 / 纹理），图片来自 Unsplash */
    COVER_CATALOG: [
      { id: "nature", label: "自然", items: [
        { alt: "优胜美地山谷", src: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "晨雾群山", src: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "山湖倒影", src: "https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1426604966848-d7adac402bff?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "湖光山色", src: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "森林阳光", src: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "绿林小径", src: "https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
      ] },
      { id: "architecture", label: "建筑", items: [
        { alt: "白色现代建筑", src: "https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "柱廊建筑", src: "https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "曲面建筑", src: "https://images.unsplash.com/photo-1486718448742-163732cd1544?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1486718448742-163732cd1544?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "建筑立面", src: "https://images.unsplash.com/photo-1494526585095-c41746248156?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1494526585095-c41746248156?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "城市天际线", src: "https://images.unsplash.com/photo-1479839672679-a46483c0e7c8?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1479839672679-a46483c0e7c8?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "现代大厦", src: "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1511818966892-d7d671e672a2?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
      ] },
      { id: "texture", label: "纹理", items: [
        { alt: "抽象纹理", src: "https://images.unsplash.com/photo-1550859492-d5da9d8e45f3?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1550859492-d5da9d8e45f3?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "紫色渐变", src: "https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "蓝色渐变", src: "https://images.unsplash.com/photo-1557683316-973673baf926?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1557683316-973673baf926?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "渐变抽象", src: "https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "柔和渐变", src: "https://images.unsplash.com/photo-1604076913837-52ab5629fba9?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1604076913837-52ab5629fba9?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
        { alt: "极简纸面", src: "https://images.unsplash.com/photo-1519750783826-e2420f4d687f?w=1600&q=80&fit=crop&auto=format", thumb: "https://images.unsplash.com/photo-1519750783826-e2420f4d687f?w=640&q=70&fit=crop&auto=format", credit: "Unsplash", creditUrl: "https://unsplash.com/" },
      ] },
      { id: "painting", label: "油画", items: [
        { alt: "梵高《星夜》(1889)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=640", credit: "梵高《星夜》", creditUrl: "https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg" },
        { alt: "莫奈《睡莲与日本桥》(1899)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet_-_Water_Lilies_and_Japanese_Bridge_-_Google_Art_Project.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet_-_Water_Lilies_and_Japanese_Bridge_-_Google_Art_Project.jpg?width=640", credit: "莫奈《睡莲与日本桥》", creditUrl: "https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Water_Lilies_and_Japanese_Bridge_-_Google_Art_Project.jpg" },
        { alt: "莫奈《印象·日出》(1872)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet%2C_Impression%2C_soleil_levant.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet%2C_Impression%2C_soleil_levant.jpg?width=640", credit: "莫奈《印象·日出》", creditUrl: "https://commons.wikimedia.org/wiki/File:Claude_Monet,_Impression,_soleil_levant.jpg" },
        { alt: "克林姆特《吻》(1907–1908)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg?width=640", credit: "克林姆特《吻》", creditUrl: "https://commons.wikimedia.org/wiki/File:The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg" },
        { alt: "塞尚《森林弯道》", src: "https://commons.wikimedia.org/wiki/Special:FilePath/GUGG_Bend_in_the_Road_Through_the_Forest.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/GUGG_Bend_in_the_Road_Through_the_Forest.jpg?width=640", credit: "塞尚《森林弯道》", creditUrl: "https://commons.wikimedia.org/wiki/File:GUGG_Bend_in_the_Road_Through_the_Forest.jpg" },
        { alt: "雷诺阿《河畔风景》(1890)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/Pierre-Auguste_Renoir_-_River_Landscape%2C_1890_-_Google_Art_Project.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/Pierre-Auguste_Renoir_-_River_Landscape%2C_1890_-_Google_Art_Project.jpg?width=640", credit: "雷诺阿《河畔风景》", creditUrl: "https://commons.wikimedia.org/wiki/File:Pierre-Auguste_Renoir_-_River_Landscape,_1890_-_Google_Art_Project.jpg" },
        { alt: "莫奈《睡莲》(1905)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet_-_Nymph%C3%A9as_(1905).jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet_-_Nymph%C3%A9as_(1905).jpg?width=640", credit: "莫奈《睡莲》", creditUrl: "https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Nymphéas_(1905).jpg" },
        { alt: "莫奈《睡莲池的云影》(1920–1926)", src: "https://commons.wikimedia.org/wiki/Special:FilePath/WLA_moma_Monet_Reflections_of_Clouds_on_the_Water-Lily_Pond.jpg?width=1600", thumb: "https://commons.wikimedia.org/wiki/Special:FilePath/WLA_moma_Monet_Reflections_of_Clouds_on_the_Water-Lily_Pond.jpg?width=640", credit: "莫奈《睡莲池》", creditUrl: "https://commons.wikimedia.org/wiki/File:WLA_moma_Monet_Reflections_of_Clouds_on_the_Water-Lily_Pond.jpg" },
      ] },
    ],
  };

  // 若已加载 i18n，挂载翻译函数（中文即 key）
  U.t = (global.I18n && I18n.t) ? function (s) { return I18n.t(s); } : (function (s) { return s; });
  global.U = U;
})(window);
