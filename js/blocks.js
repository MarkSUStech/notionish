/* ============ Block registry, rendering, rich-text serialization ============ */
(function (global) {
  "use strict";

  /* ---------- Rich text segments <-> HTML ---------- */
  function inlineMathHTML(line) {
    let out = "";
    let last = 0;
    const re = /\$([^$\n]+?)\$(?!\$)/g;
    let m;
    while ((m = re.exec(line))) {
      const latex = m[1];
      if (!latex.trim()) continue;
      if (m.index > 0 && line[m.index - 1] === "$") continue; // 避免 $$..$$ 被当成行内
      out += U.esc(line.slice(last, m.index));
      out += '<span class="nt-math" contenteditable="false" data-src="' + U.escAttr(m[0]) + '" data-math="' + U.escAttr(latex) + '">' + (MathR.renderInline(latex) || U.esc(latex)) + "</span>";
      last = m.index + m[0].length;
    }
    out += U.esc(line.slice(last));
    return out;
  }

  function segTextHTML(text) {
    return String(text == null ? "" : text)
      .split("\n")
      .map(inlineMathHTML)
      .map(line => line.replace(/\[\^(\d+)\]/g, (m, n) => '<sup class="cite-ref" contenteditable="false" data-ref="' + n + '">[' + n + ']</sup>'))
      .join("<br>");
  }

  /** 题目文本渲染：支持 $...$ 行内公式，并把 $$...$$ 降级为 $...$（复用现有公式渲染） */
  function qTextHTML(text) {
    const s = String(text == null ? "" : text).replace(/\$\$([^$\n]+?)\$\$/g, (_, l) => "$" + l.trim() + "$");
    return segTextHTML(s);
  }

  function safeLink(value) {
    const s = typeof value === "string" ? value.trim() : "";
    return /^https?:\/\//i.test(s) ? s : null;
  }

  function segsToHTML(segs) {
    if (!Array.isArray(segs)) return "";
    let out = "";
    segs.forEach(s => {
      if (s.mention) {
        const mp = Store.getPage(s.mention);
        const mlabel = (mp && !mp.deleted) ? ((mp.icon || "📄") + " " + (U.segsText(mp.title) || "未命名")) : "@已删除页面";
        out += '<span class="nt-mention" contenteditable="false" data-page="' + U.escAttr(s.mention) + '">' + U.esc(mlabel) + "</span>";
        return;
      }
      if (s.math != null) {
        const mathHtml = MathR.renderInline(s.math) || U.esc(s.math);
        out += '<span class="nt-math" contenteditable="false" data-math="' + U.escAttr(s.math) + '">' + mathHtml + "</span>";
        return;
      }
      let inner = segTextHTML(s.t || "");
      if (s.c) inner = "<code>" + inner + "</code>";
      let attrs = "";
      const styleParts = [];
      if (s.color) styleParts.push("color:" + (isDarkTheme() ? (TEXT_DARK_MAP[s.color.toLowerCase()] || s.color) : s.color));
      if (s.bg) styleParts.push("background-color:" + (isDarkTheme() ? (BG_DARK_MAP[s.bg.toLowerCase()] || s.bg) : s.bg));
      if (styleParts.length) attrs = ' style="' + styleParts.join(";") + '"';
      if (s.b || s.i || s.u || s.s || styleParts.length || s.link) {
        let html = inner;
        if (s.b) html = "<b>" + html + "</b>";
        if (s.i) html = "<i>" + html + "</i>";
        if (s.u) html = "<u>" + html + "</u>";
        if (s.s) html = "<s>" + html + "</s>";
        if (styleParts.length) html = '<span' + attrs + '>' + html + '</span>';
        const link = safeLink(s.link);
        if (link) html = '<a href="' + U.escAttr(link) + '" target="_blank" rel="noopener noreferrer">' + html + '</a>';
        out += html;
      } else {
        out += inner;
      }
    });
    return out;
  }

  function htmlToSegments(rootEl) {
    const segs = [];
    const walk = (node, fmt) => {
      if (node.nodeType === 3) {
        if (node.textContent) segs.push(Object.assign({ t: node.textContent }, fmt));
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.classList && node.classList.contains("cite-ref")) {
        const ref = node.getAttribute("data-ref");
        if (ref != null) segs.push(Object.assign({}, fmt, { t: "[^" + ref + "]" }));
        return;
      }
      if (node.classList && node.classList.contains("nt-math")) {
        const src = node.getAttribute("data-src");
        if (src != null) segs.push(Object.assign({}, fmt, { t: src }));
        else segs.push({ t: "", math: node.getAttribute("data-math") || "" });
        return;
      }
      if (node.classList && node.classList.contains("nt-mention")) {
        segs.push({ t: "", mention: node.getAttribute("data-page") || "" });
        return;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === "br") { segs.push(Object.assign({ t: "\n" }, fmt)); return; }
      const nf = Object.assign({}, fmt);
      if (tag === "b" || tag === "strong") nf.b = 1;
      else if (tag === "i" || tag === "em") nf.i = 1;
      else if (tag === "u") nf.u = 1;
      else if (tag === "s" || tag === "strike" || tag === "del") nf.s = 1;
      else if (tag === "code") nf.c = 1;
      else if (tag === "a") nf.link = node.getAttribute("href") || nf.link;
      const st = node.style;
      if (st && st.color) nf.color = TEXT_LIGHT_MAP[st.color.toLowerCase()] || st.color;
      if (st && st.backgroundColor) nf.bg = BG_LIGHT_MAP[st.backgroundColor.toLowerCase()] || st.backgroundColor;
      // serialize children of node
      const kids = Array.from(node.childNodes);
      if (!kids.length) { /* empty element */ }
      kids.forEach(k => walk(k, nf));
    };
    Array.from(rootEl.childNodes).forEach(n => walk(n, {}));
    // 归一化：去掉末尾孤立换行（contenteditable 清空后残留 <br> 会把空块存成 [{t:"\n"}]）
    while (segs.length && segs[segs.length - 1].t === "\n") segs.pop();
    return segs;
  }

  /** get text content of an editable element (normalizing <br>) */
  function edText(el) {
    const segs = htmlToSegments(el);
    return segs.map(s => s.t).join("");
  }

  /** source length of a math span ($latex$ counts as text) */
  function mathSpanLength(node) {
    const src = node.getAttribute("data-src");
    if (src != null) return src.length;
    const m = node.getAttribute("data-math");
    return m != null ? m.length + 2 : 0;
  }

  /** length of editable source text; math spans count as their $latex$ source */
  function editableTextLength(el) {
    let n = 0;
    const walk = (node) => {
      if (node.nodeType === 3) { n += node.textContent.length; return; }
      if (node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute("contenteditable") === "false") {
        if (node.classList && node.classList.contains("nt-math")) n += mathSpanLength(node);
        return;
      }
      for (const ch of node.childNodes) walk(ch);
    };
    walk(el);
    return n;
  }

  /** caret helpers (skip non-editable subtrees so math spans count as 0 chars) */
  function getCaretOffset(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { node: el, offset: 0, textOffset: 0 };
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return { node: el, offset: 0, textOffset: 0 };
    // 光标直接落在可编辑元素上（空块 / selectNodeContents）
    if (range.startContainer === el) {
      let c = 0;
      Array.from(el.childNodes).slice(0, range.startOffset).forEach(ch => { c += editableTextLength(ch); });
      return { node: el, offset: range.startOffset, textOffset: c };
    }
    let count = 0;
    let found = false;
    const walk = (node) => {
      if (found) return;
      if (node.nodeType === 3) {
        if (node === range.startContainer) { count += range.startOffset; found = true; return; }
        count += node.textContent.length;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute("contenteditable") === "false") {
        if (node.classList && node.classList.contains("nt-math")) count += mathSpanLength(node);
        return;
      }
      for (const ch of node.childNodes) walk(ch);
    };
    walk(el);
    return { node: range.startContainer, offset: range.startOffset, textOffset: count };
  }

  function setCaret(el, textOffset) {
    const sel = window.getSelection();
    const range = document.createRange();
    let remaining = Math.max(0, textOffset || 0);
    let placed = false;
    const walk = (node) => {
      if (placed) return;
      if (node.nodeType === 3) {
        const len = node.textContent.length;
        if (remaining <= len) {
          range.setStart(node, remaining);
          range.collapse(true);
          placed = true;
          return;
        }
        remaining -= len;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute("contenteditable") === "false") {
        if (node.classList && node.classList.contains("nt-math")) remaining -= mathSpanLength(node);
        return;
      }
      for (const ch of node.childNodes) walk(ch);
    };
    walk(el);
    if (!placed) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** DOM Range from editable-text offsets (skips non-editable subtrees) */
  function textRange(el, start, end) {
    const range = document.createRange();
    let pos = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    let started = false, done = false;
    const walk = (node) => {
      if (done) return;
      if (node.nodeType === 3) {
        const len = node.textContent.length;
        const ns = pos, ne = pos + len;
        if (!started && ne > start) { startNode = node; startOff = Math.max(0, start - ns); started = true; }
        if (started && ne >= end) { endNode = node; endOff = Math.min(len, end - ns); done = true; return; }
        pos = ne;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute("contenteditable") === "false") {
        if (node.classList && node.classList.contains("nt-math")) pos += mathSpanLength(node);
        return;
      }
      for (const ch of node.childNodes) walk(ch);
    };
    walk(el);
    if (!startNode || !endNode) return null;
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  }

  /** editable-text offset just before a given node inside an .ed */
  function textOffsetBeforeNode(ed, node) {
    let count = 0;
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (n === node) { found = true; return; }
      if (n.nodeType === 3) { count += n.textContent.length; return; }
      if (n.nodeType !== 1) return;
      if (n.getAttribute && n.getAttribute("contenteditable") === "false") return;
      for (const ch of n.childNodes) walk(ch);
    };
    walk(ed);
    return count;
  }

  /** true when caret sits right after a leading non-editable span (let Backspace delete it) */
  function caretAfterLeadingNonEditable(ed) {
    const first = ed.firstChild;
    if (!first || first.nodeType !== 1 || first.getAttribute("contenteditable") !== "false") return false;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    return range.startContainer === first.nextSibling && range.startOffset === 0;
  }

  /** 当光标紧跟在块首的不可编辑元素（如行内公式）之后时，返回该元素 */
  function leadingNonEditable(ed) {
    const first = ed.firstChild;
    if (!first || first.nodeType !== 1 || first.getAttribute("contenteditable") !== "false") return null;
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (range.startContainer === first.nextSibling && range.startOffset === 0) return first;
    if (range.startContainer === ed && range.startOffset >= 1) return first;
    return null;
  }

  function caretAtStart(el) {
    const c = getCaretOffset(el);
    return c.textOffset === 0;
  }
  function caretAtEnd(el) {
    const c = getCaretOffset(el);
    return c.textOffset >= editableTextLength(el);
  }

  /* ---------- Color palettes ---------- */
  // v = 浅色主题值（也是存储值），dark = 深色主题值
  const TEXT_COLORS = [
    { name: "默认", cls: "color-default", v: null },
    { name: "灰色", cls: "color-gray", v: "#787774", dark: "#9b9b9b" },
    { name: "棕色", cls: "color-brown", v: "#9f6b53", dark: "#c98f72" },
    { name: "橙色", cls: "color-orange", v: "#d9730d", dark: "#e8a04c" },
    { name: "黄色", cls: "color-yellow", v: "#caa63b", dark: "#d9bb62" },
    { name: "绿色", cls: "color-green", v: "#448361", dark: "#6aa68a" },
    { name: "蓝色", cls: "color-blue", v: "#337ea9", dark: "#6aaed1" },
    { name: "紫色", cls: "color-purple", v: "#9065b0", dark: "#b28bd0" },
    { name: "粉色", cls: "color-pink", v: "#c14c8d", dark: "#d97aa8" },
    { name: "红色", cls: "color-red", v: "#d44c47", dark: "#e08a87" },
  ];
  const BG_COLORS = [
    { name: "默认", cls: "bg-default", v: null },
    { name: "灰色", cls: "bg-gray", v: "#f1f1ef", dark: "#2f2f2f" },
    { name: "棕色", cls: "bg-brown", v: "#f4eeee", dark: "#3a2e28" },
    { name: "橙色", cls: "bg-orange", v: "#fbecdd", dark: "#3a2e1c" },
    { name: "黄色", cls: "bg-yellow", v: "#fbf3db", dark: "#39341d" },
    { name: "绿色", cls: "bg-green", v: "#edf3ec", dark: "#26322a" },
    { name: "蓝色", cls: "bg-blue", v: "#e7f3f8", dark: "#1f2f38" },
    { name: "紫色", cls: "bg-purple", v: "#f6f3f9", dark: "#30283a" },
    { name: "粉色", cls: "bg-pink", v: "#faedf4", dark: "#3a2632" },
    { name: "红色", cls: "bg-red", v: "#fdebec", dark: "#3d2726" },
  ];

  // 浅色值 → 深色值（渲染用）
  const TEXT_DARK_MAP = Object.fromEntries(TEXT_COLORS.filter(c => c.v && c.dark).map(c => [c.v.toLowerCase(), c.dark]));
  const BG_DARK_MAP = Object.fromEntries(BG_COLORS.filter(c => c.v && c.dark).map(c => [c.v.toLowerCase(), c.dark]));
  // 深色值 → 浅色值（序列化反向映射，保持存储统一为浅色值）
  const TEXT_LIGHT_MAP = Object.fromEntries(TEXT_COLORS.filter(c => c.v && c.dark).map(c => [c.dark.toLowerCase(), c.v]));
  const BG_LIGHT_MAP = Object.fromEntries(BG_COLORS.filter(c => c.v && c.dark).map(c => [c.dark.toLowerCase(), c.v]));

  const isDarkTheme = () => !!(global.document && document.documentElement && document.documentElement.getAttribute && document.documentElement.getAttribute("data-theme") === "dark");

  /* ---------- Block registry ---------- */
  const BLOCK_TYPES = {};

  function reg(type, def) { BLOCK_TYPES[type] = def; }

  /** base editable element for a block */
  function edEl(block, cls, ph) {
    const ed = U.el("div", "ed " + (cls || "p"));
    ed.contentEditable = "true";
    ed.spellcheck = false;
    ed.dataset.blockId = block.id;
    ed.dataset.ph = ph || "输入文字，或输入 / 查看命令…";
    ed.innerHTML = segsToHTML(block.text);
    return ed;
  }

  function buildChildren(block, ctx) {
    if (!block.children || !block.children.length) return null;
    const wrap = U.el("div", "toggle-children");
    block.children.forEach(c => wrap.appendChild(renderBlock(c, ctx)));
    return wrap;
  }

  function renderBlock(block, ctx) {
    ctx = ctx || {};
    const type = BLOCK_TYPES[block.type] ? block.type : "paragraph";
    const outer = U.el("div", "block b-" + type);
    outer.dataset.blockId = block.id;
    outer.dataset.type = type;
    if (block.indent && ["paragraph","heading1","heading2","heading3","quote","callout"].includes(type)) {
      outer.classList.add("iv-" + Math.min(5, block.indent));
    }
    const inner = U.el("div", "block-inner");
    outer.appendChild(inner);
    const ghost = U.el("div", "b-ghost");
    inner.appendChild(ghost);
    const tools = U.el("div", "b-tools");
    const addBtn = U.el("button", "b-add-btn", "＋");
    addBtn.title = "在下方插入块";
    addBtn.dataset.blockId = block.id;
    const grip = U.el("span", "b-grip", "⋮⋮");
    grip.title = "拖拽移动 (右键更多操作)";
    grip.draggable = true;
    grip.dataset.blockId = block.id;
    tools.appendChild(addBtn);
    tools.appendChild(grip);
    if (block.comments && block.comments.length) {
      const c = U.el("button", "b-comment", "💬" + block.comments.length);
      c.title = "查看评论";
      c.dataset.blockId = block.id;
      tools.appendChild(c);
    }
    inner.appendChild(tools);

    const def = BLOCK_TYPES[type];
    let content = null;
    try { content = def.render ? def.render(block, ctx, inner) : edEl(block, "p"); } catch (e) { content = edEl(block, "p"); }
    if (content) inner.appendChild(content);

    // nested children (toggle / template)
    if (block.type === "toggle" || block.type === "template") {
      const kids = buildChildren(block, ctx);
      if (kids) inner.appendChild(kids);
      if (block.folded) outer.classList.add("folded");
    }
    return outer;
  }

  /* ---------------- type definitions ---------------- */
  reg("paragraph", { label: "正文", icon: "📄", desc: "普通文本", render(b) { return edEl(b, "p"); } });
  reg("heading1", { label: "标题 1", icon: "H1", desc: "大标题", render(b) { return edEl(b, "h1", "标题 1"); } });
  reg("heading2", { label: "标题 2", icon: "H2", desc: "中标题", render(b) { return edEl(b, "h2", "标题 2"); } });
  reg("heading3", { label: "标题 3", icon: "H3", desc: "小标题", render(b) { return edEl(b, "h3", "标题 3"); } });
  reg("bullet", { label: "无序列表", icon: "•", desc: "圆点列表", render(b) {
    const row = U.el("div", "b-list-row");
    row.appendChild(U.el("span", "b-marker"));
    row.appendChild(edEl(b, "p"));
    return row;
  }});
  reg("numbered", { label: "有序列表", icon: "1.", desc: "数字列表", render(b) {
    const row = U.el("div", "b-list-row");
    row.appendChild(U.el("span", "b-marker"));
    row.appendChild(edEl(b, "p"));
    return row;
  }});
  reg("todo", { label: "待办事项", icon: "☑", desc: "带复选框的任务", render(b, ctx, inner) {
    const row = U.el("div", "b-list-row");
    const cb = U.el("span", "b-checkbox" + (b.checked ? " checked" : ""));
    cb.textContent = b.checked ? "✓" : "";
    cb.dataset.blockId = b.id;
    cb.title = "切换完成状态";
    row.appendChild(cb);
    row.appendChild(edEl(b, "p"));
    if (b.checked) row.classList.add("done");
    return row;
  }});
  reg("toggle", { label: "折叠列表", icon: "▸", desc: "可展开/收起的块", render(b, ctx) {
    const row = U.el("div", "b-list-row");
    const caret = U.el("span", "toggle-caret", "▾");
    caret.dataset.blockId = b.id;
    caret.title = "展开/折叠";
    row.appendChild(caret);
    row.appendChild(edEl(b, "p"));
    return row;
  }});
  reg("quote", { label: "引用", icon: "❝", desc: "引用文字", render(b) {
    const wrap = U.el("div", "b-quote");
    wrap.appendChild(edEl(b, "p", "引用文字…"));
    return wrap;
  }});
  reg("callout", { label: "提示框", icon: "💡", desc: "带图标的强调块", render(b) {
    const wrap = U.el("div", "b-callout");
    const ico = U.el("span", "co-ico", b.attrs.icon || "💡");
    ico.dataset.blockId = b.id;
    ico.title = "点击更换图标";
    wrap.appendChild(ico);
    wrap.appendChild(edEl(b, "p", "输入文字…"));
    return wrap;
  }});
  reg("divider", { label: "分割线", icon: "―", desc: "水平分割线", render() { return U.el("div", "b-divider"); } });
  reg("code", { label: "代码", icon: "</>", desc: "代码块（支持语法高亮）", render(b) {
    const wrap = U.el("div", "b-code");
    const head = U.el("div", "code-head");
    const langSel = U.el("select", "sn-lang");
    const LANGS = [
      "javascript","typescript","python","java","c","cpp","c++","csharp","rust","go",
      "ruby","swift","kotlin","scala","php","perl","lua","r","dart","julia",
      "html","css","sass","scss","less","xml","json","yaml","toml","markdown",
      "sql","bash","shell","powershell","sh","zsh","dockerfile","makefile","cmake",
      "nginx","apache","ini","gitignore","env","plaintext"
    ];
    LANGS.forEach(l => {
      const o = U.el("option", null, l === "cpp" ? "c++" : l === "csharp" ? "c#" : l);
      o.value = l;
      if (l === (b.attrs.language || "text")) o.selected = true;
      langSel.appendChild(o);
    });
    head.appendChild(langSel);
    const copyBtn = U.el("button", "tb-btn", "⧉");
    copyBtn.title = "复制代码";
    copyBtn.dataset.blockId = b.id;
    head.appendChild(copyBtn);
    wrap.appendChild(head);
    // 显示区域：语法高亮的只读 pre
    const display = U.el("pre", "b-code-display");
    display.dataset.blockId = b.id;
    const source = b.attrs.source || "";
    const lang = (b.attrs.language || "text").replace("plaintext","text");
    display.innerHTML = IDE && IDE.highlight ? IDE.highlight(source, lang) : U.esc(source);
    wrap.appendChild(display);
    // 编辑区域：textarea（默认隐藏）
    const ta = U.el("textarea", "b-code-edit");
    ta.value = source;
    ta.placeholder = "输入代码…";
    ta.spellcheck = false;
    ta.dataset.blockId = b.id;
    ta.hidden = true;
    wrap.appendChild(ta);
    // 点击显示区切换编辑模式
    display.addEventListener("click", () => {
      display.hidden = true;
      ta.hidden = false;
      ta.focus();
      const rows = Math.min(25, Math.max(3, ta.value.split("\n").length));
      ta.rows = rows;
    });
    // 失焦后保存并切回显示模式
    ta.addEventListener("blur", () => {
      b.attrs.source = ta.value;
      display.innerHTML = IDE && IDE.highlight ? IDE.highlight(ta.value, lang) : U.esc(ta.value);
      display.hidden = false;
      ta.hidden = true;
      if (global.Store) { global.Store.markDirty(); global.Store.save(true); }
    });
    // 语言切换时更新高亮
    langSel.addEventListener("change", () => {
      b.attrs.language = langSel.value;
      const newLang = langSel.value.replace("plaintext","text");
      display.innerHTML = IDE && IDE.highlight ? IDE.highlight(b.attrs.source || "", newLang) : U.esc(b.attrs.source || "");
      if (global.Store) { global.Store.markDirty(); global.Store.save(true); }
    });
    return wrap;
  }});
  reg("image", { label: "图片", icon: "🖼", desc: "上传或粘贴图片", render(b, ctx) {
    const wrap = U.el("div", "b-img");
    if (b.attrs.src) {
      const imgWrap = U.el("div", "b-img-inner");
      if (b.attrs.imgWidth) imgWrap.style.width = b.attrs.imgWidth;
      const img = U.el("img");
      img.src = b.attrs.src;
      img.dataset.blockId = b.id;
      imgWrap.appendChild(img);
      // 缩放把手（仅在非静默模式下）
      if (!ctx.silent) {
        const handle = U.el("div", "b-img-resize");
        handle.title = "拖拽缩放图片";
        imgWrap.appendChild(handle);
        // 缩放拖拽逻辑
        let dragging = false, startX, startW;
        handle.addEventListener("mousedown", e => {
          e.preventDefault();
          e.stopPropagation();
          dragging = true;
          startX = e.clientX;
          startW = imgWrap.getBoundingClientRect().width;
          document.body.style.cursor = "ew-resize";
          document.body.style.userSelect = "none";
        });
        document.addEventListener("mousemove", e => {
          if (!dragging) return;
          const dx = e.clientX - startX;
          const newW = Math.max(80, startW + dx);
          const parentW = wrap.parentElement ? wrap.parentElement.getBoundingClientRect().width : 700;
          const pct = Math.round(newW / parentW * 100);
          imgWrap.style.width = pct + "%";
        });
        document.addEventListener("mouseup", () => {
          if (dragging) {
            dragging = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            const w = imgWrap.style.width;
            if (w && w !== "100%") b.attrs.imgWidth = w;
            else delete b.attrs.imgWidth;
            if (global.Store) { global.Store.markDirty(); global.Store.save(true); }
          }
        });
      }
      wrap.appendChild(imgWrap);
      if (!ctx.silent) {
        const caption = (b.attrs.caption && b.attrs.caption.length && b.attrs.caption.some(s => (s.t || "").trim())) ? b.attrs.caption : null;
        if (caption) {
          const cap = edEl(Object.assign({}, b, { text: caption }), "p", "添加说明…");
          cap.classList.add("cap");
          cap.dataset.blockId = b.id;
          wrap.appendChild(cap);
        }
      }
    } else {
      const ph = U.el("div", "embed-ph", "点击上传图片");
      ph.dataset.blockId = b.id;
      wrap.appendChild(ph);
    }
    return wrap;
  }});
  reg("embed", { label: "嵌入", icon: "🔗", desc: "嵌入网页 (iframe)", render(b, ctx) {
    const wrap = U.el("div", "b-embed");
    const bar = U.el("div", "embed-bar");
    const input = U.el("input", "embed-url");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = "输入网址，如 example.com…";
    input.value = b.attrs.url || "";
    const open = U.el("button", "embed-open", "↗");
    open.title = "在新标签页打开";
    bar.appendChild(input);
    bar.appendChild(open);
    wrap.appendChild(bar);

    const body = U.el("div", "embed-body");
    if (b.attrs.url) {
      const iframe = U.el("iframe");
      iframe.src = b.attrs.url;
      iframe.dataset.blockId = b.id;
      iframe.allow = "fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture";
      iframe.referrerPolicy = "no-referrer-when-downgrade";
      body.appendChild(iframe);
    } else {
      const ph = U.el("div", "embed-ph", "输入网址后按回车嵌入");
      ph.dataset.blockId = b.id;
      body.appendChild(ph);
    }
    wrap.appendChild(body);

    const apply = (url) => {
      const raw = String(url || "").trim();
      if (!raw) return;
      const normalized = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
      b.attrs.url = normalized;
      input.value = normalized;
      Store.markDirty();
      if (global.Editor && ctx.page) Editor.refresh({ id: b.id });
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(input.value); } });
    open.addEventListener("click", () => { if (b.attrs.url) window.open(b.attrs.url, "_blank"); });
    return wrap;
  }});
  reg("pdf", { label: "PDF", icon: "📕", desc: "嵌入 PDF 文档", render(b, ctx) {
    const wrap = U.el("div", "b-pdf");
    const bar = U.el("div", "embed-bar");
    const input = U.el("input", "embed-url");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = "输入 PDF 网址";
    input.value = b.attrs.url || "";
    const pageInput = U.el("input", "pdf-page-input");
    pageInput.type = "number";
    pageInput.min = 1;
    pageInput.value = b.attrs.page || 1;
    pageInput.title = "默认显示第几页";
    const open = U.el("button", "embed-open", "↗");
    open.title = "在新标签页打开";
    bar.appendChild(input); bar.appendChild(pageInput); bar.appendChild(open);
    wrap.appendChild(bar);

    const body = U.el("div", "embed-body");
    const src = b.attrs.url || b.attrs.src;
    if (src) {
      const normalized = /^https?:\/\//i.test(src) || /^data:/i.test(src) ? src : "https://" + src;
      const withPage = /^https?:\/\//i.test(normalized) && (b.attrs.page || 1) > 1 ? normalized + "#page=" + (b.attrs.page || 1) : normalized;
      const iframe = U.el("iframe");
      iframe.src = withPage;
      iframe.dataset.blockId = b.id;
      iframe.allow = "fullscreen; clipboard-read; clipboard-write";
      body.appendChild(iframe);
    } else {
      const ph = U.el("div", "embed-ph", "输入 PDF 网址后按回车嵌入");
      ph.dataset.blockId = b.id;
      body.appendChild(ph);
    }
    wrap.appendChild(body);

    const apply = () => {
      const raw = String(input.value || "").trim();
      b.attrs.page = Math.max(1, parseInt(pageInput.value, 10) || 1);
      pageInput.value = b.attrs.page;
      if (raw) { b.attrs.url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw; input.value = b.attrs.url; }
      Store.markDirty();
      if (global.Editor && ctx.page) Editor.refresh({ id: b.id });
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
    pageInput.addEventListener("change", apply);
    open.addEventListener("click", () => { if (src) window.open(src, "_blank"); });
    return wrap;
  }});
  reg("highlight", { label: "引用高亮", icon: "🖍", desc: "PDF 荧光笔引用", render(b, ctx) {
    const wrap = U.el("div", "b-highlight");
    wrap.dataset.blockId = b.id;
    const ico = U.el("span", "b-hl-ico", "🖍");
    const body = U.el("div", null);
    const t = U.el("div", "b-hl-text", "“" + U.esc(b.attrs.hlText || "（空）") + "”");
    const src = U.el("div", "b-hl-src", "第 " + (b.attrs.hlPage || 1) + " 页 · 点击跳转到原文");
    body.appendChild(t); body.appendChild(src);
    wrap.appendChild(ico); wrap.appendChild(body);
    return wrap;
  }});
  reg("pdfimage", { label: "引用图片", icon: "🖼", desc: "PDF 图片引用", render(b, ctx) {
    const wrap = U.el("div", "b-pdfimage");
    wrap.dataset.blockId = b.id;
    if (b.attrs.imgThumb) {
      const img = U.el("img", "b-pdfimage-thumb");
      img.src = b.attrs.imgThumb;
      img.alt = "PDF 图片";
      wrap.appendChild(img);
    } else {
      wrap.appendChild(U.el("span", "b-pdfimage-ico", "🖼"));
    }
    const src = U.el("div", "b-pdfimage-src", "第 " + (b.attrs.imgPage || 1) + " 页 · 点击跳转到原文");
    wrap.appendChild(src);
    return wrap;
  }});
  reg("bookmark", { label: "书签", icon: "🔖", desc: "网页书签", render(b, ctx) {
    const wrap = U.el("div", "b-bookmark");
    wrap.dataset.blockId = b.id;
    const ico = U.el("span", "fi-ico", "🔖");
    const body = U.el("div", null);
    const t = U.el("div", "bk-title", b.attrs.title || b.attrs.url || "添加书签");
    const u = U.el("div", "bk-url", b.attrs.url || "点击编辑网址");
    body.appendChild(t); body.appendChild(u);
    wrap.appendChild(ico); wrap.appendChild(body);
    return wrap;
  }});
  reg("file", { label: "文件", icon: "📎", desc: "上传文件", render(b, ctx) {
    const wrap = U.el("div", "b-file");
    wrap.dataset.blockId = b.id;
    const ico = U.el("span", "fi-ico", "📎");
    const nm = U.el("span", "fi-name", b.attrs.name || (b.attrs.src ? "已上传文件" : "点击上传文件"));
    wrap.appendChild(ico); wrap.appendChild(nm);
    return wrap;
  }});
  reg("table", { label: "表格", icon: "⊞", desc: "简易表格", render(b, ctx) {
    const rows = (b.attrs.rows || []).map(r => (r || []).map(c => Array.isArray(c) ? c : (c ? [c] : [])));
    if (!rows.length) rows.push([[{ t: "" }], [{ t: "" }]]);
    const ncol = Math.max(1, b.attrs.cols || (rows[0] ? rows[0].length : 2));
    rows.forEach(r => { while (r.length < ncol) r.push([{ t: "" }]); });
    const wrap = U.el("div", "b-table-wrap");
    const tb = U.el("table", "b-table" + (b.attrs.header ? " has-header" : ""));
    rows.forEach((r, ri) => {
      const tr = U.el("tr");
      if (!ctx.silent) {
        const rctl = U.el("td", "tc-ctl");
        const rdel = U.el("span", "tc-rowdel", "✕");
        rdel.title = "删除此行";
        rdel.dataset.blockId = b.id;
        rdel.dataset.role = "row-del";
        rdel.dataset.row = ri;
        rctl.appendChild(rdel);
        tr.appendChild(rctl);
      }
      for (let ci = 0; ci < ncol; ci++) {
        const cell = U.el(ri === 0 && b.attrs.header ? "th" : "td");
        const ed = U.el("div", "ed p");
        ed.contentEditable = "true";
        ed.spellcheck = false;
        ed.innerHTML = segsToHTML(r[ci] || []);
        ed.dataset.blockId = b.id;
        ed.dataset.row = ri;
        ed.dataset.col = ci;
        cell.appendChild(ed);
        if (!ctx.silent && ri === 0) {
          const cdel = U.el("span", "tc-del", "✕");
          cdel.title = "删除此列";
          cdel.dataset.blockId = b.id;
          cdel.dataset.role = "col-del";
          cdel.dataset.col = ci;
          cell.appendChild(cdel);
        }
        tr.appendChild(cell);
      }
      tb.appendChild(tr);
    });
    wrap.appendChild(tb);
    if (!ctx.silent) {
      const bar = U.el("div", "tc-bar");
      const addRow = U.el("button", "tc-add", "＋ 行");
      addRow.dataset.blockId = b.id;
      addRow.dataset.role = "add-row";
      addRow.title = "新增一行";
      const addCol = U.el("button", "tc-add", "＋ 列");
      addCol.dataset.blockId = b.id;
      addCol.dataset.role = "add-col";
      addCol.title = "新增一列";
      bar.appendChild(addRow);
      bar.appendChild(addCol);
      wrap.appendChild(bar);
    }
    return wrap;
  }});
  reg("equation", { label: "公式", icon: "∑", desc: "LaTeX 行间公式", render(b, ctx) {
    const wrap = U.el("div", "b-equation");
    const raw = U.segsText(b.text).trim();
    const latex = raw.replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
    const preview = U.el("div", "eq-preview" + (latex ? "" : " eq-empty"));
    preview.dataset.blockId = b.id;
    if (latex) {
      preview.innerHTML = MathR.renderDisplay(latex) || '<span style="color:var(--text-faint)">' + U.esc(latex) + "</span>";
    } else {
      preview.textContent = "点击输入 LaTeX 公式…";
    }
    wrap.appendChild(preview);
    // 源码行（点击后显示，无框）：直接显示 $$...$$，回车换行到下一块
    const src = U.el("div", "eq-source");
    src.contentEditable = "true";
    src.spellcheck = false;
    src.dataset.blockId = b.id;
    src.textContent = raw || "$$";
    wrap.appendChild(src);
    return wrap;
  }});
  reg("mermaid", { label: "图表", icon: "▦", desc: "Mermaid 图表", render(b, ctx) {
    const wrap = U.el("div", "b-mermaid");
    const head = U.el("div", "mm-head");
    head.appendChild(U.el("span", "mm-label", "Mermaid 图表"));
    const fixBtn = U.el("button", "mm-btn mm-fix", "🛠 修复");
    fixBtn.dataset.blockId = b.id;
    fixBtn.dataset.role = "mm-fix";
    fixBtn.title = "用 AI 修复图表（描述问题）";
    head.appendChild(fixBtn);
    const btn = U.el("button", "mm-btn", "渲染");
    btn.dataset.blockId = b.id;
    btn.dataset.role = "mm-render";
    btn.title = "渲染图表";
    head.appendChild(btn);
    wrap.appendChild(head);
    const ta = U.el("textarea", "mm-edit");
    ta.spellcheck = false;
    ta.value = b.attrs.source || "";
    ta.placeholder = "输入 Mermaid 源码，例如 graph TD; A-->B";
    ta.dataset.blockId = b.id;
    wrap.appendChild(ta);
    const preview = U.el("div", "mm-preview");
    preview.dataset.blockId = b.id;
    preview.hidden = true;
    wrap.appendChild(preview);
    const err = U.el("div", "mm-error");
    err.dataset.blockId = b.id;
    err.hidden = true;
    wrap.appendChild(err);
    return wrap;
  }});
  reg("html", { label: "交互网页", icon: "🧩", desc: "可交互 HTML（可视化教学）", render(b, ctx) {
    const wrap = U.el("div", "b-html");
    wrap.dataset.blockId = b.id;
    const bar = U.el("div", "b-html-bar");
    bar.appendChild(U.el("span", "b-html-label", "🧩 交互网页"));
    const fixBtn = U.el("button", "b-html-btn", "🛠 修复");
    fixBtn.dataset.blockId = b.id;
    fixBtn.dataset.role = "html-fix";
    fixBtn.title = "用 AI 修复网页（描述问题）";
    bar.appendChild(fixBtn);
    const editBtn = U.el("button", "b-html-btn", "✏️ 编辑");
    editBtn.dataset.blockId = b.id;
    editBtn.dataset.role = "html-edit";
    editBtn.title = "编辑 HTML 源码";
    bar.appendChild(editBtn);
    wrap.appendChild(bar);
    const frame = U.el("iframe", "b-html-frame");
    frame.setAttribute("sandbox", "allow-scripts allow-popups");
    frame.srcdoc = b.attrs.source || '<div style="color:#999;padding:24px;font-family:sans-serif;text-align:center">空交互网页（可在块菜单编辑 HTML）</div>';
    frame.title = "交互网页";
    wrap.appendChild(frame);
    return wrap;
  }});
  reg("page", { label: "子页面", icon: "📄", desc: "嵌入的子页面", render(b, ctx) {
    const wrap = U.el("div", "b-page-ref");
    wrap.dataset.blockId = b.id;
    const target = b.attrs.pageId ? Store.getPage(b.attrs.pageId) : null;
    const ico = U.el("span", "pr-ico", target && target.icon ? target.icon : "📄");
    const nm = U.el("span", "pr-name", target ? (U.segsText(target.title) || "未命名页面") : "子页面");
    wrap.appendChild(ico); wrap.appendChild(nm);
    return wrap;
  }});
  reg("database", { label: "数据库", icon: "🗄", desc: "数据库页面", render(b, ctx) {
    const wrap = U.el("div", "b-db-ref");
    wrap.dataset.blockId = b.id;
    const target = b.attrs.pageId ? Store.getPage(b.attrs.pageId) : null;
    const ico = U.el("span", "pr-ico", "🗄");
    const nm = U.el("span", "pr-name", target ? (U.segsText(target.title) || "数据库") : "数据库");
    wrap.appendChild(ico); wrap.appendChild(nm);
    return wrap;
  }});
  reg("snippet", { label: "代码片段", icon: "⌗", desc: "可关联代码文件的笔记片段", render(b) {
    const wrap = U.el("div", "b-snippet");
    const head = U.el("div", "sn-head");
    const langSel = U.el("select", "sn-lang");
    ["python", "c", "cpp", "java", "javascript", "text"].forEach(l => {
      const o = U.el("option", null, l);
      o.value = l;
      if (l === (b.attrs.language || "text")) o.selected = true;
      langSel.appendChild(o);
    });
    langSel.addEventListener("change", () => { b.attrs.language = langSel.value; Store.markDirty(); });
    head.appendChild(langSel);
    const link = U.el("span", "sn-link" + (b.attrs.pageId ? " linked" : ""));
    link.dataset.blockId = b.id;
    const target = b.attrs.pageId ? Store.getPage(b.attrs.pageId) : null;
    if (target && !target.deleted) {
      link.innerHTML = '<span class="sn-link-ico">↪</span><span class="sn-link-label">' + U.esc((target.icon || "⌨") + " " + (U.segsText(target.title) || "未命名")) + '</span>';
    } else {
      link.innerHTML = '<span class="sn-link-ico">⊕</span><span class="sn-link-label">关联代码文件</span>';
    }
    head.appendChild(link);
    wrap.appendChild(head);
    const ta = U.el("textarea", "sn-code");
    ta.spellcheck = false;
    ta.value = b.attrs.source || "";
    ta.placeholder = "输入代码片段…";
    ta.dataset.blockId = b.id;
    wrap.appendChild(ta);
    return wrap;
  }});
  reg("question", { label: "题目", icon: "❓", desc: "独立保存的练习题", render(b, ctx) {
    const q = b.attrs.qid ? Store.getQuestion(b.attrs.qid) : null;
    const QTYPE = { single: "单选", multiple: "多选", judge: "判断", fill: "填空", short_answer: "简答" };
    const wrap = U.el("div", "b-question");
    wrap.dataset.blockId = b.id;
    const isExam = ctx.isExam && !ctx.examSubmitted;
    const submitted = ctx.examSubmitted;

    const head = U.el("div", "q-head");
    head.appendChild(U.el("span", "q-type", q ? (QTYPE[q.type] || "单选") : "题目"));
    if (!isExam) {
      const edit = U.el("button", "q-edit", "编辑");
      edit.dataset.blockId = b.id;
      const reveal = U.el("button", "q-reveal", "显示答案");
      reveal.type = "button";
      reveal.addEventListener("click", () => {
        const showing = wrap.classList.toggle("revealed");
        reveal.textContent = showing ? "隐藏答案" : "显示答案";
      });
      head.appendChild(reveal);
      head.appendChild(edit);
    }
    wrap.appendChild(head);

    const body = U.el("div", "q-body");
    if (q && q.prompt) {
      body.appendChild(U.el("div", "q-prompt", qTextHTML(q.prompt)));
      if (isExam) {
        // 考试模式：显示作答控件
        const ansWrap = U.el("div", "q-exam-ans");
        if (q.type === "judge") {
          ansWrap.appendChild(examRadio("q" + b.id, "true", "对"));
          ansWrap.appendChild(examRadio("q" + b.id, "false", "错"));
        } else if (q.type === "single") {
          (q.options || []).forEach((opt, i) => ansWrap.appendChild(examRadio("q" + b.id, String(i), qTextHTML(opt))));
        } else if (q.type === "multiple") {
          (q.options || []).forEach((opt, i) => ansWrap.appendChild(examCheck("q" + b.id, String(i), qTextHTML(opt))));
        } else if (q.type === "fill") {
          const inp = U.el("input", "q-exam-input");
          inp.type = "text";
          inp.placeholder = "输入答案…";
          inp.dataset.qid = b.id;
          ansWrap.appendChild(inp);
        } else {
          const ta = U.el("textarea", "q-exam-textarea");
          ta.placeholder = "输入答案…";
          ta.rows = 3;
          ta.dataset.qid = b.id;
          ansWrap.appendChild(ta);
        }
        body.appendChild(ansWrap);
        // 批改结果
        if (submitted) {
          const result = ctx.examResults && ctx.examResults[b.id];
          const resEl = U.el("div", "q-exam-result " + (result && result.correct ? "q-correct" : "q-wrong"));
          resEl.innerHTML = result
            ? (result.correct ? "✅ 正确" : "❌ 错误" + (result.refAnswer ? "，参考答案：" + U.esc(result.refAnswer) : ""))
            : "⏳ 待批改";
          body.appendChild(resEl);
        }
      } else {
        // 普通模式：显示答案
        const opts = U.el("div", "q-options");
        if (q.type === "judge") {
          opts.appendChild(U.el("span", "q-opt" + (q.answer === true ? " correct" : ""), "对"));
          opts.appendChild(U.el("span", "q-opt" + (q.answer === false ? " correct" : ""), "错"));
        } else if (q.type === "single" || q.type === "multiple") {
          const ans = Array.isArray(q.answer) ? q.answer : (q.answer == null ? [] : [q.answer]);
          (q.options || []).forEach((opt, i) => opts.appendChild(U.el("span", "q-opt" + (ans.includes(i) ? " correct" : ""), qTextHTML(opt))));
        } else if (q.type === "fill") {
          const a = Array.isArray(q.answer) ? q.answer.join(" / ") : (q.answer == null ? "" : q.answer);
          opts.appendChild(U.el("span", "q-opt q-answer", "参考答案：" + qTextHTML(a)));
        } else {
          opts.appendChild(U.el("span", "q-opt q-answer q-short-answer", "参考答案：" + qTextHTML(q.answer == null ? "" : q.answer)));
        }
        body.appendChild(opts);
      }
    } else {
      body.appendChild(U.el("div", "q-prompt q-empty", "空题目，点击「编辑」填写"));
    }
    wrap.appendChild(body);
    return wrap;
  }});

function examRadio(name, value, label) {
  const lbl = U.el("label", "q-exam-opt");
  const inp = U.el("input");
  inp.type = "radio"; inp.name = name; inp.value = value;
  lbl.appendChild(inp);
  lbl.appendChild(U.el("span", null, typeof label === "string" ? label : ""));
  if (typeof label !== "string") lbl.appendChild(label);
  return lbl;
}
function examCheck(name, value, label) {
  const lbl = U.el("label", "q-exam-opt");
  const inp = U.el("input");
  inp.type = "checkbox"; inp.name = name; inp.value = value;
  lbl.appendChild(inp);
  lbl.appendChild(U.el("span", null, typeof label === "string" ? label : ""));
  if (typeof label !== "string") lbl.appendChild(label);
  return lbl;
}
  reg("flashcard", { label: "闪卡", icon: "🃏", desc: "正面/背面记忆卡", render(b, ctx) {
    const f = b.attrs.fid ? Store.getFlashcard(b.attrs.fid) : null;
    const wrap = U.el("div", "b-flashcard");
    wrap.dataset.blockId = b.id;
    const head = U.el("div", "fc-head");
    head.appendChild(U.el("span", "fc-label", "闪卡"));
    const edit = U.el("button", "fc-edit", "编辑");
    edit.dataset.blockId = b.id;
    head.appendChild(edit);
    wrap.appendChild(head);
    const card = U.el("div", "fc-card");
    card.dataset.blockId = b.id;
    card.dataset.role = "fc-flip";
    const front = U.el("div", "fc-face fc-front", U.esc(f ? f.front : "正面"));
    const back = U.el("div", "fc-face fc-back", U.esc(f ? f.back : "背面"));
    card.appendChild(front); card.appendChild(back);
    wrap.appendChild(card);
    return wrap;
  }});
  reg("toc", { label: "目录", icon: "≡", desc: "自动生成标题目录", render(b, ctx) {
    const wrap = U.el("div", "b-toc");
    wrap.appendChild(U.el("div", "toc-head", "目录"));
    const list = U.el("div", "toc-list");
    const headings = [];
    const walk = (blocks) => blocks.forEach(x => {
      if (["heading1", "heading2", "heading3"].includes(x.type)) headings.push(x);
      if (x.children && x.children.length) walk(x.children);
    });
    if (ctx.page) walk(ctx.page.children);
    if (!headings.length) list.appendChild(U.el("div", "toc-empty", "页面中还没有标题"));
    else headings.forEach(h => {
      const item = U.el("a", "toc-item toc-" + h.type, U.segsText(h.text) || "未命名");
      item.dataset.blockId = h.id;
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const el = document.querySelector('.ed[data-block-id="' + h.id + '"]');
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          const blk = el.closest(".block");
          if (blk) { document.querySelectorAll(".block.selected").forEach(x => x.classList.remove("selected")); blk.classList.add("selected"); }
        }
      });
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }});
  reg("template", { label: "模板按钮", icon: "🧩", desc: "一键插入模板内容", render(b) {
    const wrap = U.el("div", "b-template");
    const head = U.el("div", "tpl-head");
    head.appendChild(U.el("span", "tpl-ico", "🧩"));
    head.appendChild(U.el("span", "tpl-label", "模板按钮"));
    const spacer = U.el("span", null); spacer.style.flex = "1";
    head.appendChild(spacer);
    const add = U.el("button", "db-btn", "＋ 子项");
    add.dataset.blockId = b.id;
    add.dataset.action = "tpl-add";
    head.appendChild(add);
    const ins = U.el("button", "db-btn primary", "＋ 插入");
    ins.dataset.blockId = b.id;
    ins.dataset.action = "tpl-insert";
    head.appendChild(ins);
    wrap.appendChild(head);
    return wrap;
  }});
  reg("breadcrumb", { label: "面包屑", icon: "🧭", desc: "显示当前页面路径", render(b, ctx) {
    const wrap = U.el("div", "b-breadcrumb");
    if (ctx.page) {
      const chain = Store.breadcrumb(ctx.page.id);
      chain.forEach((p, i) => {
        if (i > 0) wrap.appendChild(U.el("span", "bc-sep", "›"));
        const s = U.el("span", "bc-item", (p.icon ? p.icon + " " : "") + (U.segsText(p.title) || "未命名"));
        if (i < chain.length - 1) {
          s.style.cursor = "pointer";
          s.addEventListener("click", () => { if (global.App) App.openPage(p.id); });
        }
        wrap.appendChild(s);
      });
    }
    return wrap;
  }});

  reg("columns", { label: "分栏", icon: "▥", desc: "多栏布局（2/3/4 栏）", render(b, ctx) {
    const wrap = U.el("div", "b-columns");
    wrap.dataset.blockId = b.id;
    const cols = b.children || [];
    const widths = (b.attrs && b.attrs.widths) ? b.attrs.widths : [];
    cols.forEach((col, i) => {
      const colEl = U.el("div", "b-column");
      colEl.dataset.colId = col.id;
      colEl.dataset.blockId = b.id;
      // 栏宽度
      if (widths[i]) colEl.style.flex = "0 0 " + widths[i];
      // 栏头（交换按钮）
      if (!ctx.silent && cols.length > 1) {
        const head = U.el("div", "b-col-head");
        if (i > 0) {
          const left = U.el("button", "b-col-swap", "◀");
          left.title = "向左交换";
          left.addEventListener("click", () => { swapColumns(b, i, i - 1); });
          head.appendChild(left);
        }
        head.appendChild(U.el("span", "b-col-num", "栏 " + (i + 1)));
        if (i < cols.length - 1) {
          const right = U.el("button", "b-col-swap", "▶");
          right.title = "向右交换";
          right.addEventListener("click", () => { swapColumns(b, i, i + 1); });
          head.appendChild(right);
        }
        colEl.appendChild(head);
      }
      const kids = buildChildren(col, ctx);
      if (kids) colEl.appendChild(kids);
      if (!col.children || !col.children.length) colEl.appendChild(U.el("div", "b-column-empty", "空栏"));
      const add = U.el("button", "b-col-add", "＋ 添加块");
      add.dataset.colId = col.id;
      add.dataset.blockId = b.id;
      colEl.appendChild(add);
      // 栏间拖拽手柄（放在栏内右边缘）
      if (!ctx.silent && i < cols.length - 1) {
        const handle = U.el("div", "b-col-resize");
        handle.title = "拖拽调整栏宽";
        colEl.appendChild(handle);
        handle.addEventListener("mousedown", e => {
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX;
          const leftCol = colEl;
          const rightCol = colEl.nextElementSibling;
          const wrapRect = wrap.getBoundingClientRect();
          const leftStart = leftCol.getBoundingClientRect().width / wrapRect.width * 100;
          const rightStart = rightCol.getBoundingClientRect().width / wrapRect.width * 100;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          const onMove = ev => {
            const dx = (ev.clientX - startX) / wrapRect.width * 100;
            const newLeft = Math.max(15, Math.min(85, leftStart + dx));
            const newRight = Math.max(15, Math.min(85, rightStart - dx));
            leftCol.style.flex = "0 0 " + newLeft + "%";
            rightCol.style.flex = "0 0 " + newRight + "%";
          };
          const onUp = () => {
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            const w = [];
            wrap.querySelectorAll(":scope > .b-column").forEach(c => {
              w.push(c.style.flex.replace("0 0 ", ""));
            });
            b.attrs = b.attrs || {};
            b.attrs.widths = w;
            if (global.Store) { global.Store.markDirty(); global.Store.save(true); }
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      }
      wrap.appendChild(colEl);
    });
    return wrap;
  }});

function swapColumns(colsBlock, i, j) {
  const children = colsBlock.children || [];
  if (i < 0 || j < 0 || i >= children.length || j >= children.length) return;
  const tmp = children[i];
  children[i] = children[j];
  children[j] = tmp;
  if (global.Store) { global.Store.markDirty(); global.Store.save(true); }
  if (global.Editor && typeof global.Editor.refresh === "function") global.Editor.refresh();
}
  reg("column", { label: "栏", icon: "▥", desc: "栏", render(b, ctx) {
    const c = U.el("div", "b-column");
    const kids = buildChildren(b, ctx);
    if (kids) c.appendChild(kids);
    return c;
  }});

  /* ---------- Slash menu items ---------- */
  const SLASH_ITEMS = [
    { group: "基础", items: [
      { type: "paragraph", label: "正文", icon: "📄", desc: "普通文本" },
      { type: "heading1", label: "标题 1", icon: "H1", desc: "大标题" },
      { type: "heading2", label: "标题 2", icon: "H2", desc: "中标题" },
      { type: "heading3", label: "标题 3", icon: "H3", desc: "小标题" },
      { type: "bullet", label: "无序列表", icon: "•", desc: "圆点列表" },
      { type: "numbered", label: "有序列表", icon: "1.", desc: "数字列表" },
      { type: "todo", label: "待办事项", icon: "☑", desc: "任务列表" },
      { type: "toggle", label: "折叠列表", icon: "▸", desc: "可展开的块" },
      { type: "divider", label: "分割线", icon: "―", desc: "水平线" },
    ]},
    { group: "媒体", items: [
      { type: "image", label: "图片", icon: "🖼", desc: "上传 / 输入 URL" },
      { type: "embed", label: "嵌入", icon: "🔗", desc: "网页 iframe" },
      { type: "pdf", label: "PDF", icon: "📕", desc: "嵌入 PDF 文档" },
      { type: "highlight", label: "引用高亮", icon: "🖍", desc: "PDF 荧光笔引用" },
      { type: "pdfimage", label: "引用图片", icon: "🖼", desc: "PDF 图片引用" },
      { type: "html", label: "交互网页", icon: "🧩", desc: "可交互 HTML 网页" },
      { type: "bookmark", label: "书签", icon: "🔖", desc: "网页链接" },
      { type: "file", label: "文件", icon: "📎", desc: "上传文件" },
    ]},
    { group: "内容", items: [
      { type: "quote", label: "引用", icon: "❝", desc: "引用文字" },
      { type: "callout", label: "提示框", icon: "💡", desc: "强调块" },
      { type: "table", label: "表格", icon: "⊞", desc: "3 列表格" },
      { type: "code", label: "代码", icon: "</>", desc: "代码块" },
      { type: "mermaid", label: "图表", icon: "▦", desc: "Mermaid 图表" },
      { type: "question", label: "题目", icon: "❓", desc: "单选、多选、填空、判断、简答" },
      { type: "flashcard", label: "闪卡", icon: "🃏", desc: "正面/背面记忆卡" },
      { type: "equation", label: "公式", icon: "∑", desc: "LaTeX 行间公式" },
      { type: "inline-math", label: "行内公式", icon: "$", desc: "LaTeX 行内公式" },
      { type: "toc", label: "目录", icon: "≡", desc: "自动生成标题目录" },
      { type: "breadcrumb", label: "面包屑", icon: "🧭", desc: "显示页面路径" },
      { type: "template", label: "模板按钮", icon: "🧩", desc: "一键插入模板内容" },
      { type: "columns", label: "分栏", icon: "▥", desc: "多栏布局（2/3/4 栏）" },
    ]},
    { group: "页面", items: [
      { type: "page", label: "子页面", icon: "📄", desc: "新建嵌入页面" },
      { type: "database", label: "数据库", icon: "🗄", desc: "新建数据库页面" },
      { type: "codefile", label: "代码文件", icon: "⌨", desc: "新建可运行代码文件" },
      { type: "snippet", label: "代码片段", icon: "⌗", desc: "可关联代码文件的笔记片段" },
      { type: "link", label: "链接到页面", icon: "🔗", desc: "引用已有页面" },
    ]},
  ];

  global.Blocks = {
    BLOCK_TYPES, SLASH_ITEMS, TEXT_COLORS, BG_COLORS,
    segsToHTML, segTextHTML, qTextHTML, htmlToSegments, edText, renderBlock,
    getCaretOffset, setCaret, caretAtStart, caretAtEnd,
    editableTextLength, textRange, caretAfterLeadingNonEditable, leadingNonEditable, textOffsetBeforeNode,
  };
})(window);
