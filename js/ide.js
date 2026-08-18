/* ============ IDE mode: VS Code-style editor + runner ============ */
(function (global) {
  "use strict";

  const S = Store;

  const LANGS = [
    ["python", "Python"],
    ["c", "C"],
    ["cpp", "C++"],
    ["java", "Java"],
  ];

  const KEYWORDS = {
    python: ["def","return","if","elif","else","for","while","in","not","and","or","import","from","as","class","try","except","finally","raise","with","pass","break","continue","lambda","None","True","False","global","nonlocal","yield","assert","del","is"],
    c: ["int","float","double","char","void","long","short","unsigned","signed","const","static","struct","union","enum","typedef","return","if","else","for","while","do","switch","case","break","continue","default","sizeof","goto","extern","volatile","auto","register","inline"],
    cpp: ["int","float","double","char","void","long","short","unsigned","signed","const","static","struct","class","enum","typedef","return","if","else","for","while","do","switch","case","break","continue","default","sizeof","new","delete","this","namespace","using","public","private","protected","virtual","override","template","typename","bool","true","false","nullptr","auto","constexpr","try","catch","throw"],
    java: ["public","private","protected","static","final","void","int","long","double","float","char","boolean","byte","short","class","interface","extends","implements","return","if","else","for","while","do","switch","case","break","continue","default","new","this","super","import","package","try","catch","finally","throw","throws","null","true","false","abstract","enum","instanceof","synchronized","volatile","transient"],
  };

  const IDE = {
    page: null,
    fileId: null,
    tabs: [],
    compilers: null,

    /* ---------------- pure helpers ---------------- */
    highlight(source, language) {
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const enc = (n) => { let s = ""; n = n + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
      const dec = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 65 + 1); return n - 1; };
      let src = String(source == null ? "" : source);
      const tokens = [];
      const protect = (re, cls) => {
        src = src.replace(re, (m) => {
          const id = tokens.length;
          tokens.push('<span class="' + cls + '">' + esc(m) + '</span>');
          return "\u0001" + enc(id) + "\u0002";
        });
      };
      if (language === "python") protect(/#[^\n]*/g, "tok-comment");
      else protect(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "tok-comment");
      protect(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "tok-string");
      let html = esc(src);
      const kws = KEYWORDS[language] || [];
      if (kws.length) html = html.replace(new RegExp("\\b(" + kws.join("|") + ")\\b", "g"), '<span class="tok-keyword">$1</span>');
      html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
      html = html.replace(/\u0001([A-Z]+)\u0002/g, (m, code) => tokens[dec(code)]);
      return html;
    },

    fileTree(rootPage) {
      if (!rootPage || !rootPage.code) return [];
      const node = (page) => ({
        pageId: page.id,
        title: U.segsText(page.title).trim() || "未命名",
        language: (page.codeData && page.codeData.language) || "python",
        children: S.getChildren(page.id).filter(c => c.code).map(node),
      });
      return [node(rootPage)];
    },

    /** Return a text edit for basic code-editor pairing and indentation, or null. */
    applyCodeEdit(value, start, end, key, language) {
      value = String(value == null ? "" : value);
      const pairs = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'", "`": "`" };
      const closers = new Set(Object.values(pairs));
      const result = (next, caretStart, caretEnd) => ({ value: next, start: caretStart, end: caretEnd == null ? caretStart : caretEnd });
      const before = value.slice(0, start), selected = value.slice(start, end), after = value.slice(end);

      if (key === "Backspace" && start === end && start > 0 && value[start] && pairs[value[start - 1]] === value[start]) {
        return result(value.slice(0, start - 1) + value.slice(start + 1), start - 1);
      }

      if (key === "Enter") {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const line = value.slice(lineStart, start);
        const indent = (line.match(/^[\t ]*/) || [""])[0];
        if (start === end && value[start - 1] === "{" && value[start] === "}") {
          const nested = indent + "    ";
          return result(before + "\n" + nested + "\n" + indent + after, before.length + 1 + nested.length);
        }
        const nextIndent = language === "python" && line.trim().endsWith(":") ? indent + "    " : indent;
        return result(before + "\n" + nextIndent + after, before.length + 1 + nextIndent.length);
      }

      if (closers.has(key) && start === end && value[start] === key) return result(value, start + 1);

      if (Object.prototype.hasOwnProperty.call(pairs, key)) {
        const close = pairs[key];
        if (start !== end) return result(before + key + selected + close + after, start + 1, end + 1);
        return result(before + key + close + after, start + 1);
      }
      return null;
    },

    /* ---------------- render ---------------- */
    render(page) {
      this.page = page;
      S.currentPageId = page.id;
      this.fileId = page.id;
      this.tabs = [page.id];
      this._runId = null;

      const content = U.renderRoot();
      content.innerHTML = "";
      const ide = U.el("div", "ide");
      content.appendChild(ide);

      // activity bar
      const activity = U.el("div", "ide-activity");
      const explorerBtn = U.el("button", "ide-act-btn active");
      explorerBtn.title = "资源管理器 (Ctrl+B)";
      explorerBtn.innerHTML = "📁";
      explorerBtn.addEventListener("click", () => this.toggleExplorer(explorerBtn));
      activity.appendChild(explorerBtn);
      const runBtn = U.el("button", "ide-act-btn");
      runBtn.title = "运行 (Ctrl+Enter)";
      runBtn.innerHTML = "▶";
      runBtn.addEventListener("click", () => this.run());
      const stopBtn = U.el("button", "ide-act-btn");
      stopBtn.title = "停止运行";
      stopBtn.innerHTML = "■";
      stopBtn.addEventListener("click", () => this.stop());
      activity.appendChild(runBtn); activity.appendChild(stopBtn);
      ide.appendChild(activity);

      // explorer sidebar
      const sidebar = U.el("div", "ide-sidebar");
      sidebar.appendChild(U.el("div", "ide-side-title", "资源管理器"));
      const tree = U.el("div", "ide-explorer");
      sidebar.appendChild(tree);
      ide.appendChild(sidebar);

      // main column
      const main = U.el("div", "ide-main");
      const tabs = U.el("div", "ide-tabs");
      main.appendChild(tabs);

      const code = U.el("div", "ide-code");
      const gutter = U.el("div", "ide-gutter");
      const highlightPre = U.el("pre", "ide-highlight");
      const highlightCode = U.el("code", null);
      highlightPre.appendChild(highlightCode);
      const editor = U.el("textarea", "ide-editor");
      editor.spellcheck = false;
      editor.autocapitalize = "off";
      editor.autocomplete = "off";
      editor.wrap = "off";
      code.appendChild(gutter);
      code.appendChild(highlightPre);
      code.appendChild(editor);
      main.appendChild(code);

      const panel = U.el("div", "ide-panel");
      const panelHead = U.el("div", "ide-panel-head");
      panelHead.appendChild(U.el("div", "ide-panel-tab active", "输出"));
      panel.appendChild(panelHead);
      const out = U.el("pre", "ide-output");
      panel.appendChild(out);
      main.appendChild(panel);

      const status = U.el("div", "ide-status");
      const statusLang = U.el("span", "ide-status-item lang", "Python");
      const statusCompiler = U.el("span", "ide-status-item", "");
      const spacer = U.el("span", "ide-status-spacer");
      const statusPos = U.el("span", "ide-status-item", "Ln 1, Col 1");
      const statusTotal = U.el("span", "ide-status-item", "1 行");
      const statusEnc = U.el("span", "ide-status-item", "UTF-8");
      status.append(statusLang, statusCompiler, spacer, statusPos, statusTotal, statusEnc);
      main.appendChild(status);
      ide.appendChild(main);

      // refs
      this._ide = ide;
      this._code = code;
      this._explorerBtn = explorerBtn;
      this._sidebar = sidebar;
      this._tree = tree;
      this._tabsEl = tabs;
      this._gutter = gutter;
      this._highlightPre = highlightPre;
      this._highlightCode = highlightCode;
      this._editor = editor;
      this._out = out;
      this._statusLang = statusLang;
      this._statusCompiler = statusCompiler;
      this._statusPos = statusPos;
      this._statusTotal = statusTotal;

      statusLang.addEventListener("click", () => this.cycleLanguage());

      editor.addEventListener("input", () => this.onEditorInput());
      editor.addEventListener("keydown", (e) => {
        if (e.key === "Tab") { e.preventDefault(); this.insertTab(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.run(); return; }
        if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        const active = S.getPage(this.fileId);
        const edit = IDE.applyCodeEdit(editor.value, editor.selectionStart, editor.selectionEnd, e.key, (active && active.codeData && active.codeData.language) || "python");
        if (edit) { e.preventDefault(); this.applyEditorEdit(edit); }
      });
      editor.addEventListener("scroll", () => this.syncEditorScroll());
      editor.addEventListener("keyup", () => this.updateCursor());
      editor.addEventListener("click", () => this.updateCursor());
      code.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.setFontSize(this.fontSize + (e.deltaY < 0 ? 1 : -1));
      }, { passive: false });

      this.fontSize = Number(localStorage.getItem("notionish_ide_font")) || 14;
      this.applyFontSize();

      this.renderExplorer();
      this.renderTabs();
      this.loadFile(this.page.id);
      this.detectCompilers();
    },

    setFontSize(size) {
      this.fontSize = Math.max(8, Math.min(40, Math.round(size)));
      localStorage.setItem("notionish_ide_font", String(this.fontSize));
      this.applyFontSize();
    },

    applyFontSize() {
      if (!this._ide) return;
      this._ide.style.setProperty("--ide-font-size", this.fontSize + "px");
      this.syncEditorScroll();
    },

    /* ---------------- sub-renderers ---------------- */
    languageLabel(lang) { const hit = LANGS.find(l => l[0] === lang); return hit ? hit[1] : "Python"; },

    renderExplorer() {
      U.clear(this._tree);
      const nodes = IDE.fileTree(this.page);
      const renderNode = (node, depth) => {
        const row = U.el("div", "ide-file-row" + (node.pageId === this.fileId ? " active" : ""));
        row.style.paddingLeft = (10 + depth * 14) + "px";
        const dot = U.el("span", "ide-file-dot lang-" + node.language);
        const label = U.el("span", "ide-file-label", node.title);
        row.appendChild(dot); row.appendChild(label);
        row.title = node.title + " · " + this.languageLabel(node.language);
        row.addEventListener("click", () => this.openFile(node.pageId));
        this._tree.appendChild(row);
        node.children.forEach(c => renderNode(c, depth + 1));
      };
      nodes.forEach(n => renderNode(n, 0));
    },

    renderTabs() {
      U.clear(this._tabsEl);
      this.tabs.forEach(id => {
        const page = S.getPage(id);
        if (!page) return;
        const tab = U.el("div", "ide-tab" + (id === this.fileId ? " active" : ""));
        const title = U.el("span", "ide-tab-title", U.segsText(page.title).trim() || "未命名");
        title.addEventListener("click", () => this.openFile(id));
        const close = U.el("span", "ide-tab-close", "×");
        close.title = "关闭";
        close.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(id); });
        tab.appendChild(title); tab.appendChild(close);
        this._tabsEl.appendChild(tab);
      });
    },

    /* ---------------- file switching ---------------- */
    openFile(id) {
      const page = S.getPage(id);
      if (!page || !page.code) return;
      if (!this.tabs.includes(id)) this.tabs.push(id);
      this.fileId = id;
      this.loadFile(id);
      this.renderTabs();
      this.renderExplorer();
    },

    closeTab(id) {
      const idx = this.tabs.indexOf(id);
      if (idx < 0) return;
      this.tabs.splice(idx, 1);
      if (!this.tabs.length) { this.tabs.push(this.page.id); this.fileId = this.page.id; }
      else if (this.fileId === id) this.fileId = this.tabs[Math.max(0, idx - 1)];
      this.loadFile(this.fileId);
      this.renderTabs();
      this.renderExplorer();
    },

    toggleExplorer(btn) {
      const collapsed = this._sidebar.classList.toggle("collapsed");
      btn.classList.toggle("active", !collapsed);
    },

    cycleLanguage() {
      const page = S.getPage(this.fileId);
      if (!page) return;
      const langs = LANGS.map(l => l[0]);
      const idx = langs.indexOf(page.codeData.language);
      page.codeData.language = langs[(idx + 1) % langs.length];
      S.markDirty();
      this.loadFile(this.fileId);
      this.renderExplorer();
    },

    /* ---------------- editor ---------------- */
    loadFile(id) {
      const page = S.getPage(id);
      if (!page) return;
      this.fileId = id;
      this._editor.value = (page.codeData && page.codeData.source) || "";
      this.applyHighlight();
      this.updateLineNumbers();
      this.updateStatus();
      this.updateCursor();
    },

    onEditorInput() {
      S.setCodeSource(this.fileId, this._editor.value);
      this.applyHighlight();
      this.updateLineNumbers();
      this.updateCursor();
    },

    applyEditorEdit(edit) {
      this._editor.value = edit.value;
      this._editor.selectionStart = edit.start;
      this._editor.selectionEnd = edit.end;
      this.onEditorInput();
    },

    insertTab() {
      const el = this._editor;
      const start = el.selectionStart, end = el.selectionEnd;
      el.value = el.value.slice(0, start) + "    " + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + 4;
      this.onEditorInput();
    },

    applyHighlight() {
      const page = S.getPage(this.fileId);
      const lang = (page && page.codeData && page.codeData.language) || "python";
      this._highlightCode.innerHTML = IDE.highlight(this._editor.value, lang) + "\n";
    },

    updateLineNumbers() {
      const count = this._editor.value.split("\n").length;
      let html = "";
      for (let i = 1; i <= count; i++) html += i + "\n";
      this._gutter.textContent = html;
    },

    syncEditorScroll() {
      const t = this._editor;
      this._gutter.style.transform = "translateY(-" + t.scrollTop + "px)";
      this._highlightPre.style.transform = "translate(-" + t.scrollLeft + "px, -" + t.scrollTop + "px)";
    },

    updateCursor() {
      const t = this._editor;
      const upTo = t.value.slice(0, t.selectionStart);
      const parts = upTo.split("\n");
      const ln = parts.length;
      const col = parts[parts.length - 1].length + 1;
      this._statusPos.textContent = "Ln " + ln + ", Col " + col;
      this._statusTotal.textContent = t.value.split("\n").length + " 行";
    },

    updateStatus() {
      const page = S.getPage(this.fileId);
      if (!page) return;
      this._statusLang.textContent = this.languageLabel(page.codeData.language);
      this.refreshCompilerStatus();
    },

    /* ---------------- compilers + run ---------------- */
    refreshCompilerStatus() {
      const page = S.getPage(this.fileId);
      const lang = (page && page.codeData && page.codeData.language) || "python";
      const found = this.compilers && this.compilers[lang] && this.compilers[lang].length;
      if (!this.compilers) { this._statusCompiler.textContent = "⚠ 未连接运行服务"; return; }
      if (found) this._statusCompiler.textContent = "✓ " + this.compilers[lang][0].cmd + (this.compilers[lang][0].version ? " " + this.compilers[lang][0].version : "");
      else this._statusCompiler.textContent = "✗ 未检测到 " + lang + " 编译器";
    },

    async detectCompilers() {
      try {
        const res = await fetch("/api/compilers");
        if (!res.ok) throw new Error("http " + res.status);
        this.compilers = await res.json();
      } catch (e) {
        this.compilers = null;
      }
      this.refreshCompilerStatus();
    },

    appendOutput(text) {
      this._out.textContent += text;
      this._out.scrollTop = this._out.scrollHeight;
    },

    async run() {
      const project = S.collectCodeProject(this.page.id);
      if (!project) return;
      this._out.textContent = "";
      this.appendOutput("$ " + project.entry + "\n");
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: project.language, entry: project.entry, files: project.files, timeoutMs: 30000 }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          this.appendOutput("请求失败: " + (j.error || res.status) + "\n");
          return;
        }
        this._runId = res.headers.get("X-Run-Id");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch (e) { continue; }
            if (obj.stream) this.appendOutput(obj.text);
            else if (obj.done) this.finishRun(obj);
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") this.appendOutput("运行失败: " + e.message + "\n");
      } finally {
        this._runId = null;
      }
    },

    finishRun(obj) {
      if (obj.error) this.appendOutput(obj.error + "\n");
      this.appendOutput("— 退出码 " + obj.exitCode + " · " + obj.durationMs + " ms" + (obj.timedOut ? " · 超时" : "") + "\n");
    },

    stop() {
      if (this._runId) fetch("/api/run/" + this._runId + "/cancel", { method: "POST" }).catch(() => {});
      this._runId = null;
    },
  };

  global.IDE = IDE;
})(window);
