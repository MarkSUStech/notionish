/* ============ AI assistant panel: chat, RAG sync, settings, write confirmation ============ */
(function (global) {
  "use strict";

  /* ---- pure helpers ---- */
  function djb2(s) {
    let h = 5381;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function buildSignature(pageId, text) {
    return pageId + "|" + text.length + "|" + djb2(text);
  }

  function segsText(segs) {
    return global.U ? U.segsText(segs) : (Array.isArray(segs) ? segs.map(s => (s && s.t) || "").join("") : "");
  }

  /** 归一化 AI 常输出的非标准粗体标记：把 3+ 个连续星号折叠成 **，使 ****粗体**** / ***粗体*** 也能显示为粗体 */
  function normalizeEmphasis(text) {
    return String(text == null ? "" : text).replace(/\*{3,}/g, "**");
  }

  /** 正文中的 $$...$$ 不是合法行间公式块，降级为 $...$，避免被拆成多余的美元符号。 */
  function normalizeInlineDisplayMath(text) {
    return String(text == null ? "" : text).replace(/\$\$([^$\n]+?)\$\$/g, (_, latex) => "$" + latex.trim() + "$");
  }

  function equationBlock(latex) {
    const source = String(latex == null ? "" : latex).trim();
    return source ? { type: "equation", segments: [{ t: "$$" + source + "$$" }] } : null;
  }

  /** collect all indexable items (blocks + questions + flashcards) from state */
  function collectIndexItems(state) {
    const items = [];
    const signatures = new Map();
    const pages = Object.values(state.pages || {}).filter(p => !p.deleted);
    const walk = (page, blocks) => {
      (blocks || []).forEach(b => {
        const text = segsText(b.text);
        const pageTitle = segsText(page.title) || "未命名";
        items.push({ pageId: page.id, blockId: b.id, pageTitle, text });
        signatures.set(b.id, buildSignature(page.id, text));
        if (b.children && b.children.length) walk(page, b.children);
      });
    };
    pages.forEach(p => walk(p, p.children));

    Object.values(state.questions || {}).forEach(q => {
      const text = (q.prompt || "") + (Array.isArray(q.options) && q.options.length ? "\n选项：" + q.options.join("；") : "") + (q.answer != null ? "\n答案：" + JSON.stringify(q.answer) : "");
      const id = "question:" + q.id;
      items.push({ pageId: q.pageId || "questions", blockId: id, pageTitle: "题目", text });
      signatures.set(id, buildSignature("questions", text));
    });
    Object.values(state.flashcards || {}).forEach(f => {
      const text = "正面：" + (f.front || "") + "\n背面：" + (f.back || "");
      const id = "flashcard:" + f.id;
      items.push({ pageId: f.pageId || "flashcards", blockId: id, pageTitle: "闪卡", text });
      signatures.set(id, buildSignature("flashcards", text));
    });

    return { items, signatures };
  }

  const mediaCache = new Map();

  /** 收集 PDF/网页页面的文字内容用于自动检索（异步，带缓存；失败返回空串） */
  async function collectMediaItems(state) {
    const items = [];
    const pages = Object.values(state.pages || {}).filter(p => p && !p.deleted);
    for (const p of pages) {
      if (!p.url) continue;
      const key = p.id + "|" + p.url;
      if (p.pdf) {
        let text = mediaCache.get(key);
        if (text === undefined) {
          try { text = global.PDFViewer && PDFViewer.extractText ? await PDFViewer.extractText(p.url) : ""; }
          catch (e) { text = ""; }
          mediaCache.set(key, text);
        }
        if (text) items.push({ pageId: p.id, blockId: "pdf:" + p.id, pageTitle: segsText(p.title) || "未命名", text: "【PDF】" + (segsText(p.title) || "未命名") + "\n" + text });
      } else if (p.web) {
        let text = mediaCache.get(key);
        if (text === undefined) {
          try {
            const res = await fetch("/api/ai/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: p.url }) });
            const j = await res.json().catch(() => ({}));
            text = res.ok && j.text ? j.text : "";
          } catch (e) { text = ""; }
          mediaCache.set(key, text);
        }
        if (text) items.push({ pageId: p.id, blockId: "web:" + p.id, pageTitle: segsText(p.title) || "未命名", text: "【网页】" + (segsText(p.title) || "未命名") + "\n" + text });
      }
    }
    return items;
  }

  /** parse a streamed SSE buffer into JSON events; returns remaining unparsed tail */
  function parseSSEChunk(buffer) {
    const events = [];
    let rest = String(buffer == null ? "" : buffer);
    let idx;
    while ((idx = rest.indexOf("\n\n")) >= 0) {
      const frame = rest.slice(0, idx);
      rest = rest.slice(idx + 2);
      const dataLines = frame.split("\n").filter(l => l.startsWith("data:"));
      for (const l of dataLines) {
        const payload = l.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { events.push(JSON.parse(payload)); } catch (e) { /* ignore */ }
      }
    }
    return { events, rest };
  }

  /** extract the first balanced JSON array/object from model output */
  function extractJSON(text) {
    const s = String(text == null ? "" : text);
    const firstBracket = s.indexOf("[");
    const firstBrace = s.indexOf("{");
    const candidates = [firstBracket, firstBrace].filter(i => i >= 0);
    if (!candidates.length) return null;
    const openIdx = Math.min.apply(null, candidates);
    const open = s[openIdx];
    const close = open === "[" ? "]" : "}";
    let depth = 0, inStr = false, esc = false;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(openIdx, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /** 语言指令：英文界面时要求 AI 用英文输出 */
  function langHint() {
    if (global.I18n && I18n.lang === "en") {
      return "请用英文（English）撰写所有输出内容，包括标题、正文、题目、评语等。";
    }
    return "请用中文撰写所有输出内容。";
  }

  /** 给任意 prompt 追加语言指令（英文模式下） */
  function localizePrompt(p) {
    if (global.I18n && I18n.lang === "en") {
      return String(p) + "\n\n[Output language: English. Please respond entirely in English.]";
    }
    return p;
  }

  function buildQuestionsPrompt(content, count) {
    return langHint() + "\n请基于下面的笔记内容生成 " + (Number(count) || 3) + " 道复习自测题。只输出一个 JSON 数组，不要任何解释文字。每项字段：" +
      "type（取值 single/multiple/judge/fill/short_answer）、prompt（题干）、options（选择题的选项数组，非选择题为 []）、" +
      "answer（单选为正确选项索引数字，多选为索引数字数组，判断为布尔值，填空/简答为字符串）、explanation（解析，可为空字符串）。\n\n笔记内容：\n" + content;
  }

  function buildFlashcardsPrompt(content, count) {
    return langHint() + "\n请基于下面的笔记内容生成 " + (Number(count) || 5) + " 张学习闪卡。只输出一个 JSON 数组，不要任何解释文字。每项字段：" +
      "front（正面问题）、back（背面答案）。\n\n笔记内容：\n" + content;
  }

  function buildNotePrompt(topic, styleHint) {
    return langHint() + "\n请为下面的学习主题撰写一份结构完整的笔记。只输出一个 JSON 对象，不要任何解释文字。" +
      '格式：{"title":"页面标题","blocks":[{"type":"段落类型","text":"内容"},...]}。' +
      "type 取值：paragraph、heading2、heading3、bullet、numbered、quote、callout、equation。" +
      "公式规则：正文行内公式只用 $...$；独立行间公式必须使用 equation 块，text 为 $$...$$。不要在段落正文中使用 $$。" +
      "内容要分点、清晰、适合复习。" +
      (styleHint ? "\n\n" + styleHint : "") +
      "\n\n主题：" + String(topic == null ? "" : topic);
  }

  function buildSupplementPrompt(title, content, styleHint) {
    return langHint() + "\n下面是一份已有笔记，请补充更多相关知识、例子或总结，使其更完整。只输出一个 JSON 对象，不要任何解释文字。" +
      '格式：{"blocks":[{"type":"段落类型","text":"内容"},...]}。' +
      "type 取值：paragraph、heading2、heading3、bullet、numbered、quote、callout、equation。" +
      "公式规则：正文行内公式只用 $...$；独立行间公式必须使用 equation 块，text 为 $$...$$。不要在段落正文中使用 $$。" +
      "不要重复已有内容，风格保持一致。" +
      (styleHint ? "\n\n" + styleHint : "") +
      "\n\n笔记标题：" + String(title == null ? "" : title) +
      "\n\n已有内容：\n" + String(content == null ? "" : content);
  }

  const NOTE_BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "quote", "callout"];
  const EDITABLE_BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout", "divider", "code", "snippet", "mermaid", "equation", "table", "image", "embed", "pdf", "highlight", "html", "bookmark", "file"];
  const READ_TOOLS = new Set(["list_pages", "read_pdf", "read_web", "load_skill", "query_memory", "web_search", "list_knowledge_bases", "query_knowledge_base"]);
  const WRITING_STYLES = [
    { id: "standard", label: "标准", hint: "" },
    { id: "concise", label: "简洁", hint: "写作范式：简洁——只保留核心要点，每点用一句话概括，避免冗余。" },
    { id: "detailed", label: "详细", hint: "写作范式：详细——充分展开，多举例、多补充细节与背景。" },
    { id: "plain", label: "通俗", hint: "写作范式：通俗——用大白话和日常类比讲解，避免专业术语。" },
    { id: "feynman", label: "费曼式", hint: "写作范式：费曼式——用最简单的语言把概念讲清楚，像在教一个完全不懂的新手；遇到卡壳的地方就是要重点展开的难点。" },
    { id: "elaboration", label: "精加工", hint: "写作范式：精加工——对每个结论都追问「为什么」，给出因果、机制或原理层面的解释，而不是只罗列结论（被研究证实最有效的学习方法之一）。" },
    { id: "example-first", label: "样例优先", hint: "写作范式：样例优先——先给出 1-2 个具体例子，再从例子中抽象出定义、规律或步骤。" },
    { id: "analogy", label: "类比式", hint: "写作范式：类比式——用生活中熟悉的事物类比抽象概念，降低理解门槛。" },
    { id: "cornell", label: "康奈尔", hint: "写作范式：康奈尔笔记——分「要点 / 关键问题 / 底部总结」三层组织，便于复习回顾。" },
    { id: "recall", label: "主动回忆", hint: "写作范式：主动回忆——以「问题 → 答案」的形式组织内容，便于自测和巩固长期记忆。" },
    { id: "chunking", label: "组块化", hint: "写作范式：组块化——把零散信息组织成有意义的模块/单元，每块聚焦一个主题，便于记忆和检索。" },
    { id: "dual-coding", label: "双重编码", hint: "写作范式：双重编码——文字与表格/图示/流程图结合（可用 mermaid 或表格块），用视觉辅助理解。" },
    { id: "academic", label: "学术", hint: "写作范式：学术——严谨规范，给出定义与原理，措辞正式。" },
    { id: "imrad", label: "IMRaD", hint: "写作范式：IMRaD——按「引言(背景与问题) → 方法(原理/依据) → 结果 → 讨论(意义与局限)」四段式组织，符合学术论文结构。" },
    { id: "def-derive", label: "定义·推导", hint: "写作范式：定义-原理-推导——先给出严格定义，再说明原理，再给出推导或证明，最后落到应用与例子。" },
    { id: "claim-evidence", label: "论点·论证", hint: "写作范式：论点-论据-论证——每个结论先亮明论点，再给论据（数据/文献/例子），最后做严密论证。" },
    { id: "review", label: "综述式", hint: "写作范式：综述式——梳理该主题的多个流派/观点/方法，对比异同，指出共识与争议，并给出文献脉络。" },
    { id: "critical", label: "批判性", hint: "写作范式：批判性——不仅陈述结论，还审视其前提假设、适用范围、局限与反例，做出独立评价。" },
    { id: "story", label: "故事化", hint: "写作范式：故事化——用故事或具体场景组织内容，生动形象。" },
    { id: "qa", label: "问答式", hint: "写作范式：问答式——用一问一答的形式展开。" },
    { id: "outline", label: "大纲式", hint: "写作范式：大纲式——用层级化提纲结构，先总后分。" },
  ];

  /** compact block summary sent to the model for editing (truncated to keep requests light) */
  function summarizeBlock(b) {
    const clip = (s, n) => { const str = String(s == null ? "" : s); return str.length > n ? str.slice(0, n) + "…" : str; };
    const s = { id: b.id, type: b.type, text: clip(segsText(b.text), 200) };
    if (b.type === "todo") s.checked = !!b.checked;
    if (b.type === "toggle") s.folded = !!b.folded;
    if (b.type === "table" && b.attrs && Array.isArray(b.attrs.rows)) s.rows = b.attrs.rows.slice(0, 8).map(r => (r || []).map(c => clip(segsText(c), 100)));
    if ((b.type === "code" || b.type === "snippet" || b.type === "mermaid") && b.attrs) { s.language = b.attrs.language; s.source = clip(b.attrs.source, 400); }
    if (b.children && b.children.length) s.children = b.children.map(summarizeBlock);
    return s;
  }

  /** normalize model-provided block attrs (string cells → segments) */
  function normalizeBlockAttrs(attrs) {
    const out = {};
    if (!attrs || typeof attrs !== "object") return out;
    ["language", "source", "url", "src", "name", "icon", "title"].forEach(k => { if (typeof attrs[k] === "string") out[k] = attrs[k]; });
    if (Number.isInteger(attrs.cols)) out.cols = attrs.cols;
    if (typeof attrs.header === "boolean") out.header = attrs.header;
    if (Number.isInteger(attrs.page)) out.page = attrs.page;
    if (typeof attrs.highlightId === "string") out.highlightId = attrs.highlightId;
    if (typeof attrs.sourcePageId === "string") out.sourcePageId = attrs.sourcePageId;
    if (typeof attrs.hlText === "string") out.hlText = attrs.hlText;
    if (Number.isInteger(attrs.hlPage)) out.hlPage = attrs.hlPage;
    if (Array.isArray(attrs.rows)) out.rows = attrs.rows.map(r => (Array.isArray(r) ? r : []).map(c => typeof c === "string" ? [{ t: c }] : (c || [{ t: "" }])));
    return out;
  }

  /** parse inline markdown (bold/italic/code/strike/math) into rich-text segments */
  function inlineToSegments(text) {
    const s = normalizeEmphasis(normalizeInlineDisplayMath(text));
    const segs = [];
    // $...$ 只当数学公式：开头 $ 后不跟空格/数字/另一个$，单字符公式也支持
    const re = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~|\$[^\s\d$][^$\n]*[^\s$]?\$|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) segs.push({ t: s.slice(last, m.index) });
      const tok = m[0];
      if (tok.startsWith("**")) segs.push({ t: tok.slice(2, -2), b: 1 });
      else if (tok.startsWith("~~")) segs.push({ t: tok.slice(2, -2), s: 1 });
      else if (tok.startsWith("`")) segs.push({ t: tok.slice(1, -1), c: 1 });
      else if (tok.startsWith("$")) segs.push({ t: "", math: tok.slice(1, -1) });
      else if (tok.startsWith("*")) segs.push({ t: tok.slice(1, -1), i: 1 });
      else if (tok.startsWith("[")) {
        const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (lm) segs.push({ t: lm[1], link: lm[2] });
        else segs.push({ t: tok });
      }
      last = m.index + tok.length;
    }
    if (last < s.length) segs.push({ t: s.slice(last) });
    return segs.filter(x => x.t !== "" || x.math != null);
  }

  /** convert markdown into Notionish blocks [{type, segments}] */
  function markdownToBlocks(md) {
    const blocks = [];
    const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;

      // 代码块 ```lang ... ```
      if (t.startsWith("```")) {
        const lang = t.slice(3).trim();
        const codeLines = [];
        let closed = false;
        while (++i < lines.length) {
          if (lines[i].trim() === "```") { closed = true; break; }
          codeLines.push(lines[i]);
        }
        blocks.push({ type: "code", attrs: { language: lang || "text", source: codeLines.join("\n") } });
        continue;
      }
      // 图片 ![alt](src) — 用贪婪匹配取最后一个 ) 作为 markdown 的闭合括号
      let imgM;
      if (t.startsWith("![") && (imgM = t.match(/^!\[([^\]]*)\]\((.+)\)$/))) {
        const alt = (imgM[1] || "").trim();
        const attrs = { src: imgM[2] };
        if (alt) attrs.caption = [{ t: alt }];
        blocks.push({ type: "image", attrs });
        continue;
      }

      if (t === "$$" || (t.startsWith("$$") && !t.endsWith("$$"))) {
        const mathLines = [t === "$$" ? "" : t.slice(2)];
        let closed = false;
        while (++i < lines.length) {
          const line = lines[i];
          const close = line.indexOf("$$");
          if (close >= 0) {
            mathLines.push(line.slice(0, close));
            closed = true;
            break;
          }
          mathLines.push(line);
        }
        const equation = equationBlock(mathLines.join("\n"));
        if (closed && equation) blocks.push(equation);
        else blocks.push({ type: "paragraph", segments: inlineToSegments("$$" + mathLines.join("\n")) });
        continue;
      }

      if (/^\$\$[^$\n]+\$\$$/.test(t)) {
        const equation = equationBlock(t.slice(2, -2));
        if (equation) blocks.push(equation);
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ type: "divider", segments: [] }); continue; }
      let m;
      if ((m = t.match(/^###\s+(.*)/))) { blocks.push({ type: "heading3", segments: inlineToSegments(m[1]) }); continue; }
      if ((m = t.match(/^##\s+(.*)/))) { blocks.push({ type: "heading2", segments: inlineToSegments(m[1]) }); continue; }
      if ((m = t.match(/^#\s+(.*)/))) { blocks.push({ type: "heading1", segments: inlineToSegments(m[1]) }); continue; }
      if ((m = t.match(/^[-*]\s+(.*)/))) { blocks.push({ type: "bullet", segments: inlineToSegments(m[1]) }); continue; }
      if ((m = t.match(/^(\d+[.)])\s+(.*)/))) { blocks.push({ type: "numbered", segments: inlineToSegments(m[2]) }); continue; }
      if ((m = t.match(/^>\s?(.*)/))) { blocks.push({ type: "quote", segments: inlineToSegments(m[1]) }); continue; }
      blocks.push({ type: "paragraph", segments: inlineToSegments(t) });
    }
    return blocks;
  }

  /** inline markdown → escaped HTML (for chat rendering); renders $...$ inline math */
  function inlineMarkdown(text) {
    const s = normalizeEmphasis(text);
    const parts = s.split(/(\$[^\s\d$][^$\n]*[^\s$]?\$)/g);
    let out = "";
    parts.forEach(part => {
      if (part.length > 2 && part[0] === "$" && part[part.length - 1] === "$") {
        const latex = part.slice(1, -1);
        const rendered = (global.MathR && MathR.renderInline ? MathR.renderInline(latex) : null) || U.esc(latex);
        out += '<span class="ai-math">' + rendered + "</span>";
      } else if (part !== "") {
        let html = U.esc(part);
        html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
        html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
        html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
        html = html.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        out += html;
      }
    });
    return out;
  }

  /** markdown → HTML for the chat bubble */
  function renderMarkdown(md) {
    const lines = String(md == null ? "" : md).split("\n");
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) { out += '<div class="ai-md ai-blank"></div>'; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out += '<hr class="ai-hr">'; continue; }
      let m;
      if ((m = t.match(/^###\s+(.*)/))) { out += '<div class="ai-md ai-h3">' + inlineMarkdown(m[1]) + "</div>"; continue; }
      if ((m = t.match(/^##\s+(.*)/))) { out += '<div class="ai-md ai-h2">' + inlineMarkdown(m[1]) + "</div>"; continue; }
      if ((m = t.match(/^#\s+(.*)/))) { out += '<div class="ai-md ai-h1">' + inlineMarkdown(m[1]) + "</div>"; continue; }
      if ((m = t.match(/^[-*]\s+(.*)/))) { out += '<div class="ai-md ai-li">• ' + inlineMarkdown(m[1]) + "</div>"; continue; }
      if ((m = t.match(/^(\d+[.)])\s+(.*)/))) { out += '<div class="ai-md ai-li">' + U.esc(m[1]) + " " + inlineMarkdown(m[2]) + "</div>"; continue; }
      if ((m = t.match(/^>\s?(.*)/))) { out += '<div class="ai-md ai-quote">' + inlineMarkdown(m[1]) + "</div>"; continue; }
      out += '<div class="ai-md">' + inlineMarkdown(t) + "</div>";
    }
    return out;
  }

  const AI = {
    synced: new Map(),
    panel: null,
    busy: false,
    style: "standard",
    _syncTimer: null,

    /* ---- public pure helpers (testable) ---- */
    djb2,
    buildSignature,
    collectIndexItems,
    collectMediaItems,
    parseSSEChunk,
    extractJSON,
    buildQuestionsPrompt,
    buildFlashcardsPrompt,
    buildNotePrompt,
    buildSupplementPrompt,
    summarizeBlock,
    normalizeBlockAttrs,
    inlineToSegments,
    markdownToBlocks,
    inlineMarkdown,
    renderMarkdown,

    /* ================= Lifecycle ================= */
    start() {
      this.buildPanel();
      this.wire();
      this.refreshStatus();
      this.scheduleSync();
    },

    buildPanel() {
      const toggle = U.el("button", "icon-btn ai-toggle", "✦");
      toggle.id = "ai-toggle";
      toggle.title = U.t("AI 助手 (Ctrl+Shift+A)");
      document.getElementById("topbar").appendChild(toggle);
      toggle.addEventListener("click", () => this.toggle());

      const panel = U.el("aside", "ai-panel");
      panel.id = "ai-panel";
      panel.innerHTML =
        '<div class="ai-head">' +
          '<span class="ai-title">' + U.t("✦ AI 助手") + '</span>' +
          '<button class="icon-btn ai-settings" title="' + U.t("设置") + '">⚙</button>' +
          '<button class="icon-btn ai-close" title="' + U.t("关闭") + '">✕</button>' +
        '</div>' +
        '<div class="ai-messages"></div>' +
        '<div class="ai-draft" hidden></div>' +
        '<div class="ai-toolbar">' +
          this._buildToolbarHTML() +
        '</div>' +
        '<div class="ai-input-row">' +
          '<textarea class="ai-input" placeholder="' + U.t("输入问题，或选择上方工具…") + '" rows="2"></textarea>' +
          '<button class="ai-send" title="' + U.t("发送") + '">➤</button>' +
        '</div>' +
        '<div class="ai-foot">' +
          '<span class="ai-status">' + U.t("连接中…") + '</span>' +
          '<button class="ai-rebuild" title="' + U.t("重建全部索引") + '">🔄 ' + U.t("重建索引") + '</button>' +
        '</div>';
      document.getElementById("app").appendChild(panel);
      this.panel = panel;
      this._tools = {}; // { exam: bool, note: bool, viz: bool, research: bool }
      this._kbs = [];   // selected KB ids
    },

    _buildToolbarHTML() {
      return '<div class="ai-tgl" id="ai-tgl-tools"><span class="ai-tgl-arrow">▶</span> ' + U.t("工具") + '</div>' +
        '<div class="ai-tgl-body" id="ai-tgl-tools-body" hidden>' +
          '<label class="ai-chk"><input type="checkbox" data-tool="exam">📋 ' + U.t("出试卷") + '</label>' +
          '<label class="ai-chk"><input type="checkbox" data-tool="note">📝 ' + U.t("新增笔记") + '</label>' +
          '<label class="ai-chk"><input type="checkbox" data-tool="viz">📊 ' + U.t("可视化") + '</label>' +
          '<label class="ai-chk"><input type="checkbox" data-tool="research">🔬 ' + U.t("研究（搜索→知识库）") + '</label>' +
        '</div>' +
        '<div class="ai-tgl" id="ai-tgl-kb"><span class="ai-tgl-arrow">▶</span> ' + U.t("知识库") + '</div>' +
        '<div class="ai-tgl-body" id="ai-tgl-kb-body" hidden>' +
          '<div id="ai-kb-list" class="ai-kb-list">' + U.t("加载中…") + '</div>' +
        '</div>' +
        '<div class="ai-tgl" id="ai-tgl-style"><span class="ai-tgl-arrow">▶</span> ' + U.t("风格") + '</div>' +
        '<div class="ai-tgl-body" id="ai-tgl-style-body" hidden>' +
          '<div class="ai-style-btns"></div>' +
        '</div>';
    },

    wire() {
      const panel = this.panel;
      panel.querySelector(".ai-close").addEventListener("click", () => this.toggle(false));
      panel.querySelector(".ai-settings").addEventListener("click", () => this.openSettings());
      this.sendBtn = panel.querySelector(".ai-send");
      this.sendBtn.addEventListener("click", () => {
        if (this.busy) this.stopStreaming();
        else this.send();
      });
      const input = panel.querySelector(".ai-input");
      this.aiInput = input;
      input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      });
      input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 140) + "px";
      });
      panel.querySelector(".ai-rebuild").addEventListener("click", () => this.rebuildIndex());

      // 三个 toggle 面板
      ["tools", "kb", "style"].forEach(id => {
        const tgl = panel.querySelector("#ai-tgl-" + id);
        const body = panel.querySelector("#ai-tgl-" + id + "-body");
        if (tgl && body) {
          tgl.addEventListener("click", () => {
            const open = body.hidden;
            body.hidden = !open;
            tgl.querySelector(".ai-tgl-arrow").textContent = open ? "▼" : "▶";
          });
        }
      });

      // 工具 checkbox
      panel.querySelectorAll("[data-tool]").forEach(cb => {
        cb.addEventListener("change", () => {
          this._tools[cb.dataset.tool] = cb.checked;
        });
      });

      // 知识库列表
      this._refreshKbList();

      // 风格按钮
      const styleBtns = panel.querySelector(".ai-style-btns");
      WRITING_STYLES.forEach(s => {
        const b = U.el("button", "ai-style-btn", U.t(s.label));
        b.dataset.style = s.id;
        b.title = U.t(s.hint) || U.t("标准风格");
        if (s.id === this.style) b.classList.add("active");
        b.addEventListener("click", () => {
          this.style = s.id;
          styleBtns.querySelectorAll(".ai-style-btn").forEach(x => x.classList.toggle("active", x === b));
        });
        styleBtns.appendChild(b);
      });

      document.addEventListener("keydown", e => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "A" || e.key === "a")) { e.preventDefault(); this.toggle(); }
      });
    },

    async _refreshKbList() {
      const el = this.panel.querySelector("#ai-kb-list");
      if (!el) return;
      try {
        const res = await fetch("/api/kb/list");
        const j = await res.json();
        const kbs = Array.isArray(j.kbs) ? j.kbs : [];
        U.clear(el);
        if (!kbs.length) { el.textContent = U.t("暂无知识库"); return; }
        kbs.forEach(kb => {
          const label = U.el("label", "ai-chk");
          const cb = U.el("input");
          cb.type = "checkbox";
          cb.dataset.kbId = kb.id;
          cb.addEventListener("change", () => {
            this._kbs = [];
            el.querySelectorAll("input:checked").forEach(c => this._kbs.push(c.dataset.kbId));
          });
          label.appendChild(cb);
          label.appendChild(document.createTextNode(" " + (kb.name || kb.id)));
          el.appendChild(label);
        });
      } catch (e) { el.textContent = U.t("加载失败"); }
    },

    toggle(force) {
      const open = force != null ? force : !this.panel.classList.contains("open");
      this.panel.classList.toggle("open", open);
      if (open) {
        this.refreshKbList(); // 打开时刷新知识库列表
        const input = this.panel.querySelector(".ai-input");
        if (input) input.focus({ preventScroll: true });
      }
    },

    /** 刷新知识库列表（防重复：若已有同名方法则不叠加定时器） */
    refreshKbList() {
      if (!this._kbRefreshTimer) {
        this._kbRefreshTimer = setTimeout(() => { this._kbRefreshTimer = null; this._refreshKbList(); }, 60);
      }
      return this._refreshKbList;
    },

    /* ================= Chat ================= */
    async send() {
      if (this.busy) { this.stopStreaming(); return; }
      const input = this.aiInput || this.panel.querySelector(".ai-input");
      const query = input.value.trim();
      if (!query) return;
      input.value = "";
      input.style.height = "auto";
      this.pushMessage("user", query);
      this._updateSendBtn();
      // 工具上下文
      let toolCtx = "";
      if (this._tools.exam) toolCtx += "使用 create_exam 工具出试卷。";
      if (this._tools.note) toolCtx += "使用 create_note 工具创建新笔记。";
      if (this._tools.viz) toolCtx += "使用 create_block 工具生成可视化图表（mermaid/html）。";
      if (this._tools.research) toolCtx += "使用 web_search 搜索资料，然后用 save_web_to_kb 保存到知识库。";
      const fullQuery = toolCtx ? toolCtx + " 用户问题：" + query : query;
      const msgs = [{ role: "user", content: fullQuery }];
      if (global.I18n && I18n.lang === "en") {
        msgs.unshift({ role: "system", content: "You are the Notionish AI assistant. Always respond in English, unless the user explicitly asks for another language." });
      }
      await this.runChat(msgs);
      this._updateSendBtn();
    },

    currentPageContent() {
      const ctx = this.currentContent();
      return ctx ? ctx.content : "";
    },

    currentPageBlocks() {
      const ctx = this.currentContent();
      if (!ctx) return null;
      return (ctx.page.children || []).map(summarizeBlock);
    },

    /** 当前打开页面的元信息（供 AI 识别“这份 PDF/网页”并调用 read_pdf/read_web） */
    currentPageInfo() {
      const ctx = this.currentContent();
      if (!ctx) return null;
      const p = ctx.page;
      const rawUrl = p.url || "";
      // 本地文件是巨大的 data URL，绝不能塞进请求体（会超过服务器 5MB 上限导致连接被掐断）
      const url = rawUrl.startsWith("data:") ? "" : rawUrl.slice(0, 500);
      return {
        id: p.id,
        title: segsText(p.title) || "未命名",
        type: p.database ? "database" : p.code ? "code" : p.web ? "web" : p.pdf ? "pdf" : "note",
        url,
      };
    },

    async chatRequest(messages) {
      const controller = new AbortController();
      this._abortController = controller;
      const timer = setTimeout(() => controller.abort(), 180000);
      let res;
      try {
        res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, pageContent: this.currentPageContent(), pageBlocks: this.currentPageBlocks(), currentPage: this.currentPageInfo(), style: this.styleHint(), kbIds: this._kbs }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") {
          if (this._abortController) throw new Error("AI 请求被中止");
          throw new Error("AI 请求超时（内容可能太长，上游 LLM 响应慢），请稍后重试");
        }
        throw new Error("无法连接本地 AI 服务，请用 node server.js 启动本应用");
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 404) throw new Error("本地服务版本过旧（缺少 /api/ai/chat）。请重启 node server.js 并刷新页面");
        throw new Error(j.error || ("请求失败 " + res.status));
      }
      return await res.json();
    },

    async runChat(messages) {
      this.busy = true;
      try {
        for (let iter = 0; iter < 12; iter++) {
          this.showThinking();
          const resp = await this.chatRequest(messages);
          this.hideThinking();
          if (resp.tool_calls && resp.tool_calls.length) {
            const approved = await this.askConfirmToolCalls(resp.tool_calls);
            if (!approved) { this.pushAssistantText("已取消。"); break; }
            const assistantMsg = { role: "assistant", content: null, reasoning_content: resp.reasoning_content || undefined, tool_calls: resp.tool_calls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) };
            messages.push(assistantMsg);
            for (const tc of resp.tool_calls) {
              let args = {};
              try { args = JSON.parse(tc.arguments || "{}"); } catch (e) { args = {}; }
              const result = tc.name === "load_skill" ? await this.loadSkill(args.name) : await this.executeTool(tc.name, args);
              messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
              if (result.ok && tc.name === "create_note" && result.pageId && global.App) App.openPage(result.pageId);
            }
            this.scheduleSync();
            continue;
          }
          if (resp.content) this.pushAssistantText(resp.content);
          if (resp.citations && resp.citations.length) this.renderCitationsLast(resp.citations);
          break;
        }
      } catch (e) {
        this.pushAssistantText("⚠️ " + (e.message || String(e)));
      } finally {
        this.hideThinking();
        this.busy = false;
        this._updateSendBtn();
      }
    },

    _updateSendBtn() {
      if (!this.sendBtn) return;
      if (this.busy) {
        this.sendBtn.textContent = "■";
        this.sendBtn.title = U.t("停止生成");
        this.sendBtn.classList.add("ai-send-stop");
      } else {
        this.sendBtn.textContent = "➤";
        this.sendBtn.title = U.t("发送");
        this.sendBtn.classList.remove("ai-send-stop");
      }
    },

    stopStreaming() {
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
    },

    pushAssistantText(text) {
      const msg = this.pushMessage("assistant", "", true);
      msg._text = String(text || "");
      this.renderAssistantText(msg);
    },

    showThinking() {
      this.hideThinking();
      const list = this.panel.querySelector(".ai-messages");
      const bubble = U.el("div", "ai-msg assistant ai-thinking");
      bubble.innerHTML = '<span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>';
      list.appendChild(bubble);
      list.scrollTop = list.scrollHeight;
      this._thinkingEl = bubble;
    },

    hideThinking() {
      if (this._thinkingEl) { this._thinkingEl.remove(); this._thinkingEl = null; }
      const list = this.panel.querySelector(".ai-messages");
      if (list) list.scrollTop = list.scrollHeight;
    },

    renderCitationsLast(citations) {
      const list = this.panel.querySelector(".ai-messages");
      const last = list && list.lastElementChild;
      if (last && last.classList.contains("assistant")) this.renderCitations(last, citations);
    },

    askConfirmToolCalls(toolCalls) {
      // 只读工具直接执行（仅显示，不确认）；含写操作才需确认
      const writeCalls = toolCalls.filter(tc => !READ_TOOLS.has(tc.name));
      if (!writeCalls.length) {
        this.showToolCallsNote(toolCalls);
        return Promise.resolve(true);
      }
      return new Promise(resolve => {
        const list = this.panel.querySelector(".ai-messages");
        const card = U.el("div", "ai-msg assistant ai-tool-card ai-tool-write");
        const label = U.el("div", "ai-tool-label", "AI 想执行以下操作");
        card.appendChild(label);
        const body = U.el("div", "ai-gen-list");
        writeCalls.forEach(tc => {
          let args = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch (e) { args = {}; }
          const item = U.el("div", "ai-gen-item");
          item.innerHTML = '<span class="ai-tool-ico">' + this.toolIcon(tc.name) + '</span><span>' + U.esc(this.describeToolCall(tc.name, args)) + '</span>';
          body.appendChild(item);
        });
        card.appendChild(body);
        const actions = U.el("div", "ai-draft-actions");
        const apply = U.el("button", "db-btn primary", "应用");
        const ignore = U.el("button", "db-btn", "忽略");
        apply.addEventListener("click", () => {
          apply.textContent = "已应用 ✓";
          apply.disabled = true;
          ignore.disabled = true;
          label.textContent = "已批准，正在执行…";
          resolve(true);
        });
        ignore.addEventListener("click", () => {
          ignore.textContent = "已取消";
          apply.disabled = true;
          ignore.disabled = true;
          label.textContent = "已取消";
          resolve(false);
        });
        actions.appendChild(apply); actions.appendChild(ignore);
        card.appendChild(actions);
        list.appendChild(card);
        list.scrollTop = list.scrollHeight;
      });
    },

    showToolCallsNote(toolCalls) {
      const list = this.panel.querySelector(".ai-messages");
      const card = U.el("div", "ai-msg assistant ai-tool-card ai-tool-read");
      const label = U.el("div", "ai-tool-label", "AI 正在执行");
      card.appendChild(label);
      const body = U.el("div", "ai-gen-list");
      toolCalls.forEach(tc => {
        let args = {};
        try { args = JSON.parse(tc.arguments || "{}"); } catch (e) { args = {}; }
        const item = U.el("div", "ai-gen-item");
        item.innerHTML = '<span class="ai-tool-ico">' + this.toolIcon(tc.name) + '</span><span>' + U.esc(this.describeToolCall(tc.name, args)) + '</span>';
        body.appendChild(item);
      });
      card.appendChild(body);
      list.appendChild(card);
      list.scrollTop = list.scrollHeight;
    },

    describeToolCall(name, args) {
      switch (name) {
        case "create_note": return "新建笔记《" + (args.title || "未命名") + "》" + (Array.isArray(args.blocks) ? "（" + args.blocks.length + " 个块）" : "");
        case "append_blocks": return "补充本页（" + (Array.isArray(args.blocks) ? args.blocks.length : 0) + " 个块）";
        case "create_questions": return "写入 " + (Array.isArray(args.questions) ? args.questions.length : 0) + " 道题目";
        case "create_flashcards": return "写入 " + (Array.isArray(args.flashcards) ? args.flashcards.length : 0) + " 张闪卡";
        case "create_block": return "新建块（" + (args.type || "段落") + "）" + (args.text ? "：" + String(args.text).slice(0, 40) : "");
        case "update_block": return "修改块 " + (args.blockId || "");
        case "delete_block": return "删除块 " + (args.blockId || "");
        case "move_block": return "移动块 " + (args.blockId || "");
        case "load_skill": return "加载技能 " + (args.name || "");
        case "create_web_page": return "新建网页（" + (args.url || "") + "）";
        case "create_pdf_page": return "新建 PDF（" + (args.url || "") + (args.page > 1 ? "，第 " + args.page + " 页" : "") + "）";
        case "list_pages": return "列出工作区页面";
        case "read_pdf": return "读取 PDF（" + (args.pageId || args.url || "") + "）";
        case "read_web": return "读取网页（" + (args.pageId || args.url || "") + "）";
        case "query_memory": return "查询长期记忆：" + (args.query || "");
        case "save_memory": return "保存长期记忆：" + String(args.text || "").slice(0, 40);
        case "list_knowledge_bases": return "列出知识库";
        case "query_knowledge_base": return "检索知识库：" + (args.query || "");
        case "web_search": return "联网搜索：" + (args.query || "");
        case "save_web_to_kb": return "保存网页到知识库：" + (args.url || "");
        case "create_exam": return "生成试卷：" + (args.topic || "综合") + " · " + (args.count || 5) + " 题";
        default: return "执行技能：" + name;
      }
    },

    toolIcon(name) {
      const map = {
        web_search: "🔍", query_knowledge_base: "📚", list_knowledge_bases: "🗄",
        query_memory: "🧠", list_pages: "📄", read_pdf: "📕", read_web: "🌐",
        load_skill: "🧩", create_note: "📝", append_blocks: "➕", create_questions: "❓",
        create_flashcards: "🃏", create_block: "▣", update_block: "✏️", delete_block: "🗑",
        move_block: "↕", create_web_page: "🌐", create_pdf_page: "📕",
        save_memory: "💾", save_web_to_kb: "📥", create_exam: "📋",
      };
      return map[name] || "🔧";
    },

    async loadSkill(name) {
      let res;
      try {
        res = await fetch("/api/ai/skill?name=" + encodeURIComponent(String(name || "")));
      } catch (e) {
        return { ok: false, error: "无法连接本地服务，请用 node server.js 启动本应用" };
      }
      if (!res.ok) {
        if (res.status === 404) return { ok: false, error: "未找到技能：" + name };
        return { ok: false, error: "加载技能失败（HTTP " + res.status + "）" };
      }
      const content = await res.text();
      return { ok: true, name, content };
    },

    async executeTool(name, args) {
      const S = global.Store;
      switch (name) {
        case "ask_block_types": {
          const chosen = await this.askBlockTypes(args && args.purpose);
          return { ok: true, blockTypes: chosen, hint: chosen.length ? "用户已选择这些块类型，生成内容时必须严格只使用这些类型，不要使用未选中的类型。" : "用户未选择，请使用默认类型（标题 + 段落）。" };
        }
        case "query_memory": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) return { ok: true, results: [] };
          try {
            const res = await fetch("/api/memory/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, k: Number(args.k) || 5 }) });
            const j = await res.json().catch(() => ({}));
            return { ok: true, results: Array.isArray(j.results) ? j.results : [] };
          } catch (e) { return { ok: false, error: "记忆查询失败：" + (e.message || String(e)) }; }
        }
        case "save_memory": {
          const text = typeof args.text === "string" ? args.text.trim() : "";
          if (!text) return { ok: false, error: "缺少 text" };
          try {
            const res = await fetch("/api/memory/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, importance: Number(args.importance) || 3 }) });
            const j = await res.json().catch(() => ({}));
            return { ok: !!j.ok, id: j.id, size: j.size };
          } catch (e) { return { ok: false, error: "记忆保存失败：" + (e.message || String(e)) }; }
        }
        case "list_knowledge_bases": {
          try {
            const res = await fetch("/api/kb/list");
            const j = await res.json().catch(() => ({}));
            return { ok: true, kbs: Array.isArray(j.kbs) ? j.kbs : [] };
          } catch (e) { return { ok: false, error: "知识库列表获取失败：" + (e.message || String(e)) }; }
        }
        case "query_knowledge_base": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) return { ok: true, results: [] };
          try {
            const res = await fetch("/api/kb/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, kbId: args.kbId || null, k: Number(args.k) || 5 }) });
            const j = await res.json().catch(() => ({}));
            return { ok: true, results: Array.isArray(j.results) ? j.results : [] };
          } catch (e) { return { ok: false, error: "知识库检索失败：" + (e.message || String(e)) }; }
        }
        case "web_search": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) return { ok: true, text: "", results: [] };
          try {
            const res = await fetch("/api/search?q=" + encodeURIComponent(query) + "&count=" + (Number(args.count) || 5));
            const j = await res.json().catch(() => ({}));
            return { ok: !!j.ok, text: j.text || "", results: Array.isArray(j.results) ? j.results : [], error: j.error };
          } catch (e) { return { ok: false, error: "联网搜索失败：" + (e.message || String(e)) }; }
        }
        case "save_web_to_kb": {
          const url = typeof args.url === "string" ? args.url.trim() : "";
          if (!url) return { ok: false, error: "缺少 url" };
          try {
            let kbId = typeof args.kbId === "string" ? args.kbId : "";
            // 未指定库时：优先存到当前打开的知识库页面
            if (!kbId && typeof location.hash === "string" && location.hash.startsWith("kb/")) {
              kbId = location.hash.slice(3);
            }
            if (!kbId) {
              const listRes = await fetch("/api/kb/list");
              const listJ = await listRes.json().catch(() => ({}));
              const kbs = Array.isArray(listJ.kbs) ? listJ.kbs : [];
              kbId = kbs[0] ? kbs[0].id : "";
            }
            if (!kbId) return { ok: false, error: "还没有知识库，请先创建一个知识库" };
            const res = await fetch("/api/kb/" + encodeURIComponent(kbId) + "/web", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, name: args.name || url }) });
            const j = await res.json().catch(() => ({}));
            if (j.ok) {
              // 刷新侧边栏知识库列表；若正打开知识库页面则重新渲染
              if (global.Sidebar && typeof Sidebar.refresh === "function") Sidebar.refresh();
              if (global.App && location.hash.indexOf("kb") === 1 && typeof App.route === "function") App.route();
            }
            return { ok: !!j.ok, doc: j.doc, pdf: j.pdf, error: j.error };
          } catch (e) { return { ok: false, error: "保存网页到知识库失败：" + (e.message || String(e)) }; }
        }
        case "create_note": {
          const blocks = Array.isArray(args.blocks) ? args.blocks : [];
          const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "";
          if (!blocks.length && !title) return { ok: false, error: "AI 未生成任何内容，请重新要求生成" };
          const pageRes = global.Bridge.execute("page.create", { title: title || "未命名", icon: "✨" });
          if (!pageRes.ok) return { ok: false, error: pageRes.error };
          const pageId = pageRes.result.id;
          const count = this.createBlocksBatch(pageId, blocks);
          return { ok: true, pageId, blockCount: count };
        }
        case "append_blocks": {
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          const blocks = Array.isArray(args.blocks) ? args.blocks : [];
          if (!blocks.length) return { ok: false, error: "AI 未生成任何内容块" };
          const count = this.createBlocksBatch(pageId, blocks, args.after);
          return { ok: true, blockCount: count };
        }
        case "create_questions": {
          const questions = Array.isArray(args.questions) ? args.questions : [];
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          let count = 0;
          questions.forEach(q => {
            const type = ["single", "multiple", "judge", "fill", "short_answer"].includes(q.type) ? q.type : "single";
            if (S.createQuestionBlock(pageId, { type, prompt: q.prompt || "", options: Array.isArray(q.options) ? q.options : [], answer: q.answer == null ? null : q.answer, explanation: q.explanation || "" })) count++;
          });
          if (count && global.App && typeof global.App.route === "function") App.route();
          return { ok: true, count };
        }
        case "create_flashcards": {
          const flashcards = Array.isArray(args.flashcards) ? args.flashcards : [];
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          let count = 0;
          flashcards.forEach(f => { if (S.createFlashcardBlock(pageId, { front: String(f.front || ""), back: String(f.back || "") })) count++; });
          if (count && global.App && typeof global.App.route === "function") App.route();
          return { ok: true, count };
        }
        case "create_block": {
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          const type = EDITABLE_BLOCK_TYPES.includes(args.type) ? args.type : "paragraph";
          const res = global.Bridge.execute("block.create", { pageId, type, text: typeof args.text === "string" ? args.text : "", attrs: normalizeBlockAttrs(args.attrs), after: args.after, before: args.before });
          if (!res.ok) return { ok: false, error: res.error };
          if (typeof args.checked === "boolean") { const blk = S.findBlock(S.getPage(pageId), res.result.id); if (blk) { blk.checked = args.checked; S.markDirty(); } }
          return { ok: true, blockId: res.result.id, type };
        }
        case "update_block": {
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          const payload = { pageId, blockId: args.blockId };
          if (typeof args.text === "string") payload.text = args.text;
          if (typeof args.type === "string") payload.type = args.type;
          if (args.attrs && typeof args.attrs === "object") payload.attrs = normalizeBlockAttrs(args.attrs);
          const res = global.Bridge.execute("block.update", payload);
          if (!res.ok) return { ok: false, error: res.error };
          if (typeof args.checked === "boolean") { const blk = S.findBlock(S.getPage(pageId), args.blockId); if (blk) { blk.checked = args.checked; S.markDirty(); } }
          return { ok: true, blockId: args.blockId };
        }
        case "delete_block": {
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          const res = global.Bridge.execute("block.delete", { pageId, blockId: args.blockId });
          return res.ok ? { ok: true, blockId: args.blockId } : { ok: false, error: res.error };
        }
        case "move_block": {
          const pageId = S.currentPageId;
          if (!pageId) return { ok: false, error: "请先打开一个页面" };
          const res = global.Bridge.execute("block.move", { pageId, blockId: args.blockId, targetId: args.targetId || null, position: args.position === "before" ? "before" : "after" });
          return res.ok ? { ok: true, blockId: args.blockId } : { ok: false, error: res.error };
        }
        case "create_web_page": {
          const url = String(args.url || "").trim();
          if (!url) return { ok: false, error: "缺少网址 url" };
          const pageRes = global.Bridge.execute("page.create", { title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined, icon: "🌐", web: true, url });
          if (!pageRes.ok) return { ok: false, error: pageRes.error };
          if (global.App) App.openPage(pageRes.result.id);
          return { ok: true, pageId: pageRes.result.id, url };
        }
        case "create_pdf_page": {
          const url = String(args.url || "").trim();
          if (!url) return { ok: false, error: "缺少 PDF 网址 url" };
          const pageNum = Number.isInteger(args.page) && args.page > 0 ? args.page : 1;
          const pageRes = global.Bridge.execute("page.create", { title: typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined, icon: "📕", pdf: true, url, page: pageNum });
          if (!pageRes.ok) return { ok: false, error: pageRes.error };
          if (global.App) App.openPage(pageRes.result.id);
          return { ok: true, pageId: pageRes.result.id, url, page: pageNum };
        }
        case "list_pages": {
          const pages = Object.values(S.state.pages || {}).filter(p => p && !p.deleted).map(p => {
            const rawUrl = p.url || "";
            // 本地文件的 data URL 巨大，绝不能放进工具结果（会超过服务器 5MB 上限）
            const url = rawUrl.startsWith("data:") ? "" : rawUrl.slice(0, 500);
            return {
              id: p.id,
              title: U.segsText(p.title) || "未命名",
              type: p.database ? "database" : p.code ? "code" : p.web ? "web" : p.pdf ? "pdf" : "note",
              url,
              favorite: !!p.favorite,
            };
          });
          return { ok: true, pages };
        }
        case "read_pdf": {
          let src = typeof args.url === "string" ? args.url.trim() : "";
          if (args.pageId) {
            const p = S.getPage(args.pageId);
            if (p && !p.deleted && p.pdf) src = p.url || "";
          }
          if (!src) return { ok: false, error: "未找到 PDF 网址，请先用 list_pages 找到对应页面" };
          const text = global.PDFViewer && PDFViewer.extractText ? await PDFViewer.extractText(src) : "";
          if (!text) return { ok: false, error: "无法读取 PDF（可能无文字层、加载失败或网址不可达）" };
          return { ok: true, text };
        }
        case "read_web": {
          let src = typeof args.url === "string" ? args.url.trim() : "";
          if (args.pageId) {
            const p = S.getPage(args.pageId);
            if (p && !p.deleted && p.web) src = p.url || "";
          }
          if (!src) return { ok: false, error: "未找到网页网址，请先用 list_pages 找到对应页面" };
          try {
            const res = await fetch("/api/ai/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: src }) });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) return { ok: false, error: j.error || ("抓取失败 HTTP " + res.status) };
            if (!j.text || !j.text.trim()) return { ok: false, error: "网页没有可提取的正文（可能是需要 JS 渲染的单页应用、反爬页面或纯图片/视频页）" };
            return { ok: true, text: j.text, url: src };
          } catch (e) {
            return { ok: false, error: "无法连接本地服务，请用 node server.js 启动本应用" };
          }
        }
        case "create_exam": {
          const topic = typeof args.topic === "string" ? args.topic.trim() : "";
          const count = Math.max(1, Math.min(30, Number(args.count) || 5));
          if (!topic) return { ok: false, error: "请指定试卷主题（topic）" };
          const questions = Object.values(S.state.questions || {}).filter(q => q && !q.deleted);
          if (!questions.length) return { ok: false, error: "题库中没有题目，请先用 AI 生成一些题目" };
          // 服务端 RAG 向量检索
          let ids = [];
          try {
            const res = await fetch("/api/questions/rag", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: topic, questions: questions.map(q => ({ id: q.id, prompt: q.prompt || "" })), count }),
            });
            const j = await res.json().catch(() => ({}));
            ids = Array.isArray(j.ids) ? j.ids : [];
          } catch (e) { /* 服务端不可用，回退客户端关键词匹配 */ }
          if (!ids.length) {
            const kw = topic.toLowerCase().split(/\s+/);
            const scored = questions.map(q => {
              const t = (q.prompt || "").toLowerCase();
              let s = 0; kw.forEach(k => { if (t.includes(k)) s += 1; });
              return { id: q.id, score: s };
            }).sort((a, b) => b.score - a.score);
            ids = scored.slice(0, count).map(s => s.id);
          }
          const selected = ids.map(id => S.getQuestion(id)).filter(Boolean);
          const examDb = Object.values(S.state.pages).find(p => p.parentId === "root" && !p.deleted && U.segsText(p.title) === "试卷");
          const parentId = examDb ? examDb.id : "root";
          const pageRes = global.Bridge.execute("page.create", { title: topic + " · 试卷", icon: "📋", parentId });
          if (!pageRes.ok) return { ok: false, error: pageRes.error };
          const pageId = pageRes.result.id;
          selected.forEach(q => {
            const qBlk = S.newBlock("question");
            qBlk.attrs = { qid: q.id };
            S.insertBlock(S.getPage(pageId), qBlk, (S.getPage(pageId).children || []).length);
          });
          S.touch(S.getPage(pageId));
          S.markDirty();
          S.save(true);
          if (global.App) App.openPage(pageId);
          return { ok: true, pageId, count: selected.length, topic, method: ids.length ? "向量检索" : "关键词匹配" };
        }
        default: return { ok: false, error: "未知技能：" + name };
      }
    },

    /** AI 批改简答题 */
    async _gradeShortAnswers(items) {
      const results = {};
      const prompts = items.map((item, i) =>
        "题目" + (i + 1) + "：" + (item.prompt || "") + "\n参考答案：" + (item.answer || "") + "\n学生答案：" + (item.userAns || "（未作答）")
      ).join("\n\n");
      const messages = [
        { role: "system", content: (global.I18n && I18n.lang === "en" ? "You are a strict exam grader. Grade each short-answer question and give correct (true/false) and a brief comment. Respond in English. Return JSON only: {\"results\":[{\"id\":\"question-number\",\"correct\":true,\"comment\":\"comment\"}]}. No markdown code block." : "你是一位严格的阅卷老师。请逐题批改以下简答题，每题给出 correct (true/false) 和简短评语。返回 JSON 格式：{\"results\":[{\"id\":\"题号\",\"correct\":true,\"comment\":\"评语\"}]}。不用 markdown 代码块包裹。") },
        { role: "user", content: prompts }
      ];
      try {
        const resp = await this.chatRequest(messages);
        const text = resp.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.results) {
            parsed.results.forEach((r, i) => {
              if (items[i]) {
                results[items[i].id] = { correct: !!r.correct, userAns: items[i].userAns, refAnswer: items[i].answer, comment: r.comment || "" };
              }
            });
          }
        }
      } catch (e) { /* AI 不可用 */ }
      // 未批改的标记为待批改
      items.forEach(item => {
        if (!results[item.id]) results[item.id] = { correct: false, userAns: item.userAns, refAnswer: item.answer, pending: true };
      });
      return results;
    },

    async streamAssistant(query, direct) {
      const msgEl = this.pushMessage("assistant", "", true);
      this.busy = true;
      try {
        await this.streamQuery(query, ev => {
          if (ev.type === "meta") {
            msgEl._citations = ev.citations || [];
            this.renderCitations(msgEl, msgEl._citations);
          } else if (ev.type === "delta") {
            msgEl._text += ev.text || "";
            this.renderAssistantText(msgEl);
          } else if (ev.type === "error") {
            msgEl._text += "\n\n⚠️ " + (ev.message || "出错了");
            this.renderAssistantText(msgEl);
          }
        }, direct);
      } catch (e) {
        msgEl._text += "\n\n⚠️ " + (e.message || String(e));
        this.renderAssistantText(msgEl);
      } finally {
        this.busy = false;
      }
    },

    async streamQuery(query, onEvent, direct) {
      const res = await fetch("/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: localizePrompt(query), k: 5, direct: !!direct }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ("请求失败 " + res.status));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSSEChunk(buf);
        buf = parsed.rest;
        parsed.events.forEach(onEvent);
      }
    },

    pushMessage(role, text, streaming) {
      const list = this.panel.querySelector(".ai-messages");
      const msg = U.el("div", "ai-msg " + role);
      msg._text = text || "";
      if (role === "user") {
        msg.textContent = text;
      } else {
        this.renderAssistantText(msg);
      }
      list.appendChild(msg);
      list.scrollTop = list.scrollHeight;
      return msg;
    },

    renderAssistantText(msg) {
      const body = msg.querySelector(".ai-body") || (() => { const b = U.el("div", "ai-body"); msg.appendChild(b); return b; })();
      body.innerHTML = renderMarkdown(msg._text);
      this.renderWriteAction(msg);
      const list = this.panel.querySelector(".ai-messages");
      list.scrollTop = list.scrollHeight;
    },

    renderWriteAction(msg) {
      if (msg.querySelector(".ai-write")) return;
      if (!(msg._text || "").trim()) return;
      const btn = U.el("button", "ai-write", "＋ 写入本页");
      btn.addEventListener("click", () => this.applyToPage(msg._text));
      msg.appendChild(btn);
    },

    renderCitations(msg, citations) {
      if (!citations || !citations.length) return;
      const wrap = U.el("div", "ai-citations");
      citations.slice(0, 6).forEach(c => {
        const chip = U.el("button", "ai-citation", "↗ " + U.esc(c.pageTitle || "笔记"));
        chip.title = (c.text || "").slice(0, 120);
        chip.addEventListener("click", () => {
          if (global.App && c.pageId) {
            if (c.blockId) location.hash = c.pageId + "-" + c.blockId;
            else App.openPage(c.pageId);
          }
        });
        wrap.appendChild(chip);
      });
      msg.appendChild(wrap);
    },

    /* ================= Write confirmation ================= */
    applyToPage(text) {
      const S = global.Store;
      const pageId = S.currentPageId;
      if (!pageId) { U.toast("请先打开一个页面再写入"); return; }
      const page = S.getPage(pageId);
      const blocks = markdownToBlocks(text);
      if (!blocks.length) { U.toast("没有可写入的内容"); return; }
      let ok = 0;
      blocks.forEach(b => {
        const blk = S.newBlock(b.type);
        if (b.type !== "divider") blk.text = b.segments;
        S.insertBlock(page, blk);
        ok++;
      });
      U.toast("已写入 " + ok + " 个块");
      this.scheduleSync();
    },

    currentContent() {
      const S = global.Store;
      const pageId = S.currentPageId;
      const page = pageId ? S.getPage(pageId) : null;
      if (!page) return null;
      const flat = [];
      const walk = blocks => (blocks || []).forEach(b => { if (b.text && segsText(b.text).trim()) flat.push(segsText(b.text)); if (b.children) walk(b.children); });
      walk(page.children);
      return { page, content: flat.join("\n").slice(0, 8000) };
    },

    styleHint() {
      const s = WRITING_STYLES.find(x => x.id === this.style);
      return s && s.hint ? s.hint : "";
    },

    /** 弹出多选，让用户选择希望使用的块类型；返回 blockTypes 数组 */
    askBlockTypes(purpose) {
      return new Promise(resolve => {
        const modal = U.modal({ title: U.t("选择块类型"), size: "sm", onClose: () => resolve([]) });
        const hint = U.el("div", "modal-msg", U.esc(purpose || "请选择你希望使用的块类型（可多选）"));
        hint.style.marginBottom = "10px";
        modal.body.appendChild(hint);
        const opts = [
          ["heading2", "标题"],
          ["paragraph", "段落"],
          ["bullet", "无序列表"],
          ["numbered", "有序列表"],
          ["todo", "待办事项"],
          ["quote", "引用"],
          ["callout", "标注"],
          ["table", "表格"],
          ["equation", "公式"],
          ["mermaid", "Mermaid 图表"],
          ["code", "代码"],
          ["html", "交互网页"],
        ];
        const selected = new Set(["heading2", "paragraph"]);
        const grid = U.el("div", "ai-block-picker");
        opts.forEach(([val, label]) => {
          const lb = U.el("label", "ai-block-opt");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = val;
          cb.checked = selected.has(val);
          cb.addEventListener("change", () => { cb.checked ? selected.add(val) : selected.delete(val); });
          lb.appendChild(cb);
          lb.appendChild(document.createTextNode(" " + label));
          grid.appendChild(lb);
        });
        modal.body.appendChild(grid);
        const ok = U.el("button", "db-btn primary", "确定");
        const cancel = U.el("button", "db-btn", "取消");
        ok.addEventListener("click", () => { modal.close(); resolve(Array.from(selected)); });
        cancel.addEventListener("click", () => modal.close());
        modal.foot.appendChild(cancel); modal.foot.appendChild(ok);
      });
    },

    async summarizePage() {
      const ctx = this.currentContent();
      if (!ctx) { U.toast("请先打开一个页面"); return; }
      const prompt = "请用中文总结下面这份笔记的要点，输出 3-5 条要点。" + (this.styleHint() ? "\n\n" + this.styleHint() : "") + "\n\n笔记内容：\n" + ctx.content;
      this.proposeDraft("总结本页", prompt, draft => {
        const res = global.Bridge.execute("block.create", { pageId: ctx.page.id, type: "callout", text: "📄 本页摘要：\n" + draft, attrs: { icon: "📄" } });
        if (!res.ok) { U.toast("写入失败：" + res.error); return; }
        U.toast("摘要已写入本页");
        this.scheduleSync();
      });
    },

    async tutorPage() {
      const ctx = this.currentContent();
      if (!ctx) { U.toast("请先打开一个页面"); return; }
      const prompt = "请像一位耐心的老师一样，用通俗、结构化的方式讲解下面这份笔记的核心概念，可适当举例子。" + (this.styleHint() ? "\n\n" + this.styleHint() : "") + "\n\n笔记内容：\n" + ctx.content;
      this.pushMessage("user", "🎓 讲解本页");
      await this.streamAssistant(prompt, true);
    },

    /** 生成可交互 HTML 网页（可视化教学），返回完整 HTML 文档 */
    async generateHTML(topic) {
      const prompt = "请生成一个完整的、可交互的 HTML 网页，用于可视化教学主题：「" + topic + "」。要求：\n" +
        "1. 单个 HTML 文件，内联 CSS 和 JavaScript；不引用外部资源（如需图表库，可用 Canvas/SVG 手写）。\n" +
        "2. 页面必须可交互：包含按钮、滑块、输入、动画或图表等交互元素，能直观演示该主题。\n" +
        "3. 视觉清晰美观，中文界面，适合教学。\n" +
        "4. 只输出完整 HTML 代码（从 <!DOCTYPE html> 到 </html>），不要任何解释文字、Markdown 代码块标记（```）或前后缀。";
      try {
        const resp = await this.chatRequest([{ role: "user", content: prompt }]);
        return (resp && resp.content) || "";
      } catch (e) {
        U.toast("⚠️ " + (e.message || String(e)));
        return "";
      }
    },

    async generateQuestions() {
      const ctx = this.currentContent();
      if (!ctx) { U.toast("请先打开一个页面"); return; }
      this.generateStructured("生成题目", buildQuestionsPrompt(ctx.content, 3), item => ({
        label: ({ single: "单选", multiple: "多选", judge: "判断", fill: "填空", short_answer: "简答" }[item.type] || item.type) + " · " + (item.prompt || ""),
      }), item => {
        const S = global.Store;
        const pageId = S.currentPageId;
        if (!pageId) return { ok: false, error: "请先打开一个页面" };
        const type = ["single", "multiple", "judge", "fill", "short_answer"].includes(item.type) ? item.type : "single";
        const res = S.createQuestionBlock(pageId, { type, prompt: item.prompt || "", options: Array.isArray(item.options) ? item.options : [], answer: item.answer == null ? null : item.answer, explanation: item.explanation || "" });
        return res ? { ok: true, result: res.question } : { ok: false, error: "写入失败" };
      });
    },

    async generateFlashcards() {
      const ctx = this.currentContent();
      if (!ctx) { U.toast("请先打开一个页面"); return; }
      this.generateStructured("生成闪卡", buildFlashcardsPrompt(ctx.content, 5), item => ({ label: (item.front || "") + " → " + (item.back || "") }), item => {
        const S = global.Store;
        const pageId = S.currentPageId;
        if (!pageId) return { ok: false, error: "请先打开一个页面" };
        const res = S.createFlashcardBlock(pageId, { front: String(item.front || ""), back: String(item.back || "") });
        return res ? { ok: true, result: res.flashcard } : { ok: false, error: "写入失败" };
      });
    },

    async generateStructured(label, prompt, describe, applyOne) {
      const draftEl = this.panel.querySelector(".ai-draft");
      draftEl.hidden = false;
      draftEl.innerHTML = '<div class="ai-draft-label">' + U.esc(label) + '</div><div class="ai-draft-body">生成中…</div><div class="ai-draft-actions"></div>';
      const body = draftEl.querySelector(".ai-draft-body");
      const actions = draftEl.querySelector(".ai-draft-actions");
      let text = "";
      this.busy = true;
      try {
        const res = await fetch("/api/ai/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: localizePrompt(prompt), k: 0, direct: true }) });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "请求失败"); }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSSEChunk(buf);
          buf = parsed.rest;
          parsed.events.forEach(ev => {
            if (ev.type === "delta") text += ev.text || "";
            else if (ev.type === "error") text += "\n⚠️ " + (ev.message || "出错了");
          });
        }
        const items = extractJSON(text);
        if (!Array.isArray(items) || !items.length) {
          body.textContent = "未能解析出结构化内容，请重试。" + (text ? "\n\n原始输出：\n" + text.slice(0, 400) : "");
          return;
        }
        body.innerHTML = "";
        const list = U.el("div", "ai-gen-list");
        items.forEach(item => {
          const row = U.el("div", "ai-gen-item");
          row.textContent = describe(item).label;
          list.appendChild(row);
        });
        body.appendChild(list);
        const apply = U.el("button", "db-btn primary", "全部应用（" + items.length + "）");
        apply.addEventListener("click", () => {
          let ok = 0;
          items.forEach(item => { if (applyOne(item).ok) ok++; });
          U.toast("已写入 " + ok + " 条");
          this.scheduleSync();
          if (ok && global.App && typeof global.App.route === "function") App.route();
          draftEl.hidden = true; draftEl.innerHTML = "";
        });
        const ignore = U.el("button", "db-btn", "忽略");
        ignore.addEventListener("click", () => { draftEl.hidden = true; draftEl.innerHTML = ""; });
        actions.appendChild(apply); actions.appendChild(ignore);
      } catch (e) {
        body.textContent = "⚠️ " + (e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    async proposeDraft(label, prompt, applyFn) {
      const draftEl = this.panel.querySelector(".ai-draft");
      draftEl.hidden = false;
      draftEl.innerHTML = '<div class="ai-draft-label">' + U.esc(label) + '</div><div class="ai-draft-body">生成中…</div><div class="ai-draft-actions"><button class="ai-apply db-btn primary">应用</button><button class="ai-ignore db-btn">忽略</button></div>';
      const body = draftEl.querySelector(".ai-draft-body");
      const close = () => { draftEl.hidden = true; draftEl.innerHTML = ""; };
      draftEl.querySelector(".ai-ignore").addEventListener("click", close);
      let text = "";
      this.busy = true;
      try {
        const res = await fetch("/api/ai/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: localizePrompt(prompt), k: 0, direct: true }),
        });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "请求失败"); }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parsed = parseSSEChunk(buf);
          buf = parsed.rest;
          parsed.events.forEach(ev => {
            if (ev.type === "delta") { text += ev.text || ""; body.innerHTML = renderMarkdown(text); }
            else if (ev.type === "error") { text += "\n⚠️ " + (ev.message || "出错了"); body.innerHTML = renderMarkdown(text); }
          });
        }
        if (!text.trim()) { body.innerHTML = "（未生成内容）"; return; }
        const applyBtn = draftEl.querySelector(".ai-apply");
        applyBtn.disabled = false;
        applyBtn.addEventListener("click", () => { close(); applyFn(text.trim()); });
      } catch (e) {
        body.innerHTML = "⚠️ " + U.esc(e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    /* ================= Note generation ================= */
    async streamText(prompt) {
      const res = await fetch("/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: localizePrompt(prompt), k: 0, direct: true }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ("请求失败 " + res.status)); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "", buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSSEChunk(buf);
        buf = parsed.rest;
        parsed.events.forEach(ev => {
          if (ev.type === "delta") text += ev.text || "";
          else if (ev.type === "error") text += "\n⚠️ " + (ev.message || "出错了");
        });
      }
      return text;
    },

    async proposeStructured(label, prompt, renderPreview, applyFn) {
      const draftEl = this.panel.querySelector(".ai-draft");
      draftEl.hidden = false;
      draftEl.innerHTML = '<div class="ai-draft-label">' + U.esc(label) + '</div><div class="ai-draft-body">生成中…</div><div class="ai-draft-actions"></div>';
      const body = draftEl.querySelector(".ai-draft-body");
      const actions = draftEl.querySelector(".ai-draft-actions");
      this.busy = true;
      try {
        const text = await this.streamText(prompt);
        const parsed = extractJSON(text);
        if (!parsed) {
          body.textContent = "未能解析出结构化内容，请重试。" + (text ? "\n\n原始输出：\n" + text.slice(0, 400) : "");
          return;
        }
        body.innerHTML = "";
        renderPreview(parsed, body);
        const apply = U.el("button", "db-btn primary", "应用");
        apply.addEventListener("click", () => { applyFn(parsed); draftEl.hidden = true; draftEl.innerHTML = ""; });
        const ignore = U.el("button", "db-btn", "忽略");
        ignore.addEventListener("click", () => { draftEl.hidden = true; draftEl.innerHTML = ""; });
        actions.appendChild(apply); actions.appendChild(ignore);
      } catch (e) {
        body.textContent = "⚠️ " + (e.message || String(e));
      } finally {
        this.busy = false;
      }
    },

    sanitizeBlock(block) {
      if (!block || typeof block !== "object") return null;
      let type = EDITABLE_BLOCK_TYPES.includes(block.type) ? block.type : "paragraph";
      let text = typeof block.text === "string" ? block.text.trim() : "";
      if (type !== "equation" && /^\$\$[\s\S]+\$\$$/.test(text)) type = "equation";
      else if (type !== "equation") text = normalizeInlineDisplayMath(text);
      const attrs = (block.attrs && typeof block.attrs === "object") ? normalizeBlockAttrs(block.attrs) : null;
      const hasAttrs = attrs && Object.keys(attrs).length > 0;
      if (!text && !hasAttrs) return null; // 允许仅含 attrs 的块（表格/图表/代码/HTML 等）
      const out = { type, text };
      if (hasAttrs) out.attrs = attrs;
      return out;
    },

    /** 批量创建块：一次性写入存储并只渲染/保存一次，避免逐块渲染导致的 O(N²) 卡顿与 OOM */
    createBlocksBatch(pageId, blocks, after) {
      const S = global.Store;
      const page = S.getPage(pageId);
      if (!page) return 0;
      let base = page.children.length; // 默认追加到末尾
      if (typeof after === "string" && after) {
        const idx = page.children.findIndex(b => b.id === after);
        if (idx >= 0) base = idx + 1;
      }
      let count = 0;
      (blocks || []).forEach(b => {
        const nb = this.sanitizeBlock(b);
        if (!nb) return;
        const blk = S.newBlock(nb.type);
        if (nb.text) blk.text = nb.type === "equation" ? [{ t: nb.text }] : inlineToSegments(nb.text);
        if (nb.attrs && typeof nb.attrs === "object") Object.assign(blk.attrs, nb.attrs);
        S.insertBlock(page, blk, base + count);
        count++;
      });
      if (count) {
        S.touch(page);
        S.markDirty();
        S.save(true);
        if (global.App && typeof global.App.route === "function") App.route();
      }
      return count;
    },

    writeBlocks(pageId, blocks) {
      return this.createBlocksBatch(pageId, blocks);
    },

    async generateNote() {
      const topic = await U.promptModal({ title: U.t("生成笔记"), placeholder: U.t("请输入要生成笔记的主题 / 知识点") });
      if (!topic || !topic.trim()) return;
      const t = topic.trim();
      this.proposeStructured("生成笔记 · " + t, buildNotePrompt(t, this.styleHint()), (parsed, body) => {
        const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
        const titleEl = U.el("div", "ai-gen-item", "📄 " + U.esc(typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : t));
        body.appendChild(titleEl);
        const list = U.el("div", "ai-gen-list");
        blocks.forEach(b => { const nb = this.sanitizeBlock(b); if (nb) list.appendChild(U.el("div", "ai-gen-item", U.esc(nb.type + " · " + nb.text.slice(0, 60)))); });
        body.appendChild(list);
      }, parsed => {
        const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : t;
        const pageRes = global.Bridge.execute("page.create", { title, icon: "✨" });
        if (!pageRes.ok) { U.toast("创建页面失败：" + pageRes.error); return; }
        const pageId = pageRes.result.id;
        const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
        const ok = this.writeBlocks(pageId, blocks);
        U.toast("已生成笔记（" + ok + " 个块）");
        if (global.App) App.openPage(pageId);
        this.scheduleSync();
      });
    },

    async supplementPage() {
      const ctx = this.currentContent();
      if (!ctx) { U.toast("请先打开一个页面"); return; }
      const title = U.segsText(ctx.page.title) || "未命名";
      this.proposeStructured("补充本页", buildSupplementPrompt(title, ctx.content, this.styleHint()), (parsed, body) => {
        const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
        const list = U.el("div", "ai-gen-list");
        blocks.forEach(b => { const nb = this.sanitizeBlock(b); if (nb) list.appendChild(U.el("div", "ai-gen-item", U.esc(nb.type + " · " + nb.text.slice(0, 60)))); });
        body.appendChild(list);
      }, parsed => {
        const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
        const ok = this.writeBlocks(ctx.page.id, blocks);
        U.toast("已补充 " + ok + " 个块");
        this.scheduleSync();
      });
    },

    /* ================= Settings ================= */
    openSettings() {
      this.toggle(false);
      if (global.App) App.openPage("settings");
      else location.hash = "settings";
    },

    async refreshStatus() {
      const el = this.panel && this.panel.querySelector(".ai-status");
      if (!el) return;
      try {
        const res = await fetch("/api/ai/status");
        const st = await res.json();
        el.textContent = st.configured ? (U.t("已就绪 · 索引") + " " + st.indexSize + " " + U.t("段")) : U.t("未配置 · 点 ⚙ 设置");
        el.className = "ai-status" + (st.configured ? " ok" : "");
      } catch (e) {
        el.textContent = U.t("本地服务未启动");
        el.className = "ai-status";
      }
    },

    /* ================= Index sync ================= */
    scheduleSync() {
      if (this._syncTimer) clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => this.syncIndex(), 1500);
    },

    async syncIndex() {
      const S = global.Store;
      if (!S || !S.state || !S.state.pages) return;
      const { items, signatures } = collectIndexItems(S.state);
      const media = await collectMediaItems(S.state);
      media.forEach(m => { items.push(m); signatures.set(m.blockId, buildSignature(m.pageId, m.text)); });
      const upserts = [];
      items.forEach(item => {
        if (this.synced.get(item.blockId) !== signatures.get(item.blockId)) upserts.push(item);
      });
      const deletes = [];
      this.synced.forEach((sig, blockId) => {
        if (!signatures.has(blockId)) deletes.push(blockId);
      });

      if (upserts.length) {
        try {
          await fetch("/api/ai/index/upsert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: upserts }) });
        } catch (e) { return; }
      }
      for (const blockId of deletes) {
        try {
          await fetch("/api/ai/index/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
        } catch (e) { return; }
      }
      this.synced = signatures;
      this.refreshStatus();
    },

    async rebuildIndex() {
      const S = global.Store;
      if (!S || !S.state) return;
      U.toast("正在重建索引…");
      this.synced = new Map();
      mediaCache.clear();
      const { items } = collectIndexItems(S.state);
      const media = await collectMediaItems(S.state);
      media.forEach(m => items.push(m));
      try {
        const res = await fetch("/api/ai/index/rebuild", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { U.toast("重建失败：" + (j.error || res.status)); return; }
        items.forEach(item => this.synced.set(item.blockId, buildSignature(item.pageId, item.text)));
        U.toast("索引已重建（" + (j.indexSize || items.length) + " 段）");
        this.refreshStatus();
      } catch (e) {
        U.toast("重建失败：" + (e.message || String(e)));
      }
    },
  };

  global.AI = AI;
})(window);
