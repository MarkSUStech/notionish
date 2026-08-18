/* ============ Editor: block editing, keyboard, menus, drag & drop ============ */
(function (global) {
  "use strict";

  const B = Blocks, S = Store;

  const Editor = {
    page: null,
    blocksEl: null,
    _clipboard: null, // 剪切/复制的块缓存
    _aiBtn: null,     // 共享的块级 AI 浮动按钮
    _aiBlockId: null, // 当前聚焦的块 id

    /* ================= Rendering ================= */
    renderPage(pageId) {
      const page = S.getPage(pageId);
      const content = U.renderRoot();
      if (!page) {
        content.innerHTML = "";
        const empty = U.el("div", "empty-state");
        empty.innerHTML = '<div class="es-ico">📄</div>页面不存在';
        content.appendChild(empty);
        return;
      }
      this.page = page;
      S.currentPageId = page.id;
      this.clearSelection();
      this._mathEditing = null;
      this.removeMultiToolbar();

      if (page.database && Database) {
        Database.render(page);
        return;
      }
      if (page.code && global.IDE) {
        IDE.render(page);
        return;
      }
      this.renderPageContent(page);
    },

    renderPageContent(page) {
      const content = U.renderRoot();
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll");
      content.appendChild(scroll);

      // cover
      if (page.cover) {
        if (page.cover.startsWith("linear-gradient")) {
          const holder = U.el("div", "page-cover-holder");
          holder.style.background = page.cover;
          scroll.appendChild(holder);
        } else {
          const img = U.el("img", "page-cover");
          img.src = page.cover;
          scroll.appendChild(img);
        }
      }

      // head: icon + title
      const head = U.el("div", "page-head");
      const iconEl = U.el("div", "page-icon", page.icon || "");
      iconEl.title = "点击更换图标";
      iconEl.dataset.role = "page-icon";
      head.appendChild(iconEl);
      const title = U.el("div", "page-title-input");
      title.contentEditable = "true";
      title.spellcheck = false;
      title.dataset.role = "page-title";
      title.dataset.ph = "未命名";
      title.innerHTML = B.segsToHTML(page.title);
      head.appendChild(title);
      scroll.appendChild(head);

      const meta = U.el("div", "page-meta",
        U.t("创建于 ") + U.fmtDate(page.createdAt, true) + " · 更新于 " + U.fmtDate(page.updatedAt, true));
      scroll.appendChild(meta);

      // 考试模式：检测是否在「试卷」数据库下
      const isExam = this._isExamPage(page);
      const examSubmitted = !!(page.attrs && page.attrs.examResults);
      if (isExam && !examSubmitted) {
        const btn = U.el("button", "db-btn primary q-exam-submit", "📝 交卷");
        btn.addEventListener("click", () => this._submitExam(page));
        scroll.appendChild(btn);
      }
      if (examSubmitted) {
        const results = page.attrs.examResults;
        const total = Object.keys(results).length;
        const correct = Object.values(results).filter(r => r.correct).length;
        const summary = U.el("div", "q-exam-summary",
          U.t("已交卷 · 得分：") + correct + "/" + total +
          (total > 0 ? " (" + Math.round(correct / total * 100) + "%)" : ""));
        scroll.appendChild(summary);
      }

      const blocks = U.el("div", "blocks");
      blocks.dataset.pageId = page.id;
      scroll.appendChild(blocks);
      this.blocksEl = blocks;
      this.renderBlocks(page, blocks);
      this.ensureTrailingBlock(page, blocks);
      this.autoRenderMermaids(page);

      // focus title if page is empty
      if (!page.children.length && !U.segsText(page.title)) {
        setTimeout(() => { title.focus(); }, 30);
      }
      content.scrollTop = 0;
      if (global.PluginManager) PluginManager.emit("pageRendered", page);
    },

    /** 检查页面是否在「试卷」文件夹下 */
    _isExamPage(page) {
      let p = page;
      while (p) {
        if (U.segsText(p.title) === "试卷" && p.parentId === "root") return true;
        p = p.parentId ? S.getPage(p.parentId) : null;
      }
      return false;
    },

    /** 交卷：批改客观题，简答题发给 AI */
    async _submitExam(page) {
      const S = global.Store;
      const questions = (page.children || []).filter(b => b.type === "question");
      if (!questions.length) { U.toast(U.t("试卷中没有题目")); return; }
      const results = {};
      let needAI = [];
      // 收集答案
      questions.forEach(b => {
        const q = b.attrs.qid ? S.getQuestion(b.attrs.qid) : null;
        if (!q) return;
        const wrap = document.querySelector('.b-question[data-block-id="' + b.id + '"]');
        if (!wrap) return;
        let userAns = null;
        if (q.type === "judge" || q.type === "single") {
          const checked = wrap.querySelector('input[type="radio"]:checked');
          userAns = checked ? checked.value : null;
        } else if (q.type === "multiple") {
          const checked = wrap.querySelectorAll('input[type="checkbox"]:checked');
          userAns = Array.from(checked).map(c => c.value);
        } else if (q.type === "fill") {
          const inp = wrap.querySelector('input[type="text"], .q-exam-input');
          userAns = inp ? inp.value.trim() : "";
        } else {
          const ta = wrap.querySelector('textarea');
          userAns = ta ? ta.value.trim() : "";
        }
        if (userAns === null || userAns === "") {
          results[b.id] = { correct: false, userAns: "", refAnswer: "" };
          return;
        }
        // 客观题批改
        if (q.type === "judge") {
          results[b.id] = { correct: (userAns === "true") === !!q.answer, userAns };
        } else if (q.type === "single") {
          results[b.id] = { correct: String(userAns) === String(q.answer), userAns };
        } else if (q.type === "multiple") {
          const ref = Array.isArray(q.answer) ? q.answer.map(String) : [String(q.answer)];
          const ua = (Array.isArray(userAns) ? userAns : [userAns]).map(String);
          results[b.id] = { correct: ref.length === ua.length && ref.every(r => ua.includes(r)), userAns: ua };
        } else if (q.type === "fill") {
          const ref = String(q.answer || "").trim();
          results[b.id] = { correct: userAns === ref, userAns, refAnswer: ref };
        } else {
          needAI.push({ id: b.id, qid: q.id, prompt: q.prompt, answer: q.answer, userAns });
        }
      });
      // 简答题发送 AI 批改
      if (needAI.length && global.AI && typeof AI._gradeShortAnswers === "function") {
        try {
          const aiResults = await AI._gradeShortAnswers(needAI);
          Object.assign(results, aiResults);
        } catch (e) { /* AI 不可用时标记为待批改 */ }
      }
      page.attrs = page.attrs || {};
      page.attrs.examResults = results;
      page.attrs.examTime = Date.now();
      S.markDirty();
      S.save(true);
      this.renderPage(page.id);
      U.toast(U.t("交卷完成！"));
    },

    renderBlocks(page, container) {
      container = container || this.blocksEl;
      if (!container) return;
      U.clear(container);
      const numMap = {};
      const numberLists = (list) => {
        let n = 0;
        list.forEach(b => {
          if (b.type === "numbered") { n++; numMap[b.id] = n; }
          else n = 0;
          if (b.children && b.children.length) numberLists(b.children);
        });
      };
      numberLists(page.children);
      const isExam = this._isExamPage(page);
      const ctx = { page, isExam, examSubmitted: !!(page.attrs && page.attrs.examResults), examResults: (page.attrs && page.attrs.examResults) || null };
      page.children.forEach(b => container.appendChild(B.renderBlock(b, ctx)));
      // apply numbers
      container.querySelectorAll(".b-numbered").forEach(el => {
        const n = numMap[el.dataset.blockId];
        if (n != null) {
          const m = el.querySelector(".b-marker");
          if (m) m.dataset.n = n;
        }
      });
    },

    /** 保证页面末尾始终有一行可直接点进去写的空段落（若最后一块不可输入） */
    ensureTrailingBlock(page, container) {
      if (!page.children || !page.children.length) return; // 空页面保持聚焦标题
      const TEXT = new Set(["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout"]);
      const last = page.children[page.children.length - 1];
      if (last && TEXT.has(last.type)) return;
      const empty = S.newBlock("paragraph");
      page.children.push(empty);
      container.appendChild(B.renderBlock(empty, { page }));
      S.touch(page); S.markDirty();
    },

    refresh(focusInfo) {
      const page = this.page;
      if (!page) return;
      if (page.database && Database) { Database.render(page); return; }
      const blocks = this.blocksEl;
      const content = U.renderRoot();
      const prevScroll = content ? content.scrollTop : 0;
      if (blocks && content.contains(blocks)) {
        this.renderBlocks(page, blocks);
        if (content) content.scrollTop = prevScroll;
        if (focusInfo) this.focusBlock(focusInfo.id, focusInfo.offset);
      } else {
        this.renderPage(page.id);
        if (focusInfo) this.focusBlock(focusInfo.id, focusInfo.offset);
      }
    },

    /* ================= Focus ================= */
    focusBlock(blockId, offset) {
      const el = this.blocksEl ? this.blocksEl.querySelector('.ed[data-block-id="' + blockId + '"]') : null;
      if (!el) return;
      el.focus();
      if (offset != null) B.setCaret(el, offset);
      else B.setCaret(el, 0);
      const blk = el.closest(".block");
      if (blk && scroll) blk.scrollIntoView({ block: "nearest" });
    },

    selectBlock(el, scroll) {
      if (!this.blocksEl) return;
      this.blocksEl.querySelectorAll(".block.selected").forEach(b => b.classList.remove("selected"));
      el.classList.add("selected");
      this._anchorBlockId = el.dataset.blockId;
      this.removeMultiToolbar();
      if (scroll) el.scrollIntoView({ block: "nearest" });
    },

    /* ================= 多选（框选 / Shift+点击） ================= */
    selectedBlocks() {
      return this.blocksEl ? Array.from(this.blocksEl.querySelectorAll(".block.selected")) : [];
    },

    clearSelection() {
      if (this.blocksEl) this.blocksEl.querySelectorAll(".block.selected").forEach(b => b.classList.remove("selected"));
      this.removeMultiToolbar();
    },

    selectRange(fromId, toId) {
      if (!this.blocksEl) return;
      const blocks = Array.from(this.blocksEl.querySelectorAll(".block"));
      const i1 = blocks.findIndex(b => b.dataset.blockId === fromId);
      const i2 = blocks.findIndex(b => b.dataset.blockId === toId);
      if (i1 < 0 || i2 < 0) return;
      this.clearSelection();
      for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) blocks[i].classList.add("selected");
      this.renderMultiToolbar();
    },

    startMarquee(e) {
      const page = this.page;
      if (!page || page.database) return;
      this._marquee = { startX: e.clientX, startY: e.clientY, active: false, box: null };
      this._mm = (ev) => this.onMarqueeMove(ev);
      this._mu = (ev) => this.onMarqueeUp(ev);
      document.addEventListener("mousemove", this._mm);
      document.addEventListener("mouseup", this._mu);
      e.preventDefault();
    },

    onMarqueeMove(e) {
      const m = this._marquee;
      if (!m) return;
      const dx = e.clientX - m.startX, dy = e.clientY - m.startY;
      if (!m.active) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        m.active = true;
      }
      const x1 = Math.min(m.startX, e.clientX), y1 = Math.min(m.startY, e.clientY);
      const x2 = Math.max(m.startX, e.clientX), y2 = Math.max(m.startY, e.clientY);
      if (!m.box) { m.box = U.el("div", "marquee"); document.body.appendChild(m.box); }
      m.box.style.left = x1 + "px";
      m.box.style.top = y1 + "px";
      m.box.style.width = (x2 - x1) + "px";
      m.box.style.height = (y2 - y1) + "px";
      this.marqueeSelect(x1, y1, x2, y2);
    },

    marqueeSelect(x1, y1, x2, y2) {
      if (!this.blocksEl) return;
      Array.from(this.blocksEl.querySelectorAll(".block")).forEach(b => {
        const r = b.getBoundingClientRect();
        b.classList.toggle("selected", r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2);
      });
      this.removeMultiToolbar();
    },

    onMarqueeUp() {
      const m = this._marquee;
      if (m) {
        document.removeEventListener("mousemove", this._mm);
        document.removeEventListener("mouseup", this._mu);
        if (m.box) m.box.remove();
        if (!m.active) this.clearSelection(); // 单击空白：取消选择
        this._marquee = null;
      }
      const sel = this.selectedBlocks();
      if (sel.length) {
        this._anchorBlockId = sel[0].dataset.blockId;
        const ae = document.activeElement;
        if (ae && (ae.isContentEditable || ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) ae.blur();
      }
      this.renderMultiToolbar();
    },

    renderMultiToolbar() {
      this.removeMultiToolbar();
      const sel = this.selectedBlocks();
      if (sel.length < 2) return;
      const bar = U.el("div", "multi-toolbar");
      const btn = (label, title, fn) => {
        const b = U.el("button", "mt-btn", label);
        b.title = title;
        b.addEventListener("click", fn);
        bar.appendChild(b);
      };
      btn("🗑", "删除所选块", () => this.deleteSelected());
      btn("⧉", "复制所选块", () => this.duplicateSelected());
      btn("✨", "AI 改写所选块", () => this.aiRewriteSelected());
      bar.appendChild(U.el("span", "mt-count", sel.length + " 个块"));
      document.body.appendChild(bar);
      const r = sel[0].getBoundingClientRect();
      bar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
      bar.style.top = Math.max(8, r.top - 46) + "px";
      this._multiBar = bar;
    },

    removeMultiToolbar() {
      if (this._multiBar) { this._multiBar.remove(); this._multiBar = null; }
    },

    deleteSelected() {
      const page = this.page;
      if (!page) return;
      const ids = this.selectedBlocks().map(b => b.dataset.blockId);
      if (!ids.length) return;
      ids.forEach(id => S.removeBlock(page, id));
      S.touch(page); S.markDirty();
      this.clearSelection();
      this.refresh();
    },

    duplicateSelected() {
      const page = this.page;
      if (!page) return;
      const ids = this.selectedBlocks().map(b => b.dataset.blockId);
      ids.slice().reverse().forEach(id => {
        const blk = S.findBlock(page, id);
        const pos = S.findBlockPos(page, id);
        if (!blk || !pos) return;
        const remap = (b) => { b.id = U.uid("blk"); (b.children || []).forEach(remap); };
        const copy = U.clone(blk);
        remap(copy);
        pos.list.splice(pos.index + 1, 0, copy);
      });
      S.touch(page); S.markDirty();
      this.clearSelection();
      this.refresh();
    },

    /** 把所选多个块交给 AI 统一改写 */
    async aiRewriteSelected() {
      const page = this.page;
      if (!page) return;
      const ids = this.selectedBlocks().map(b => b.dataset.blockId);
      if (!ids.length) return;
      const blks = ids.map(id => S.findBlock(page, id)).filter(Boolean);
      const texts = blks.map(b => this.blockText(b)).filter(t => t.trim());
      if (!texts.length) { U.toast(U.t("所选块没有可处理的文字")); return; }
      if (!global.AI) { U.toast("AI 模块未就绪"); return; }

      const req = await U.promptModal({ title: U.t("改写所选块"), placeholder: "例如：更正式、更简洁、面向初学者、统一语气…（可留空）", value: "" });
      if (req == null) return; // 取消
      const requirement = req.trim();

      const styleHint = "每段独立成块（用空行分隔）；可适当使用 Markdown 标记（**加粗**、*斜体*、`代码`、~~删除线~~）和行内 LaTeX 公式（$...$）突出重点；不要输出标题、列表符号或任何解释文字。";
      const prompt = "请改写下面这段内容（" + blks.length + " 段）" + (requirement ? "，要求：" + requirement : "") + "：统一语气和风格，换一种更符合要求的表达，保持原意不变。" + styleHint + "\n\n原文：\n" + texts.join("\n\n");
      AI.toggle(true);
      await AI.proposeDraft("改写所选块", prompt, (result) => {
        const count = this.replaceSelectedBlocks(blks, result);
        S.touch(page); S.markDirty();
        this.clearSelection();
        this.refresh();
        U.toast(count > 1 ? (U.t("已改写为 ") + count + " 个块") : "已改写");
      });
    },

    /** 用 AI 返回的 Markdown 替换所选多个块（删除原块，在首个块位置插入新块） */
    replaceSelectedBlocks(blks, md) {
      const page = this.page;
      if (!blks.length) return 0;
      const firstPos = S.findBlockPos(page, blks[0].id);
      if (!firstPos) return 0;
      const list = firstPos.list, index = firstPos.index;
      blks.forEach(b => S.removeBlock(page, b.id));
      const blocks = (global.AI && AI.markdownToBlocks ? AI.markdownToBlocks(md) : null) || [];
      const newBlocks = blocks.map(b => {
        const nb = S.newBlock(b.type);
        if (b.type !== "divider" && b.segments && b.segments.length) nb.text = b.segments;
        return nb;
      });
      if (!newBlocks.length) newBlocks.push(S.newBlock("paragraph", md));
      list.splice(index, 0, ...newBlocks);
      return newBlocks.length;
    },

    clearTextSelection() {
      const clear = () => {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount) sel.removeAllRanges();
      };
      clear();
      this.hideToolbar(true);
      queueMicrotask(clear);
    },

    onPointerDown(e) {
      const toolbar = document.querySelector("#inline-tb");
      if (toolbar && toolbar.contains(e.target)) {
        e.preventDefault();
        return;
      }
      // 颜色色块点击：保留文本选区（供 applyInlineColor 读取）
      if (e.target && e.target.closest && e.target.closest(".swatch")) {
        e.preventDefault();
        return;
      }
      // PDF 查看器内保留文本选择（供荧光笔按钮读取选区）
      if (e.target && e.target.closest && e.target.closest(".pdf-page")) return;
      this.clearTextSelection();
    },

    onGlobalKeydown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.clearTextSelection();
        this.clearSelection();
        return;
      }
      const t = e.target;
      const editable = t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT");
      if (editable) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.selectedBlocks().length >= 1) {
          e.preventDefault();
          this.deleteSelected();
        }
      }
    },

    focusTitle() {
      const t = document.querySelector('[data-role="page-title"]');
      if (t) t.focus();
    },

    /* ================= Event wiring ================= */
    init() {
      const content = document.getElementById("content");
      content.addEventListener("input", (e) => this.onInput(e));
      content.addEventListener("keydown", (e) => this.onKeydown(e));
      content.addEventListener("click", (e) => this.onClick(e));
      content.addEventListener("focusout", (e) => this.onFocusOut(e));
      content.addEventListener("focusin", (e) => this.onFocusIn(e));
      content.addEventListener("mousedown", (e) => this.onMouseDown(e));
      document.addEventListener("pointerdown", (e) => this.onPointerDown(e), true);
      content.addEventListener("dragstart", (e) => this.onDragStart(e));
      content.addEventListener("paste", (e) => this.onPaste(e));
      content.addEventListener("dragover", (e) => this.onDragOver(e));
      content.addEventListener("dragleave", (e) => this.onDragLeave(e));
      content.addEventListener("drop", (e) => this.onDrop(e));
      content.addEventListener("dragend", () => this.onDragEnd());
      // 复用同一个节流实例：原写法在每次事件里新建闭包，导致节流完全失效、onSelectionChange 每次都被同步调用。
      const throttledSelectionChange = U.throttle(() => this.onSelectionChange(), 120);
      document.addEventListener("selectionchange", throttledSelectionChange);
      document.addEventListener("keydown", (e) => this.onGlobalKeydown(e));

      // 共享的块级 AI 浮动按钮（固定定位，避免块外侧空隙导致失焦）
      const aiBtn = U.el("button", "block-ai-btn", "✦");
      aiBtn.title = "AI 助手：讲解 / 扩写 / 缩写 / 重写";
      aiBtn.style.display = "none";
      document.body.appendChild(aiBtn);
      aiBtn.addEventListener("mousedown", (e) => e.preventDefault()); // 保持块焦点不丢失
      aiBtn.addEventListener("click", () => {
        const blk = this._aiBlockId && this.page ? S.findBlock(this.page, this._aiBlockId) : null;
        if (blk) {
          const r = aiBtn.getBoundingClientRect();
          this.openBlockAI(blk, r.right, r.bottom);
        }
      });
      this._aiBtn = aiBtn;
    },

    /* ================= Input ================= */
    onInput(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;
      const composing = !!e.isComposing;

      // page title
      if (t.dataset && t.dataset.role === "page-title") {
        page.title = B.htmlToSegments(t);
        S.touch(page); S.markDirty();
        return;
      }

      // code / equation textarea
      if (t.tagName === "TEXTAREA") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          if (blk.type === "equation") {
            blk.text = t.value.trim() ? [{ t: t.value }] : [];
            // floating live preview under the caret while typing
            this.showEquationPreview(t);
          } else {
            blk.attrs.source = t.value;
          }
          S.touch(page); S.markDirty();
          // Mermaid：输入停止后自动渲染（防抖，无需手动点「渲染」）
          if (blk.type === "mermaid") {
            if (this._mmRenderTimer) clearTimeout(this._mmRenderTimer);
            this._mmRenderTimer = setTimeout(() => this.renderMermaid(blk), 800);
          }
        }
        return;
      }

      // block editable
      const blockEl = t.closest(".block");
      if (!blockEl) return;
      const blk = S.findBlock(page, blockEl.dataset.blockId);
      if (!blk) return;

      // 公式块源码编辑：直接保存 $$...$$ 原文，不做富文本/行内公式转换
      if (blk.type === "equation" && t.classList && t.classList.contains("eq-source")) {
        blk.text = t.textContent.trim() ? [{ t: t.textContent }] : [];
        S.touch(page); S.markDirty();
        this.showEquationPreview(t);
        return;
      }

      const segs = B.htmlToSegments(t);
      if (t.classList && t.classList.contains("cap")) {
        blk.attrs.caption = segs;
      } else if (blk.type === "table") {
        const row = parseInt(t.dataset.row, 10), col = parseInt(t.dataset.col, 10);
        if (!isNaN(row) && !isNaN(col)) {
          if (!blk.attrs.rows) blk.attrs.rows = [];
          if (!blk.attrs.rows[row]) blk.attrs.rows[row] = [];
          blk.attrs.rows[row][col] = segs;
        }
      } else {
        blk.text = segs;
      }
      S.touch(page); S.markDirty();

      if (composing) return; // 输入法组合中：仅同步数据，不触发快捷转换

      // inline math: $...$ → rendered span (any text block)
      const text = B.edText(t);
      const textTypes = ["paragraph", "bullet", "numbered", "todo", "quote", "callout", "toggle", "heading1", "heading2", "heading3"];
      if (textTypes.includes(blk.type) && text.length) {
        const editingMath = this._mathEditing && this._mathEditing.blockId === blk.id;
        if (editingMath) return; // 正在编辑公式源码，不做自动转换
        // display math: $$...$$ 后还有内容 → 自动拆成公式行 + 下一行
        if (blk.type === "paragraph" && text.length > 4) {
          const dm = text.match(/^\$\$([^$\n]+?)\$\$([\s\S]*)$/);
          if (dm && dm[1].trim() && dm[2].trim()) { this.splitDisplayMath(blk, dm[1].trim(), dm[2]); return; }
        }
        const lastChar = text[text.length - 1];
        if (lastChar === "@" && !this._mentionOpen) {
          this._mentionOpen = true;
          this.openMentionPicker(blk, blockEl);
          return;
        }
        if (lastChar === "$" && this.tryInlineMath(blk, blockEl, t, text)) {
          return;
        }
        // slash menu works in every text block (lists, quotes, callouts, headings…)
        if (lastChar === "/" && text === "/") {
          this.openSlash(blk, blockEl, t, "");
          return;
        }
        if (text.startsWith("/") && !text.includes(" ")) {
          this.openSlash(blk, blockEl, t, text.slice(1));
          return;
        }
      }
      // markdown shortcuts (paragraph only)
      if (blk.type === "paragraph" && text.length) {
        const lastChar = text[text.length - 1];
        if (lastChar === " " && text.length > 1) {
          this.tryMarkdown(blk, blockEl, t, text);
        }
      }
    },

    /** convert $...$ in the editable to an inline math span; returns true when converted */
    tryInlineMath(blk, blockEl, ed, text) {
      // 只转换「紧邻光标刚闭合」的那一对 $...$，避免误伤块内更早的公式
      let m = null;
      const re = /\$([^$\n]+?)\$(?!\$)/g;
      let hit;
      while ((hit = re.exec(text))) {
        if (hit.index + hit[0].length === text.length) { m = hit; break; }
      }
      if (!m) return false;
      if (/^\s|\s$/.test(m[1])) return false;
      const full = m[0];
      const start = m.index;
      const end = start + full.length;
      if (start > 0 && text[start - 1] === "$") return false;
      const range = B.textRange(ed, start, end);
      if (!range) return false;
      const latex = m[1].trim();
      const span = U.el("span", "nt-math");
      span.contentEditable = "false";
      span.dataset.math = latex;
      span.dataset.src = full;
      span.title = "点击编辑公式";
      span.innerHTML = MathR.renderInline(latex) || U.esc(latex);
      range.deleteContents();
      range.insertNode(span);
      const sel = window.getSelection();
      const r2 = document.createRange();
      r2.setStartAfter(span);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
      const page = this.page;
      blk.text = B.htmlToSegments(ed);
      S.touch(page); S.markDirty();
      return true;
    },

    /** insert a $ at the caret (slash menu item) so the user can type inline math */
    insertInlineMathAtCaret(blk) {
      const page = this.page;
      const ed = this.blocksEl.querySelector('.ed[data-block-id="' + blk.id + '"]');
      if (!ed) return;
      const q = this._slashQuery || "";
      const curText = B.edText(ed);
      if (curText.startsWith("/" + q)) {
        const stripRange = B.textRange(ed, 0, 1 + q.length);
        if (stripRange) stripRange.deleteContents();
      }
      this._slashQuery = "";
      const sel = window.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0) : document.createRange();
      range.deleteContents();
      const dollar = document.createTextNode("$");
      range.insertNode(dollar);
      const r2 = document.createRange();
      r2.setStartAfter(dollar);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
      blk.text = B.htmlToSegments(ed);
      S.touch(page); S.markDirty();
    },

    /* ---------- inline math: in-place source editing (Obsidian-style) ---------- */
    openMathSource(span, blk) {
      const page = this.page;
      if (!span || !span.parentNode) return;
      const ed = span.closest(".ed");
      const src = span.dataset.src || ("$" + (span.dataset.math || "") + "$");
      const textNode = document.createTextNode(src);
      span.parentNode.replaceChild(textNode, span);
      this._mathEditing = { blockId: blk.id };
      if (ed) ed.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      const innerStart = 1, innerEnd = Math.max(1, src.length - 1);
      range.setStart(textNode, innerStart);
      range.setEnd(textNode, innerEnd);
      sel.removeAllRanges();
      sel.addRange(range);
      if (ed && blk) { blk.text = B.htmlToSegments(ed); S.touch(page); S.markDirty(); }
    },

    commitMathSource(moveCaretEnd) {
      const m = this._mathEditing;
      if (!m) return;
      this._mathEditing = null;
      const blk = this.page ? S.findBlock(this.page, m.blockId) : null;
      if (!blk) return;
      const ed = this.blocksEl ? this.blocksEl.querySelector('.ed[data-block-id="' + blk.id + '"]') : null;
      if (ed) {
        ed.innerHTML = B.segsToHTML(blk.text);
        if (moveCaretEnd) { ed.focus(); B.setCaret(ed, B.editableTextLength(ed)); }
      }
    },

    eqLatex(raw) {
      return String(raw == null ? "" : raw).trim().replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
    },

    convertToEquation(blk, latex) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;
      const nb = S.newBlock("equation");
      nb.text = [{ t: "$$" + latex + "$$" }];
      pos.list.splice(pos.index, 1, nb);
      // 确保公式块下方有可继续输入的内容块
      if (!pos.list[pos.index + 1]) {
        pos.list.splice(pos.index + 1, 0, S.newBlock("paragraph"));
      }
      S.touch(page); S.markDirty();
      this.refresh();
      const next = pos.list[pos.index + 1];
      if (next) this.focusBlock(next.id, 0);
    },

    splitDisplayMath(blk, latex, rest) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;
      const eq = S.newBlock("equation");
      eq.text = [{ t: "$$" + latex + "$$" }];
      pos.list.splice(pos.index, 1, eq);
      let np = null;
      if (rest && rest.trim()) {
        np = S.newBlock("paragraph", rest);
        pos.list.splice(pos.index + 1, 0, np);
      }
      S.touch(page); S.markDirty();
      this.refresh();
      if (np) this.focusBlock(np.id, U.segsText(np.text).length);
    },

    /** 公式源码中回车：提交公式并在下方新建段落 */
    equationEnter(blk, ed) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;
      blk.text = ed.textContent.trim() ? [{ t: ed.textContent }] : [];
      const nb = S.newBlock("paragraph");
      pos.list.splice(pos.index + 1, 0, nb);
      S.touch(page); S.markDirty();
      this.refresh();
      this.focusBlock(nb.id, 0);
    },

    hideMathPreview() {
      const pop = document.querySelector("#math-preview");
      if (pop) pop.remove();
    },

    /** caret coordinates inside a textarea (for the floating preview) */
    caretRectInTextarea(ta) {
      const cs = window.getComputedStyle(ta);
      const mirror = U.el("div", "ta-mirror");
      mirror.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre-wrap;word-break:break-word;" +
        "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";line-height:" + cs.lineHeight + ";" +
        "width:" + ta.clientWidth + "px;padding:" + cs.padding + ";letter-spacing:" + cs.letterSpacing + ";" +
        "border:" + cs.borderWidth + " solid transparent;";
      mirror.textContent = ta.value.slice(0, ta.selectionStart);
      const marker = U.el("span", "ta-mirror-marker", "M");
      mirror.appendChild(marker);
      document.body.appendChild(mirror);
      const rect = marker.getBoundingClientRect();
      mirror.remove();
      return rect;
    },

    /** caret coordinates inside a contenteditable (for the floating preview) */
    caretRectInEditable() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).cloneRange();
        r.collapse(true);
        const rect = r.getBoundingClientRect();
        if (rect && (rect.left || rect.top || rect.right || rect.bottom)) return rect;
      }
      return { left: 8, top: 8, right: 8, bottom: 8 };
    },

    /* ================= Markdown shortcuts ================= */
    tryMarkdown(blk, blockEl, ed, text) {
      const rules = [
        { re: /^### $/, type: "heading3" },
        { re: /^## $/, type: "heading2" },
        { re: /^# $/, type: "heading1" },
        { re: /^-{3,} $/, type: "divider" },
        { re: /^- $/, type: "bullet" },
        { re: /^\d+\. $/, type: "numbered" },
        { re: /^\[x\] $/i, type: "todo", checked: true },
        { re: /^\[\] $/, type: "todo", checked: false },
        { re: /^> $/, type: "quote" },
        { re: /^``` $/, type: "code" },
        { re: /^\$\$ $/, type: "equation" },
      ];
      for (const r of rules) {
        if (r.re.test(text)) {
          const page = this.page;
          const pos = S.findBlockPos(page, blk.id);
          const newBlk = S.newBlock(r.type);
          if (r.checked != null) newBlk.checked = r.checked;
          if (r.type === "code") newBlk.attrs.source = "";
          pos.list.splice(pos.index, 1, newBlk);
          S.touch(page); S.markDirty();
          this.refresh({ id: newBlk.id, offset: 0 });
          return;
        }
      }
    },

    /* ================= Slash menu ================= */
    openSlash(blk, blockEl, ed, query) {
      this._slashQuery = query;
      U.closePopovers();
      const pop = U.el("div", "popover");
      const search = U.el("input", "menu-search");
      search.placeholder = "过滤类型…";
      search.value = query;
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(search);
      pop.appendChild(scroll);

      let filtered = [];
      const renderList = () => {
        const q = search.value.toLowerCase();
        filtered = [];
        B.SLASH_ITEMS.forEach(grp => {
          const hits = grp.items.filter(it => !q || ((U.t(it.label) + U.t(it.desc))).toLowerCase().includes(q));
          if (hits.length) filtered.push({ group: U.t(grp.group), items: hits });
        });
        U.clear(scroll);
        let idx = 0;
        filtered.forEach(grp => {
          const head = U.el("div", "menu-head", grp.group);
          scroll.appendChild(head);
          grp.items.forEach(it => {
            it._idx = idx++;
            const item = U.el("div", "menu-item");
            item.dataset.idx = it._idx;
            const ico = U.el("span", "mi-ico", it.icon);
            const lab = U.el("span", "mi-label", U.t(it.label));
            const desc = U.el("span", "mi-desc", U.t(it.desc));
            item.appendChild(ico); item.appendChild(lab); item.appendChild(desc);
            item.addEventListener("click", () => select(it));
            scroll.appendChild(item);
          });
        });
        const first = scroll.querySelector(".menu-item");
        if (first) first.classList.add("sel");
      };

      const select = (it) => {
        teardown();
        const page = this.page;
        const rest = search.value ? search.value.replace(/^\//, "") : "";
        const pos = S.findBlockPos(page, blk.id);
        const isSlashOnly = U.segsText(blk.text).replace(/\//g, "").trim() === "";
        if (it.type === "inline-math") {
          pop.remove();
          this.insertInlineMathAtCaret(blk);
          return;
        }
        if (it.type === "page") {
          const sub = S.createPage(page.id, { icon: "📄" });
          const nb = S.newBlock("page"); nb.attrs.pageId = sub.id;
          pos.list.splice(pos.index, 1, nb);
          S.touch(page); S.markDirty();
          pop.remove();
          if (global.App) App.openPage(sub.id);
          return;
        }
        if (it.type === "database") {
          const db = S.createPage(page.id, { icon: "🗄", database: true });
          const nb = S.newBlock("database"); nb.attrs.pageId = db.id;
          pos.list.splice(pos.index, 1, nb);
          S.touch(page); S.markDirty();
          pop.remove();
          if (global.App) App.openPage(db.id);
          return;
        }
        if (it.type === "codefile") {
          const code = S.createPage(page.id, { icon: "⌨", code: true, language: "python" });
          const nb = S.newBlock("page"); nb.attrs.pageId = code.id;
          pos.list.splice(pos.index, 1, nb);
          S.touch(page); S.markDirty();
          pop.remove();
          if (global.App) App.openPage(code.id);
          return;
        }
        if (it.type === "link") {
          pop.remove();
          this.openPagePicker((sel) => {
            if (!sel) return;
            const nb = S.newBlock("page"); nb.attrs.pageId = sel.id;
            pos.list.splice(pos.index, 1, nb);
            S.touch(page); S.markDirty();
            this.refresh({ id: nb.id, offset: 0 });
          });
          return;
        }
        if (it.type === "columns") {
          pop.remove();
          const nb = this.createColumnsBlock(2);
          pos.list.splice(pos.index, 1, nb);
          S.touch(page); S.markDirty();
          this.refresh({ id: nb.id, offset: 0 });
          return;
        }
        const nb = S.newBlock(it.type, isSlashOnly ? [] : [{ t: rest }]);
        if (it.type === "todo") nb.checked = false;
        if (it.type === "code") nb.attrs.source = "";
        if (it.type === "snippet") { nb.attrs.source = ""; nb.attrs.language = "text"; }
        if (it.type === "mermaid") nb.attrs.source = "";
        if (it.type === "html") nb.attrs.source = "";
        if (it.type === "table") { nb.attrs.cols = 3; nb.attrs.header = true; nb.attrs.rows = [[], [], []].map(() => [{ t: "" }, { t: "" }, { t: "" }]); }
        if (it.type === "callout") nb.attrs.icon = "💡";
        if (it.type === "image") { nb.attrs.src = ""; }
        pos.list.splice(pos.index, 1, nb);
        if (it.type === "question") S.createQuestion(page.id, nb.id, { type: "single" });
        if (it.type === "flashcard") S.createFlashcard(page.id, nb.id, {});
        S.touch(page); S.markDirty();
        pop.remove();
        this.refresh({ id: nb.id, offset: 0 });
      };

      let closed = false;
      const onOut = (ev) => { if (!pop.contains(ev.target)) closeSlash(true); };
      const teardown = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener("mousedown", onOut);
        pop.remove();
      };
      const closeSlash = (cancel) => {
        teardown();
        if (cancel) {
          const q = (search.value || "").replace(/^\//, "") || "";
          blk.text = [{ t: "/" + q }];
          S.touch(page); S.markDirty();
          const edEl = blockEl.querySelector('.ed[data-block-id="' + blk.id + '"]');
          if (edEl) {
            edEl.focus();
            B.setCaret(edEl, 1 + q.length);
          }
        }
      };
      document.addEventListener("mousedown", onOut);

      renderList();
      search.addEventListener("input", renderList);
      search.addEventListener("keydown", (e) => {
        const items = scroll.querySelectorAll(".menu-item");
        const cur = scroll.querySelector(".menu-item.sel");
        let ci = cur ? parseInt(cur.dataset.idx, 10) : 0;
        if (e.key === "ArrowDown") {
          e.preventDefault(); e.stopPropagation();
          items.forEach(i => i.classList.remove("sel"));
          const next = items[ci + 1] || items[0];
          next.classList.add("sel"); next.scrollIntoView({ block: "nearest" });
        } else if (e.key === "ArrowUp") {
          e.preventDefault(); e.stopPropagation();
          items.forEach(i => i.classList.remove("sel"));
          const prev = items[ci - 1] || items[items.length - 1];
          prev.classList.add("sel"); prev.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          const selItem = scroll.querySelector(".menu-item.sel");
          const flat = filtered.flatMap(g => g.items);
          const chosen = flat.find(i => i._idx === (selItem ? parseInt(selItem.dataset.idx, 10) : 0));
          if (chosen) select(chosen);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeSlash(true);
        }
      });

      const rect = ed.getBoundingClientRect();
      U.placePop(pop, rect, {});
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    },

    /* ================= Page picker ================= */
    openPagePicker(cb, onClose, filterFn) {
      const pages = S.allPages().filter(p => !p.deleted && p.id !== (this.page && this.page.id) && (!filterFn || filterFn(p)));
      const modal = U.modal({ title: filterFn ? "选择代码文件" : "链接到页面", size: "sm", onClose });
      const search = U.el("input", "modal-input");
      search.placeholder = "搜索页面…";
      search.style.marginBottom = "10px";
      modal.body.appendChild(search);
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const render = () => {
        const q = search.value.toLowerCase();
        U.clear(list);
        pages.filter(p => !q || U.segsText(p.title).toLowerCase().includes(q)).slice(0, 30).forEach(p => {
          const row = U.el("div", "search-result");
          row.innerHTML = '<span class="sr-ico">' + U.esc(p.icon || (p.database ? "🗄" : "📄")) + '</span><span class="sr-title">' +
            U.esc(U.segsText(p.title) || "未命名") + '</span>';
          row.addEventListener("click", () => { modal.close(); cb(p); });
          list.appendChild(row);
        });
      };
      render();
      search.addEventListener("input", render);
      search.focus();
    },

    linkSnippet(blk) {
      const page = this.page;
      this.openPagePicker((sel) => {
        blk.attrs.pageId = sel.id;
        S.touch(page); S.markDirty();
        this.refresh({ id: blk.id });
      }, null, (p) => !!p.code);
    },

    parseQuestionForm(type, optionsText, answerText) {
      const options = String(optionsText || "").split("\n").map(s => s.trim()).filter(Boolean);
      let answer = null;
      if (type === "judge") {
        answer = String(answerText || "").trim() === "对";
      } else if (type === "single") {
        const n = parseInt(String(answerText || "").trim(), 10);
        answer = isNaN(n) ? null : Math.max(0, n - 1);
      } else if (type === "multiple") {
        answer = String(answerText || "").split(/[,，\s]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n)).map(n => Math.max(0, n - 1));
      } else {
        const parts = String(answerText || "").split("|").map(s => s.trim()).filter(Boolean);
        answer = parts.length > 1 ? parts : (parts[0] || "");
      }
      return { options, answer };
    },

    editQuestion(blk) {
      const q = blk.attrs.qid ? S.getQuestion(blk.attrs.qid) : null;
      if (!q) return;
      const modal = U.modal({ title: "编辑题目", onClose: () => this.refresh() });
      const typeSel = U.el("select", "modal-input");
      [["single", "单选"], ["multiple", "多选"], ["judge", "判断"], ["fill", "填空"], ["short_answer", "简答"]].forEach(([v, l]) => {
        const o = U.el("option", null, l); o.value = v; if (q.type === v) o.selected = true; typeSel.appendChild(o);
      });
      const prompt = U.el("input", "modal-input");
      prompt.placeholder = "题干";
      prompt.value = q.prompt;
      const dynamic = U.el("div", "q-form-dynamic");
      const optionsText = (q.options || []).join("\n");
      const answerText = (() => {
        if (q.type === "judge") return q.answer === true ? "对" : "错";
        if (q.type === "single") return q.answer == null ? "" : String(q.answer + 1);
        if (q.type === "multiple") return Array.isArray(q.answer) ? q.answer.map(i => i + 1).join(",") : "";
        return Array.isArray(q.answer) ? q.answer.join(" | ") : (q.answer || "");
      })();
      const renderDynamic = () => {
        U.clear(dynamic);
        const t = typeSel.value;
        if (t === "single" || t === "multiple") {
          dynamic.appendChild(U.el("div", "q-form-label", U.t("选项（每行一个）")));
          const opts = U.el("textarea", "modal-input q-options-input");
          opts.value = optionsText; opts.dataset.role = "options";
          dynamic.appendChild(opts);
          dynamic.appendChild(U.el("div", "q-form-label", t === "single" ? U.t("正确答案序号（从 1 开始）") : U.t("正确答案序号（逗号分隔，如 1,3）")));
          const ans = U.el("input", "modal-input");
          ans.value = answerText; ans.dataset.role = "answer";
          dynamic.appendChild(ans);
        } else if (t === "judge") {
          dynamic.appendChild(U.el("div", "q-form-label", U.t("答案")));
          const sel = U.el("select", "modal-input");
          [["对", "对"], ["错", "错"]].forEach(([v, l]) => { const o = U.el("option", null, l); o.value = v; if (answerText === v) o.selected = true; sel.appendChild(o); });
          sel.dataset.role = "answer";
          dynamic.appendChild(sel);
        } else if (t === "fill") {
          dynamic.appendChild(U.el("div", "q-form-label", U.t("答案（多个可接受答案用 | 分隔）")));
          const ans = U.el("input", "modal-input");
          ans.value = answerText; ans.dataset.role = "answer";
          dynamic.appendChild(ans);
        } else {
          dynamic.appendChild(U.el("div", "q-form-label", U.t("参考答案")));
          const ans = U.el("textarea", "modal-input");
          ans.value = answerText; ans.dataset.role = "answer";
          dynamic.appendChild(ans);
        }
      };
      typeSel.addEventListener("change", renderDynamic);
      modal.body.appendChild(typeSel);
      modal.body.appendChild(prompt);
      modal.body.appendChild(dynamic);
      const save = U.el("button", "db-btn primary", "保存");
      save.addEventListener("click", () => {
        const optionsEl = dynamic.querySelector('[data-role="options"]');
        const answerEl = dynamic.querySelector('[data-role="answer"]');
        const parsed = this.parseQuestionForm(typeSel.value, optionsEl ? optionsEl.value : "", answerEl ? answerEl.value : "");
        S.updateQuestion(q.id, { type: typeSel.value, prompt: prompt.value.trim(), options: parsed.options, answer: parsed.answer });
        modal.close();
        this.refresh();
      });
      modal.foot.appendChild(save);
      renderDynamic();
    },

    editFlashcard(blk) {
      const f = blk.attrs.fid ? S.getFlashcard(blk.attrs.fid) : null;
      if (!f) return;
      const modal = U.modal({ title: "编辑闪卡", onClose: () => this.refresh() });
      const front = U.el("input", "modal-input"); front.placeholder = "正面"; front.value = f.front;
      const back = U.el("textarea", "modal-input"); back.placeholder = "背面"; back.value = f.back;
      modal.body.appendChild(U.el("div", "q-form-label", U.t("正面")));
      modal.body.appendChild(front);
      modal.body.appendChild(U.el("div", "q-form-label", U.t("背面")));
      modal.body.appendChild(back);
      const save = U.el("button", "db-btn primary", "保存");
      save.addEventListener("click", () => {
        S.updateFlashcard(f.id, { front: front.value.trim(), back: back.value.trim() });
        modal.close();
        this.refresh();
      });
      modal.foot.appendChild(save);
    },

    /* ---------- @ mention ---------- */
    openMentionPicker(blk, blockEl) {
      this.openPagePicker((target) => {
        this.insertMention(blk, target);
        this._mentionOpen = false;
      }, () => { this._mentionOpen = false; });
    },

    insertMention(blk, target) {
      const page = this.page;
      const ed = this.blocksEl ? this.blocksEl.querySelector('.ed[data-block-id="' + blk.id + '"]') : null;
      if (!ed) return;
      const text = B.edText(ed);
      const idx = text.lastIndexOf("@");
      const range = idx >= 0 ? B.textRange(ed, idx, idx + 1) : null;
      if (range) range.deleteContents();
      const chip = U.el("span", "nt-mention");
      chip.contentEditable = "false";
      chip.dataset.page = target.id;
      chip.innerHTML = U.esc((target.icon || "📄") + " " + (U.segsText(target.title) || "未命名"));
      const sel = window.getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0) : document.createRange();
      r.insertNode(chip);
      const r2 = document.createRange();
      r2.setStartAfter(chip);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
      blk.text = B.htmlToSegments(ed);
      S.touch(page); S.markDirty();
    },

    onFocusIn(e) {
      // 显示并定位块级 AI 按钮
      const t = e.target;
      const blockEl = t.closest ? t.closest(".block") : null;
      if (blockEl && this.page) {
        this._aiBlockId = blockEl.dataset.blockId;
        this.positionAIButton(blockEl);
      }
    },

    positionAIButton(blockEl) {
      const btn = this._aiBtn;
      if (!btn || !blockEl) return;
      const r = blockEl.getBoundingClientRect();
      btn.style.display = "flex";
      btn.style.left = Math.min(r.right + 12, window.innerWidth - 44) + "px";
      btn.style.top = Math.max(10, r.top + r.height / 2) + "px";
    },

    hideAIButton() {
      if (this._aiBtn) this._aiBtn.style.display = "none";
      this._aiBlockId = null;
    },

    onFocusOut(e) {
      const t = e.target;
      if (!t) return;
      // 行内公式源码编辑结束（焦点离开所在块）
      if (this._mathEditing) {
        const blkEl = t.closest ? t.closest(".block") : null;
        if (blkEl && this._mathEditing.blockId === blkEl.dataset.blockId) {
          const related = e.relatedTarget;
          if (!(related && blkEl.contains(related))) this.commitMathSource(false);
        }
      }
      if (t.classList && t.classList.contains("eq-source")) {
        this.hideMathPreview();
        const wrap = t.closest(".b-equation");
        const blk = this.page ? S.findBlock(this.page, t.dataset.blockId) : null;
        if (blk) {
          blk.text = t.textContent.trim() ? [{ t: t.textContent }] : [];
          S.touch(this.page); S.markDirty();
        }
        if (wrap) {
          wrap.classList.remove("editing");
          const prev = wrap.querySelector(".eq-preview");
          const latex = this.eqLatex(t.textContent);
          if (prev) {
            if (latex) {
              prev.classList.remove("eq-empty");
              prev.innerHTML = MathR.renderDisplay(latex) || U.esc(latex);
            } else {
              prev.classList.add("eq-empty");
              prev.textContent = "点击输入 LaTeX 公式…";
            }
          }
        }
      }
      // Mermaid 源码编辑结束：自动渲染
      if (t.classList && t.classList.contains("mm-edit")) {
        const blk = this.page ? S.findBlock(this.page, t.dataset.blockId) : null;
        if (blk) this.renderMermaid(blk);
      }
      // 焦点离开块时隐藏 AI 按钮
      this.hideAIButton();
    },

    /** switch an equation block into inline editing mode (type LaTeX directly) */
    enterEquationEdit(blk, previewEl) {
      const wrap = previewEl.closest(".b-equation");
      const ed = wrap ? wrap.querySelector(".eq-source") : null;
      if (!ed) return;
      wrap.classList.add("editing");
      if (!ed.textContent.trim()) ed.textContent = "$$";
      ed.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    },

    /** floating preview under the caret of an equation editor (textarea or contenteditable) */
    showEquationPreview(el) {
      let pop = document.querySelector("#math-preview");
      if (!pop) {
        pop = U.el("div", "popover math-preview");
        pop.id = "math-preview";
        document.body.appendChild(pop);
      }
      pop.style.display = "flex";
      const latex = this.eqLatex(el.value != null ? el.value : el.textContent);
      pop.innerHTML = latex ? (MathR.renderDisplay(latex) || U.esc(latex)) : '<span style="color:var(--text-faint);font-size:12px">预览…</span>';
      const cr = el.tagName === "TEXTAREA" ? this.caretRectInTextarea(el) : this.caretRectInEditable();
      const pr = pop.getBoundingClientRect();
      let left = cr.left;
      let top = cr.bottom + 6;
      if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
      if (top + pr.height > window.innerHeight - 8) top = cr.top - pr.height - 6;
      pop.style.left = Math.max(8, left) + "px";
      pop.style.top = Math.max(8, top) + "px";
    },

    /* ================= Keydown ================= */
    onKeydown(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;
      if (e.isComposing || e.keyCode === 229) return; // 输入法组合中，让 IME 处理按键

      // code textarea
      if (t.tagName === "TEXTAREA") {
        if (e.key === "Tab") {
          e.preventDefault();
          const start = t.selectionStart, end = t.selectionEnd;
          t.value = t.value.slice(0, start) + "\t" + t.value.slice(end);
          t.selectionStart = t.selectionEnd = start + 1;
          const blk = S.findBlock(page, t.dataset.blockId);
          if (blk) { blk.attrs.source = t.value; S.markDirty(); }
        } else if (e.key === "Enter" && !e.shiftKey) {
          const blk = S.findBlock(page, t.dataset.blockId);
          if (blk && blk.type === "equation") {
            e.preventDefault();
            t.blur(); // focusout 提交公式预览
          }
        } else if (e.key === "Escape") {
          U.closePopovers();
          t.blur();
          this.selectBlock(t.closest(".block"));
        }
        return;
      }

      if (t.dataset && t.dataset.role === "page-title") {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = page.children[0];
          if (first) {
            this.refresh();
            this.focusBlock(first.id, 0);
          } else {
            const nb = S.newBlock("paragraph");
            page.children.push(nb);
            S.touch(page); S.markDirty();
            this.refresh({ id: nb.id, offset: 0 });
          }
        }
        return;
      }

      const blockEl = t.closest(".block");
      if (!blockEl || !t.isContentEditable) return;
      const blk = S.findBlock(page, blockEl.dataset.blockId);
      if (!blk) return;

      // 行内公式源码编辑中：Enter/Esc 提交，其它按键正常编辑源码
      if (this._mathEditing && this._mathEditing.blockId === blk.id) {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          this.commitMathSource(e.key === "Enter");
        }
        return;
      }

      // 公式块源码编辑中：回车提交并新建下一段（换行）
      if (blk.type === "equation" && t.classList && t.classList.contains("eq-source") && e.key === "Enter") {
        e.preventDefault();
        this.equationEnter(blk, t);
        return;
      }

      // table cell Tab navigation
      if (blk.type === "table" && e.key === "Tab") {
        e.preventDefault();
        const cells = Array.from(this.blocksEl.querySelectorAll('.b-table .ed[data-block-id="' + blk.id + '"]'));
        const idx = cells.indexOf(t);
        const next = cells[(idx + (e.shiftKey ? -1 : 1) + cells.length) % cells.length];
        if (next) next.focus();
        return;
      }
      if (blk.type === "table" && e.key === "Enter") {
        if (e.shiftKey) return; // soft break within cell
        e.preventDefault();
        this.tableEnter(blk, t);
        return;
      }

      if (e.key === "Enter") {
        if (e.shiftKey) return; // soft break via default
        e.preventDefault();
        this.handleEnter(blk, blockEl, t);
      } else if (e.key === "Backspace") {
        // 先删除紧跟光标的块首不可编辑元素（行内公式/提及），再判断是否合并到上一块
        const leading = B.leadingNonEditable(t);
        if (leading) {
          e.preventDefault();
          leading.remove();
          blk.text = B.htmlToSegments(t);
          S.touch(page); S.markDirty();
          B.setCaret(t, 0);
        } else if (B.caretAtStart(t)) {
          e.preventDefault();
          this.handleBackspace(blk, blockEl, t);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        this.handleTab(blk, e.shiftKey);
      } else if (e.key === "Escape") {
        U.closePopovers();
        this.selectBlock(blockEl);
      } else if (e.key === "ArrowLeft" && B.caretAtStart(t)) {
        const prev = S.prevBlock(page, blk.id);
        if (prev) {
          const prevEl = this.blocksEl.querySelector('.ed[data-block-id="' + prev.id + '"]');
          if (prevEl) { e.preventDefault(); this.focusBlock(prev.id, B.editableTextLength(prevEl)); }
        }
      } else if (e.key === "ArrowRight" && B.caretAtEnd(t)) {
        const next = S.nextBlock(page, blk.id);
        if (next) {
          const nextEl = this.blocksEl.querySelector('.ed[data-block-id="' + next.id + '"]');
          if (nextEl) { e.preventDefault(); this.focusBlock(next.id, 0); }
        }
      }
    },

    handleEnter(blk, blockEl, ed) {
      const page = this.page;
      const caret = B.getCaretOffset(ed);
      const textLen = B.editableTextLength(ed);
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;

      // 行间公式：光标前是 $$...$$ → 转成公式块（换行后渲染）
      const textBefore = U.segsText(blk.text).slice(0, caret.textOffset);
      const dm = textBefore.match(/^\$\$([^$\n]+?)\$\$$/);
      if (dm && dm[1].trim()) { this.convertToEquation(blk, dm[1].trim()); return; }

      if (blk.type === "code") { document.execCommand("insertText", false, "\n"); return; }

      // toggle: new paragraph after
      if (blk.type === "toggle") {
        const nb = S.newBlock("paragraph");
        pos.list.splice(pos.index + 1, 0, nb);
        S.touch(page); S.markDirty();
        this.refresh({ id: nb.id, offset: 0 });
        return;
      }

      const isList = ["bullet", "numbered", "todo"].includes(blk.type);
      const isEmpty = textLen === 0;

      if (isList && isEmpty) {
        if (blk.indent > 0) {
          blk.indent--;
          S.markDirty();
          this.refresh({ id: blk.id, offset: 0 });
        } else {
          const nb = S.newBlock("paragraph");
          pos.list.splice(pos.index, 1, nb);
          S.touch(page); S.markDirty();
          this.refresh({ id: nb.id, offset: 0 });
        }
        return;
      }

      const nb = S.newBlock(isList ? blk.type : (["heading1", "heading2", "heading3", "quote", "callout"].includes(blk.type) ? "paragraph" : blk.type));
      nb.indent = blk.indent || 0;
      if (nb.type === "todo") nb.checked = false;

      if (caret.textOffset >= textLen) {
        pos.list.splice(pos.index + 1, 0, nb);
        S.touch(page); S.markDirty();
        this.refresh({ id: nb.id, offset: 0 });
      } else {
        const rest = sliceSegments(blk.text, caret.textOffset);
        blk.text = sliceSegments(blk.text, 0, caret.textOffset);
        nb.text = rest;
        pos.list.splice(pos.index + 1, 0, nb);
        S.touch(page); S.markDirty();
        this.refresh({ id: nb.id, offset: 0 });
      }
    },

    handleBackspace(blk, blockEl, ed) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;

      if (blk.type === "toggle" && blk.children && blk.children.length && blk.folded) {
        blk.folded = false;
        S.markDirty();
        this.refresh({ id: blk.id, offset: 0 });
        return;
      }

      const isList = ["bullet", "numbered", "todo"].includes(blk.type);
      if (isList && blk.indent > 0) {
        blk.indent--;
        S.markDirty();
        this.refresh({ id: blk.id, offset: 0 });
        return;
      }
      if (isList && U.segsText(blk.text).length === 0) {
        // empty list item → paragraph first; merge happens on the next Backspace
        blk.type = "paragraph";
        S.markDirty();
        this.refresh({ id: blk.id, offset: 0 });
        return;
      }

      const prev = S.prevBlock(page, blk.id);
      if (!prev) return;
      // 只与可输入的文本块合并，避免文字被并进图片/分割线/代码等不显示 text 的块
      if (!["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout"].includes(prev.type)) return;

      const prevTextLen = U.segsText(prev.text).length;
      prev.text = prev.text.concat(blk.text);
      if (blk.children && blk.children.length) {
        prev.children = prev.children.concat(blk.children);
        if (prev.type !== "toggle") prev.type = "toggle";
      }
      pos.list.splice(pos.index, 1);
      S.touch(page); S.markDirty();
      this.refresh({ id: prev.id, offset: prevTextLen });
    },

    handleTab(blk, shift) {
      const page = this.page;
      const listTypes = ["bullet", "numbered", "todo", "toggle", "paragraph", "quote", "callout", "heading1", "heading2", "heading3"];
      if (!listTypes.includes(blk.type)) return;
      if (shift) {
        if (blk.indent > 0) blk.indent--;
      } else {
        if (blk.indent < 5) blk.indent++;
      }
      S.markDirty();
      const ed = this.blocksEl.querySelector('.ed[data-block-id="' + blk.id + '"]');
      const off = ed ? B.getCaretOffset(ed).textOffset : 0;
      this.refresh({ id: blk.id, offset: off });
    },

    /* ================= Click ================= */
    async onClick(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;

      if (t.dataset && t.dataset.role === "page-icon") {
        this.openEmojiPicker((emoji) => {
          page.icon = emoji;
          S.markDirty();
          this.renderPage(page.id);
        });
        return;
      }

      // 正文内联链接：Ctrl/Cmd + 点击在新标签打开；普通点击进入编辑不跳转
      const linkA = t.closest ? t.closest("a[href]") : null;
      if (linkA) {
        const href = linkA.getAttribute("href") || "";
        e.preventDefault();
        if (href && (e.ctrlKey || e.metaKey)) {
          window.open(href, "_blank", "noopener,noreferrer");
        }
        return;
      }

      // @ mention → open linked page
      const mention = t.closest(".nt-mention");
      if (mention) {
        const pid = mention.getAttribute("data-page");
        if (pid && global.App) { const tp = S.getPage(pid); if (tp && !tp.deleted) App.openPage(pid); }
        return;
      }
      // inline math span → open popover editor
      const mSpan = t.closest(".nt-math");
      if (mSpan) {
        const mblk = S.findBlock(page, mSpan.closest(".block").dataset.blockId);
        if (mblk) this.openMathSource(mSpan, mblk);
        return;
      }
      // equation block → inline edit (no modal)
      const eq = t.closest(".eq-preview");
      if (eq) {
        const blk = S.findBlock(page, eq.dataset.blockId);
        if (blk) this.enterEquationEdit(blk, eq);
        return;
      }

      if (t.classList.contains("toggle-caret")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          blk.folded = !blk.folded;
          S.markDirty();
          const el = t.closest(".block");
          if (el) el.classList.toggle("folded", blk.folded);
        }
        return;
      }
      if (t.classList.contains("b-checkbox")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          blk.checked = !blk.checked;
          S.markDirty();
          t.classList.toggle("checked", blk.checked);
          t.textContent = blk.checked ? "✓" : "";
          t.closest(".b-list-row").classList.toggle("done", blk.checked);
        }
        return;
      }
      if (t.dataset && t.dataset.action === "tpl-insert") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.insertTemplate(blk);
        return;
      }
      if (t.dataset && t.dataset.action === "tpl-add") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          blk.children = blk.children || [];
          const nb = S.newBlock("paragraph");
          blk.children.push(nb);
          S.touch(page); S.markDirty();
          this.refresh({ id: nb.id, offset: 0 });
        }
        return;
      }
      if (t.classList.contains("b-comment")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.openComments(blk);
        return;
      }
      if (t.classList.contains("co-ico")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (!blk) return;
        this.openEmojiPicker((emoji) => {
          blk.attrs.icon = emoji;
          S.markDirty();
          this.refresh({ id: blk.id });
        });
        return;
      }

      if (t.classList.contains("embed-ph")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (!blk) return;
        if (blk.type === "embed") {
          const url = await U.promptModal({ title: U.t("嵌入网址"), value: "https://", placeholder: "https://" });
          if (url && url.trim()) { blk.attrs.url = url.trim(); S.markDirty(); this.refresh({ id: blk.id }); }
        } else if (blk.type === "image") {
          this.pickImageFile(blk);
        }
        return;
      }

      if (t.tagName === "IMG" && t.dataset.blockId) {
        this.selectBlock(t.closest(".block"));
        return;
      }

      if (t.closest(".q-reveal")) return; // 「显示/隐藏答案」按钮自行处理，不打开编辑
      const question = t.closest(".b-question");
      if (question) {
        const blk = S.findBlock(page, question.closest(".block").dataset.blockId);
        if (blk) this.editQuestion(blk);
        return;
      }
      const flashcard = t.closest(".b-flashcard");
      if (flashcard) {
        const blk = S.findBlock(page, flashcard.closest(".block").dataset.blockId);
        if (!blk) return;
        if (t.closest(".fc-card")) {
          t.closest(".fc-card").classList.toggle("flipped");
        } else {
          this.editFlashcard(blk);
        }
        return;
      }

      if (t.closest(".b-bookmark")) {
        const blk = S.findBlock(page, t.closest(".b-bookmark").dataset.blockId);
        if (!blk) return;
        const url = await U.promptModal({ title: U.t("书签网址"), value: blk.attrs.url || "https://", placeholder: "https://" });
        if (url && url.trim()) {
          blk.attrs.url = url.trim();
          blk.attrs.title = blk.attrs.title || url.trim();
          S.markDirty();
          this.refresh({ id: blk.id });
        }
        return;
      }

      if (t.closest(".b-file")) {
        const blk = S.findBlock(page, t.closest(".b-file").dataset.blockId);
        if (!blk) return;
        this.pickFile(blk);
        return;
      }

      const sn = t.closest(".b-snippet .sn-link");
      if (sn) {
        const blk = S.findBlock(page, sn.dataset.blockId);
        if (!blk) return;
        const target = blk.attrs.pageId ? S.getPage(blk.attrs.pageId) : null;
        if (target && !target.deleted && global.App) { App.openPage(target.id); return; }
        this.linkSnippet(blk);
        return;
      }

      const pr = t.closest(".b-page-ref, .b-db-ref");
      if (pr) {
        const blk = S.findBlock(page, pr.dataset.blockId);
        if (blk && blk.attrs.pageId && global.App) {
          const target = S.getPage(blk.attrs.pageId);
          if (target && !target.deleted) App.openPage(target.id);
        }
        return;
      }

      const hl = t.closest(".b-highlight");
      if (hl) {
        const blk = S.findBlock(page, hl.dataset.blockId);
        if (blk && blk.attrs.sourcePageId && global.App) {
          if (global.PDFViewer) PDFViewer.focusHighlight = blk.attrs.highlightId;
          App.openPage(blk.attrs.sourcePageId);
        }
        return;
      }

      const pim = t.closest(".b-pdfimage");
      if (pim) {
        const blk = S.findBlock(page, pim.dataset.blockId);
        if (blk && blk.attrs.sourcePageId && global.App) {
          if (global.PDFViewer) PDFViewer.focusImage = blk.attrs.imageId;
          App.openPage(blk.attrs.sourcePageId);
        }
        return;
      }

      if (t.classList.contains("b-add-btn")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (!blk) return;
        const pos = S.findBlockPos(page, blk.id);
        const nb = S.newBlock("paragraph");
        pos.list.splice(pos.index + 1, 0, nb);
        S.touch(page); S.markDirty();
        this.refresh({ id: nb.id, offset: 0 });
        return;
      }

      if (t.classList.contains("b-col-add")) {
        const colsBlk = S.findBlock(page, t.dataset.blockId);
        if (colsBlk) {
          const col = (colsBlk.children || []).find(c => c.id === t.dataset.colId);
          if (col) {
            col.children = col.children || [];
            const nb = S.newBlock("paragraph");
            col.children.push(nb);
            S.touch(page); S.markDirty();
            this.refresh({ id: nb.id, offset: 0 });
          }
        }
        return;
      }

      if (t.classList.contains("tb-btn") && t.closest(".b-code")) {
        const blk = S.findBlock(page, t.closest(".b-code").dataset.blockId);
        if (blk && blk.attrs.source) {
          U.copyText(blk.attrs.source);
          U.toast(U.t("已复制代码"));
        }
        return;
      }

      if (t.tagName === "SELECT" && t.closest(".b-code")) {
        const blk = S.findBlock(page, t.closest(".b-code").dataset.blockId);
        if (blk) { blk.attrs.language = t.value; S.markDirty(); }
        return;
      }

      if (t.classList.contains("mm-btn")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          if (t.dataset.role === "mm-fix") this.aiFixBlock(blk);
          else this.renderMermaid(blk);
        }
        return;
      }
      if (t.classList.contains("b-html-btn")) {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) {
          if (t.dataset.role === "html-fix") this.aiFixBlock(blk);
          else if (t.dataset.role === "html-edit") this.editHTML(blk);
        }
        return;
      }
      if (t.closest(".mm-preview")) {
        const preview = t.closest(".mm-preview");
        const blk = S.findBlock(page, preview.dataset.blockId);
        if (blk) this.toggleMermaidEdit(blk);
        return;
      }

      if (t.dataset && t.dataset.role === "row-del") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.tableOp(blk, "delRow", parseInt(t.dataset.row, 10));
        return;
      }
      if (t.dataset && t.dataset.role === "col-del") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.tableOp(blk, "delCol", parseInt(t.dataset.col, 10));
        return;
      }
      if (t.dataset && t.dataset.role === "add-row") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.tableOp(blk, "addRow");
        return;
      }
      if (t.dataset && t.dataset.role === "add-col") {
        const blk = S.findBlock(page, t.dataset.blockId);
        if (blk) this.tableOp(blk, "addCol");
        return;
      }

      if (t.classList.contains("block-inner") || t.classList.contains("b-ghost") || t.classList.contains("b-divider")) {
        const blockEl = t.closest(".block");
        if (blockEl) {
          if (e.shiftKey && this._anchorBlockId && this._anchorBlockId !== blockEl.dataset.blockId) {
            this.selectRange(this._anchorBlockId, blockEl.dataset.blockId);
          } else {
            this.selectBlock(blockEl);
          }
        }
      }
    },

    /* ================= Mouse down / drag ================= */
    onMouseDown(e) {
      const t = e.target;
      if (t.classList && t.classList.contains("b-grip")) {
        this.startDrag(t.closest(".block"));
        return;
      }
      // PDF / 网页查看器内不触发块框选，保留原生文本选择等交互
      if (t.closest && t.closest(".pdf-page, .web-page")) return;
      // 框选：在左槽（⋮⋮ 所在区域）或空白处按下鼠标
      const editable = t.closest ? t.closest("[contenteditable], textarea, input, button") : null;
      if (editable) return;
      const onGutter = t.classList && t.classList.contains("b-tools");
      const inBlock = t.closest ? t.closest(".block") : null;
      if (onGutter || !inBlock) this.startMarquee(e);
    },

    startDrag(blockEl) {
      const page = this.page;
      if (!page || !blockEl) return;
      this._drag = { blockId: blockEl.dataset.blockId, pageId: page.id };
      const multi = blockEl.classList.contains("selected") && this.selectedBlocks().length > 1;
      if (multi) this._drag.ids = this.selectedBlocks().map(b => b.dataset.blockId);
      else this.selectBlock(blockEl);
      this.selectedBlocks().forEach(b => b.classList.add("dragging"));
    },

    onDragStart(e) {
      const grip = e.target.closest ? e.target.closest(".b-grip") : null;
      if (grip) {
        const blockEl = grip.closest(".block");
        if (blockEl && this.page) {
          this._drag = { blockId: blockEl.dataset.blockId, pageId: this.page.id };
          const multi = blockEl.classList.contains("selected") && this.selectedBlocks().length > 1;
          if (multi) this._drag.ids = this.selectedBlocks().map(b => b.dataset.blockId);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", blockEl.dataset.blockId);
          this.selectedBlocks().forEach(b => b.classList.add("dragging"));
        }
      }
    },

    columnDropSide(rect, clientX) {
      if (!rect || rect.width < 80) return null;
      const edge = Math.min(72, Math.max(28, rect.width * 0.22));
      if (clientX <= rect.left + edge) return "left";
      if (clientX >= rect.right - edge) return "right";
      return null;
    },

    onDragOver(e) {
      if (!this._drag) {
        // allow OS file drops
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
        return;
      }
      e.preventDefault();
      const page = this.page;
      const container = this.blocksEl;
      if (!container || !page) return;
      const blockEl = e.target.closest ? e.target.closest(".block") : null;
      if (this._dropLine) { this._dropLine.remove(); this._dropLine = null; }

      if (!blockEl || blockEl.dataset.blockId === this._drag.blockId || (this._drag.ids && this._drag.ids.includes(blockEl.dataset.blockId))) {
        const rect = container.getBoundingClientRect();
        if (e.clientY > rect.top + 20) {
          const line = U.el("div", "drop-line");
          line.style.top = (container.scrollHeight - 2) + "px";
          container.appendChild(line);
          this._dropLine = line;
          this._dropTarget = { id: null, pos: "after" };
        }
        return;
      }
      const rect = blockEl.getBoundingClientRect();
      const side = this.columnDropSide(rect, e.clientX);
      const cRect = container.getBoundingClientRect();
      const yTop = rect.top - cRect.top;
      const yBottom = rect.bottom - cRect.top;
      if (side) {
        const line = U.el("div", "drop-line column-side " + side);
        line.style.top = yTop + "px";
        line.style.height = Math.max(24, rect.height) + "px";
        line.style.left = ((side === "left" ? rect.left : rect.right) - cRect.left - 2) + "px";
        container.appendChild(line);
        this._dropLine = line;
        this._dropTarget = { id: blockEl.dataset.blockId, pos: side };
        return;
      }

      const y = e.clientY - rect.top;
      const h = rect.height;
      let pos = "after";
      if (y < h * 0.28) pos = "before";
      else if (y > h * 0.72) pos = "after";
      else {
        const blk = S.findBlock(page, blockEl.dataset.blockId);
        if (!this._drag.ids && blk && (blk.type === "toggle" || blk.type === "template")) pos = "inside";
        else pos = y < h * 0.5 ? "before" : "after";
      }
      const line = U.el("div", "drop-line" + (pos === "inside" ? " inside" : ""));
      if (pos === "inside") line.style.top = (yBottom - 2) + "px";
      else line.style.top = (pos === "before" ? yTop - 1 : yBottom - 1) + "px";
      line.style.left = (rect.left - cRect.left) + "px";
      line.style.width = rect.width + "px";
      container.appendChild(line);
      this._dropLine = line;
      this._dropTarget = { id: blockEl.dataset.blockId, pos };
    },

    onDragLeave(e) {
      if (!this.blocksEl) return;
      if (e.target === this.blocksEl && !e.relatedTarget) {
        if (this._dropLine) { this._dropLine.remove(); this._dropLine = null; }
      }
    },

    onDrop(e) {
      e.preventDefault();
      const page = this.page;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        this.handleFileDrop(files, e);
        this.onDragEnd();
        return;
      }
      if (!this._drag || !page) { this.onDragEnd(); return; }
      const drag = this._drag;
      const target = this._dropTarget;
      this.onDragEnd();
      if (!target) { this._drag = null; return; }
      if (drag.ids && drag.ids.length > 1) {
        // 多选一起拖动
        if (target.pos === "left" || target.pos === "right") {
          // 多选拖到侧边 → 创建多列布局
          this.wrapInColumns(page, drag.ids, target.id, target.pos);
        } else {
          S.moveBlocks(page, drag.ids, target.id, target.pos === "inside" ? "after" : target.pos);
        }
        this.clearSelection();
        this.refresh();
      } else if (!target.id) {
        // 没有有效目标 → 取消，保持原位
        this._drag = null;
        return;
      } else {
        if (target.pos === "left" || target.pos === "right") S.moveBlockToSide(page, drag.blockId, target.id, target.pos);
        else S.moveBlock(page, drag.blockId, target.id, target.pos);
        this.refresh({ id: drag.blockId });
      }
      this._drag = null;
    },

    /** 把多个选中块和目标块一起包装成多列布局 */
    wrapInColumns(page, ids, targetId, side) {
      // 先记录目标位置（在移动之前）
      const targetPos = S.findBlockPos(page, targetId);
      const parent = targetPos ? (targetPos.parent || page) : page;
      const insertIdx = targetPos ? targetPos.index : parent.children.length;

      const cols = S.newBlock("columns");
      const col1 = S.newBlock("column");
      const col2 = S.newBlock("column");

      // 按原始顺序排序选中的块
      const posMap = new Map();
      ids.forEach(id => {
        const blk = S.findBlock(page, id);
        if (blk) posMap.set(id, S.findBlockPos(page, id));
      });
      const sorted = [...ids].sort((a, b) => {
        const pa = posMap.get(a), pb = posMap.get(b);
        if (!pa || !pb) return 0;
        if (pa.parent !== pb.parent) return 0;
        return pa.index - pb.index;
      });
      // 从原始位置移除，加入列
      sorted.forEach(id => { const blk = S.findBlock(page, id); if (blk) { const p = S.findBlockPos(page, id); if (p) { p.list.splice(p.index, 1); col1.children.push(blk); } } });
      // 目标块移入列
      const targetBlk = S.findBlock(page, targetId);
      if (targetBlk) { const tp = S.findBlockPos(page, targetId); if (tp) { tp.list.splice(tp.index, 1); col2.children.push(targetBlk); } }

      // 组装 columns
      if (side === "left") { cols.children.push(col2, col1); }
      else { cols.children.push(col1, col2); }

      // 插入到目标位置
      parent.children.splice(insertIdx, 0, cols);
      S.touch(page); S.markDirty();
      this.refresh();
    },

    onDragEnd() {
      this._drag = null;
      if (this._dropLine) { this._dropLine.remove(); this._dropLine = null; }
      document.querySelectorAll(".block.dragging").forEach(b => b.classList.remove("dragging"));
    },

    async handleFileDrop(files, e) {
      const page = this.page;
      const t = e.target;
      const blockEl = t.closest ? t.closest(".block") : null;
      let insertAt = null;
      if (blockEl) {
        const pos = S.findBlockPos(page, blockEl.dataset.blockId);
        if (pos) insertAt = pos.index + 1;
      }
      const arr = Array.from(files);
      for (const f of arr) {
        const isImg = f.type.startsWith("image/");
        const nb = S.newBlock(isImg ? "image" : "file");
        const dataUrl = await U.fileToDataURL(f);
        if (isImg) nb.attrs.src = dataUrl;
        else { nb.attrs.src = dataUrl; nb.attrs.name = f.name; }
        if (insertAt == null) page.children.push(nb);
        else page.children.splice(insertAt++, 0, nb);
      }
      if (arr.length) { S.touch(page); S.markDirty(); this.refresh(); }
    },

    pickImageFile(blk) {
      const input = U.el("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        const dataUrl = await U.fileToDataURL(f);
        blk.attrs.src = dataUrl;
        S.markDirty();
        this.refresh({ id: blk.id });
      };
      input.click();
    },

    pickFile(blk) {
      const input = U.el("input");
      input.type = "file";
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        const dataUrl = await U.fileToDataURL(f);
        blk.attrs.src = dataUrl;
        blk.attrs.name = f.name;
        S.markDirty();
        this.refresh({ id: blk.id });
      };
      input.click();
    },

    /* ================= Paste ================= */
    onPaste(e) {
      const t = e.target;
      const page = this.page;
      if (!page) return;
      if (t.tagName === "TEXTAREA") return;
      const clipboard = e.clipboardData;
      const items = Array.from(clipboard.items || []).filter(i => i.type.startsWith("image/"));
      if (items.length) {
        e.preventDefault();
        const blkEl = t.closest(".block");
        let insertIdx = null;
        if (blkEl) {
          const pos = S.findBlockPos(page, blkEl.dataset.blockId);
          if (pos) insertIdx = pos.index + 1;
        }
        const f = items[0].getAsFile();
        if (f) {
          U.fileToDataURL(f).then(dataUrl => {
            const nb = S.newBlock("image");
            nb.attrs.src = dataUrl;
            if (insertIdx == null) page.children.push(nb);
            else page.children.splice(insertIdx, 0, nb);
            S.touch(page); S.markDirty();
            this.refresh();
          });
        }
        return;
      }
      const text = clipboard.getData("text/plain");
      if (text && text.includes("\n") && !clipboard.getData("text/html")) {
        e.preventDefault();
        const blkEl = t.closest(".block");
        if (!blkEl) return;
        const blk = S.findBlock(page, blkEl.dataset.blockId);
        if (!blk) return;
        const caret = B.getCaretOffset(t);
        const lines = text.split(/\r?\n/);
        const first = lines.shift();
        // 保留光标两侧原有片段的格式（加粗/链接/公式/提及），仅插入纯文本首行
        const before = sliceSegments(blk.text, 0, caret.textOffset);
        const after = sliceSegments(blk.text, caret.textOffset);
        blk.text = before.concat(first ? [{ t: first }] : [], after);
        const pos = S.findBlockPos(page, blk.id);
        let idx = pos.index + 1;
        const isList = ["bullet", "numbered", "todo"].includes(blk.type);
        lines.forEach(line => {
          // 列表内粘贴多行时保持列表类型，而不是一律降级成正文
          const nb = S.newBlock(isList ? blk.type : "paragraph", line);
          nb.indent = blk.indent || 0;
          if (nb.type === "todo") nb.checked = false;
          pos.list.splice(idx++, 0, nb);
        });
        S.touch(page); S.markDirty();
        this.refresh({ id: blk.id, offset: caret.textOffset + first.length });
      }
    },

    /* ================= Selection toolbar ================= */
    inlineSelectionEditor(sel, content) {
      if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      if (!content || !content.contains(range.commonAncestorContainer)) return null;
      const nodeToElement = (node) => node && (node.nodeType === 1 ? node : node.parentElement);
      const start = nodeToElement(range.startContainer);
      const end = nodeToElement(range.endContainer);
      const startEditor = start && start.closest && start.closest(".ed");
      const endEditor = end && end.closest && end.closest(".ed");
      if (!startEditor || startEditor !== endEditor || startEditor.closest(".b-code")) return null;
      return startEditor;
    },

    onSelectionChange() {
      if (this._toolbarLock) return;
      const sel = window.getSelection();
      const content = document.getElementById("content");
      const ed = this.inlineSelectionEditor(sel, content);
      if (!ed) { this.hideToolbar(); return; }
      this.showToolbar(sel.getRangeAt(0));
    },

    showToolbar(range) {
      let tb = document.querySelector("#inline-tb");
      if (!tb) {
        tb = U.el("div", "popover tb-h");
        tb.id = "inline-tb";
        const mk = (label, title, cmd) => {
          const b = U.el("button", "tb-btn", label);
          b.title = title;
          b.dataset.cmd = cmd;
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => this.execInline(cmd));
          tb.appendChild(b);
          return b;
        };
        mk("<b>B</b>", "加粗 (Ctrl+B)", "bold");
        mk("<i>I</i>", "斜体 (Ctrl+I)", "italic");
        mk("<u>U</u>", "下划线 (Ctrl+U)", "underline");
        mk("<s>S</s>", "删除线", "strikeThrough");
        mk("</>", "行内代码", "code");
        mk("🔗", "链接", "link");
        const colorBtn = U.el("button", "tb-btn", "A");
        colorBtn.style.color = "#d9730d";
        colorBtn.title = "文字颜色";
        colorBtn.dataset.cmd = "color";
        colorBtn.addEventListener("mousedown", (e) => e.preventDefault());
        colorBtn.addEventListener("click", () => this.openColorMenu(colorBtn, "color"));
        tb.appendChild(colorBtn);
        const bgBtn = U.el("button", "tb-btn", "🖍");
        bgBtn.title = "背景颜色";
        bgBtn.dataset.cmd = "bg";
        bgBtn.addEventListener("mousedown", (e) => e.preventDefault());
        bgBtn.addEventListener("click", () => this.openColorMenu(bgBtn, "bg"));
        tb.appendChild(bgBtn);
        document.body.appendChild(tb);
        this._tb = tb;
      }
      const rect = range.getBoundingClientRect();
      U.placePop(tb, rect, { above: true });
      tb.querySelectorAll("[data-cmd]").forEach(b => {
        const cmd = b.dataset.cmd;
        if (cmd === "color" || cmd === "bg") return;
        let on = false;
        try {
          if (cmd === "code") on = !!(this.currentSelEl() && this.currentSelEl().closest("code"));
          else on = document.queryCommandState(cmd);
        } catch (err) { on = false; }
        b.classList.toggle("on", on);
      });
    },

    currentSelEl() {
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const c = sel.getRangeAt(0).commonAncestorContainer;
      return c.nodeType === 1 ? c : c.parentElement;
    },

    hideToolbar(force) {
      const tb = document.querySelector("#inline-tb");
      if (tb && tb.parentNode && (force || !tb.contains(document.activeElement))) tb.remove();
      if (force) this._tb = null;
    },

    async execInline(cmd) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const el = this.currentSelEl();
      const content = document.getElementById("content");
      if (!el || !content.contains(el)) return;
      try {
        if (cmd === "bold") document.execCommand("bold");
        else if (cmd === "italic") document.execCommand("italic");
        else if (cmd === "underline") document.execCommand("underline");
        else if (cmd === "strikeThrough") document.execCommand("strikeThrough");
        else if (cmd === "code") {
          const inCode = !!(el.closest && el.closest("code"));
          const txt = sel.toString();
          if (!txt) return;
          if (inCode) document.execCommand("insertHTML", false, txt);
          else document.execCommand("insertHTML", false, "<code>" + U.esc(txt) + "</code>");
        } else if (cmd === "link") {
          const url = await U.promptModal({ title: U.t("链接地址"), value: "https://", placeholder: "https://" });
          if (url && url.trim()) document.execCommand("createLink", false, url.trim());
        }
      } catch (err) { console.warn(err); }
    },

    openColorMenu(anchor, mode) {
      const rect = anchor.getBoundingClientRect(); // 先取位置（关闭 toolbar 前，否则 anchor 会失效）
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      const sw = U.el("div", "swatches");
      const list = mode === "color" ? B.TEXT_COLORS : B.BG_COLORS;
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      list.forEach(c => {
        const val = c.v ? (dark && c.dark ? c.dark : c.v) : null;
        const s = U.el("button", "swatch" + (c.v ? "" : " off"), c.v ? "" : "∅");
        if (val) s.style.background = val;
        s.title = c.name;
        s.addEventListener("mousedown", (e) => e.preventDefault()); // 保持文本选区
        s.addEventListener("click", () => {
          this.applyInlineColor(mode, c.v);
          pop.remove();
        });
        sw.appendChild(s);
      });
      scroll.appendChild(sw);
      pop.appendChild(scroll);
      U.placePop(pop, rect, { alignRight: true });
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    applyInlineColor(mode, color) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const txt = sel.toString();
      if (!txt) return;
      if (!color) {
        // 默认色：清除颜色（当前实现为整体重写选区，因此会连同其它行内格式一并清除）
        document.execCommand("insertHTML", false, U.esc(txt));
        return;
      }
      // 深色主题下插入深色值，序列化时再映射回浅色值存储
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const list = mode === "color" ? B.TEXT_COLORS : B.BG_COLORS;
      const entry = list.find(c => c.v === color);
      const val = (dark && entry && entry.dark) ? entry.dark : color;
      const style = mode === "color" ? "color:" + val : "background-color:" + val;
      document.execCommand("insertHTML", false, '<span style="' + style + '">' + U.esc(txt) + "</span>");
    },

    /* ================= Emoji picker ================= */
    openEmojiPicker(cb) {
      const modal = U.modal({ title: "选择图标" });
      const search = U.el("input", "modal-input");
      search.placeholder = "搜索图标（支持中文关键词）…";
      search.style.marginBottom = "10px";
      modal.body.appendChild(search);

      const tabs = U.el("div", "emoji-tabs");
      modal.body.appendChild(tabs);
      const grid = U.el("div", "emoji-grid");
      modal.body.appendChild(grid);

      const recents = U.recentEmojisGet();
      const groups = [];
      if (recents.length) groups.push({ id: "recent", label: "最近", emojis: recents });
      groups.push({ id: "all", label: "全部", emojis: U.EMOJIS });
      (U.EMOJI_GROUPS || []).forEach(g => groups.push(g));
      let active = groups[0].id;

      const matches = (e) => {
        const q = search.value.trim().toLowerCase();
        if (!q) return true;
        if (String(e).toLowerCase().includes(q)) return true;
        const kw = (U.EMOJI_KEYWORDS || {})[e];
        return !!(kw && kw.toLowerCase().includes(q));
      };

      const render = () => {
        const q = search.value.trim().toLowerCase();
        U.clear(tabs);
        if (!q) {
          groups.forEach(g => {
            const b = U.el("button", "emoji-tab" + (g.id === active ? " active" : ""), g.label);
            b.addEventListener("click", () => { active = g.id; render(); });
            tabs.appendChild(b);
          });
        }
        const base = groups.find(g => g.id === active) || groups[0];
        const shown = q ? U.EMOJIS.filter(matches) : base.emojis;
        U.clear(grid);
        shown.slice(0, 200).forEach(e => {
          const b = U.el("button", null, e);
          b.type = "button";
          b.addEventListener("click", () => { U.recentEmojisAdd(e); modal.close(); cb(e); });
          grid.appendChild(b);
        });
      };
      render();
      search.addEventListener("input", render);
      search.focus();
    },

    /* ================= Block AI menu ================= */
    blockText(blk) {
      if (!blk) return "";
      if (blk.type === "code" || blk.type === "snippet" || blk.type === "mermaid") return blk.attrs.source || "";
      return U.segsText(blk.text) || "";
    },

    setBlockText(blk, text) {
      if (blk.type === "code" || blk.type === "snippet" || blk.type === "mermaid") blk.attrs.source = text;
      else blk.text = (global.AI && AI.inlineToSegments ? AI.inlineToSegments(text) : [{ t: text }]);
    },

    openBlockAI(blk, x, y) {
      U.closePopovers();
      this.hideAIButton();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const addItem = (icon, label, fn) => {
        const it = U.el("div", "menu-item");
        it.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        it.addEventListener("click", () => { pop.remove(); fn(); });
        scroll.appendChild(it);
      };
      addItem("💡", "讲解", () => this.aiBlockAction(blk, "explain"));
      addItem("➕", "扩写", () => this.aiBlockAction(blk, "expand"));
      addItem("➖", "缩写", () => this.aiBlockAction(blk, "shorten"));
      addItem("🔁", "重写", () => this.aiBlockAction(blk, "rewrite"));
      const textTypes = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout"];
      if (textTypes.includes(blk.type)) {
        addItem("🔢", "转为有序列表", () => this.aiBlockToList(blk, "numbered"));
        addItem("⚫", "转为无序列表", () => this.aiBlockToList(blk, "bullet"));
      }
      addItem("🧩", "生成交互网页", () => this.aiGenerateHTML(blk));
      pop.style.position = "fixed";
      pop.style.left = x + "px";
      pop.style.top = y + "px";
      pop.style.display = "flex";
      document.body.appendChild(pop);
      const r = pop.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
      pop.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    async aiBlockAction(blk, action) {
      const text = this.blockText(blk);
      if (!text.trim()) { U.toast(U.t("这个块没有可处理的文字")); return; }
      if (!global.AI) { U.toast("AI 模块未就绪"); return; }
      if (action === "explain") {
        AI.toggle(true);
        AI.pushMessage("user", "💡 讲解这个块：\"" + U.preview([{ t: text }], 60) + "\"");
        await AI.streamAssistant("请用通俗、清晰的方式讲解下面这段内容的核心概念和要点，可适当举例。\n\n" + text, true);
        return;
      }

      // 重写：先询问重写要求
      let requirement = "";
      if (action === "rewrite") {
        const req = await U.promptModal({ title: U.t("重写要求"), placeholder: "例如：更正式、更简洁、面向初学者、更像学术论文…", value: "" });
        if (req == null) return; // 取消
        requirement = req.trim();
      }

      const label = { expand: "扩写", shorten: "缩写", rewrite: "重写" }[action] || "处理";
      const styleHint = "可以适当使用 Markdown 标记（**加粗**、*斜体*、`代码`、~~删除线~~）和行内 LaTeX 公式（$...$，公式前后留空格）来突出重点；不要输出标题、列表符号或任何解释文字。";
      const prompt =
        action === "expand" ? "请把下面这段内容扩写得更详细：补充细节、例子或解释，保持原意。" + styleHint :
        action === "shorten" ? "请把下面这段内容缩写：提炼核心要点，去掉冗余，保留关键信息。" + styleHint :
        "请重写下面这段内容" + (requirement ? "，要求：" + requirement : "") + "：换一种更符合要求的表达，保持原意不变。" + styleHint;
      AI.toggle(true);
      await AI.proposeDraft(label + "这个块", prompt + "\n\n原文：\n" + text, (result) => {
        const count = this.splitBlockResult(blk, result);
        S.touch(this.page); S.markDirty();
        this.refresh();
        U.toast(count > 1 ? (U.t("已") + label + "（拆分为 " + count + " 个块）") : "已" + label);
      });
    },

    /** 把 AI 返回的 Markdown 按行拆成一个或多个块，替换原块 */
    splitBlockResult(blk, md) {
      const text = String(md == null ? "" : md).trim();
      if (!text) return 0;
      const lines = text.split("\n").filter(l => l.trim());
      if (lines.length <= 1) {
        this.setBlockText(blk, text);
        return 1;
      }
      return this.replaceBlockWithMany(blk, text);
    },

    /** 用 Markdown 生成多个块并替换原块；返回创建的块数量 */
    replaceBlockWithMany(blk, md) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return 0;
      const blocks = (global.AI && AI.markdownToBlocks ? AI.markdownToBlocks(md) : null) || [];
      if (!blocks.length) { this.setBlockText(blk, md); return 1; }
      const newBlocks = blocks.map(b => {
        const nb = S.newBlock(b.type);
        if (b.type !== "divider" && b.segments && b.segments.length) nb.text = b.segments;
        return nb;
      });
      pos.list.splice(pos.index, 1, ...newBlocks);
      return newBlocks.length;
    },

    /** 把文本块改写成有序/无序列表（AI 生成，按项拆成多个列表块） */
    async aiBlockToList(blk, listType) {
      const text = this.blockText(blk);
      if (!text.trim()) { U.toast(U.t("这个块没有可处理的文字")); return; }
      if (!global.AI) { U.toast("AI 模块未就绪"); return; }
      const label = listType === "numbered" ? "转为有序列表" : "转为无序列表";
      const marker = listType === "numbered" ? "每行以「1. 」「2. 」这样的数字编号开头" : "每行以「- 」开头";
      const prompt = "请把下面这段内容整理成" + (listType === "numbered" ? "有序列表" : "无序列表") + "，每条一个要点、独立成行，并按 Markdown 列表语法输出（" + marker + "）；不要输出标题或任何解释文字，只输出列表本身。\n\n原文：\n" + text;
      AI.toggle(true);
      await AI.proposeDraft(label, prompt, (result) => {
        const count = this.replaceBlockWithMany(blk, result);
        S.touch(this.page); S.markDirty();
        this.refresh();
        U.toast(count > 1 ? (label + "（" + count + " 项）") : "已" + label);
      });
    },

    /** 生成可交互 HTML 网页并作为块嵌入当前块下方 */
    async aiGenerateHTML(blk) {
      const page = this.page;
      if (!page || !global.AI) { U.toast("AI 模块未就绪"); return; }
      const topic = await U.promptModal({ title: U.t("生成交互网页"), placeholder: "要可视化教学的主题，如：勾股定理 / 傅里叶变换 / 二分查找…", value: this.blockText(blk) });
      if (topic == null || !topic.trim()) return;
      AI.toggle(true);
      AI.pushMessage("user", "🧩 生成交互网页：\"" + topic.trim() + "\"");
      AI.showThinking();
      const html = await AI.generateHTML(topic.trim());
      AI.hideThinking();
      if (!html || !html.trim()) { U.toast("AI 没有返回 HTML"); return; }
      // 提取 HTML 文档，去掉可能的代码块标记或多余文字
      let src = html.trim();
      src = src.replace(/^```(?:html|HTML)?\s*/m, "").replace(/```\s*$/m, "");
      const doc = src.match(/<!DOCTYPE html>[\s\S]*<\/html>/i);
      if (doc) src = doc[0];
      const pos = S.findBlockPos(page, blk.id);
      const nb = S.newBlock("html");
      nb.attrs.source = src;
      pos.list.splice(pos.index + 1, 0, nb);
      S.touch(page); S.markDirty();
      this.refresh({ id: nb.id });
      U.toast(U.t("已生成交互网页"));
    },

    /** 编辑 HTML 块源码 */
    editHTML(blk) {
      const modal = U.modal({ title: "编辑 HTML 源码", size: "lg" });
      const ta = U.el("textarea", "html-edit-ta");
      ta.value = blk.attrs.source || "";
      ta.spellcheck = false;
      modal.body.appendChild(ta);
      const save = U.el("button", "db-btn primary", "保存");
      const cancel = U.el("button", "db-btn", U.t("取消"));
      save.addEventListener("click", () => {
        blk.attrs.source = ta.value;
        S.touch(this.page); S.markDirty();
        this.refresh({ id: blk.id });
        modal.close();
      });
      cancel.addEventListener("click", () => modal.close());
      modal.foot.appendChild(cancel); modal.foot.appendChild(save);
      setTimeout(() => ta.focus(), 30);
    },

    /** 用 AI 修复 mermaid / html 等需渲染块的源码（用户描述问题） */
    async aiFixBlock(blk) {
      const source = (blk.attrs && blk.attrs.source) || "";
      if (!source.trim()) { U.toast(U.t("这个块没有可修复的源码")); return; }
      if (!global.AI) { U.toast("AI 模块未就绪"); return; }
      const kindName = blk.type === "mermaid" ? "Mermaid 图表" : blk.type === "html" ? "交互网页 HTML" : "代码";
      const problem = await U.promptModal({ title: U.t("修复 ") + kindName, placeholder: "描述问题，例如：图表渲染不出来 / 语法报错 / 想改成更简洁的样式…" });
      if (problem == null || !problem.trim()) return;
      AI.toggle(true);
      AI.pushMessage("user", "🛠 修复" + kindName + "：" + problem.trim());
      AI.showThinking();
      let result = "";
      try {
        const resp = await AI.chatRequest([{ role: "user", content: "下面是一个" + kindName + "的源码，存在问题：「" + problem.trim() + "」。请修复它，只输出修复后的完整源码，不要任何解释、Markdown 代码块标记（```）或前后缀。\n\n当前源码：\n" + source }]);
        result = (resp && resp.content) || "";
      } catch (e) { /* 已在下方提示 */ }
      AI.hideThinking();
      if (!result || !result.trim()) { U.toast("AI 没有返回结果"); return; }
      let fixed = result.trim();
      fixed = fixed.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "");
      blk.attrs.source = fixed;
      S.touch(this.page); S.markDirty();
      this.refresh({ id: blk.id });
      U.toast("已修复 " + kindName);
    },

    /* ================= Block actions menu ================= */
    openBlockMenu(blockId, x, y) {
      const page = this.page;
      const blk = S.findBlock(page, blockId);
      if (!blk) return;
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const addItem = (icon, label, fn, danger) => {
        const it = U.el("div", "menu-item" + (danger ? " danger" : ""));
        it.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        it.addEventListener("click", () => { pop.remove(); fn(); });
        scroll.appendChild(it);
        return it;
      };
      const sep = () => scroll.appendChild(U.el("div", "menu-sep"));

      addItem("➕", "在上方插入", () => this.insertSibling(blk, true));
      addItem("➕", "在下方插入", () => this.insertSibling(blk, false));
      sep();
      addItem("🔄", "转换为…", () => this.openTurnInto(blk, x, y));
      addItem("⬆️", "上移", () => this.moveSibling(blk, -1));
      addItem("⬇️", "下移", () => this.moveSibling(blk, 1));
      sep();
      if (blk.type === "table") {
        addItem("🆕", "添加行", () => this.tableOp(blk, "addRow"));
        addItem("🆕", "添加列", () => this.tableOp(blk, "addCol"));
        addItem("🗑", "删除最后一行", () => this.tableOp(blk, "delRow"));
        addItem("▤", blk.attrs.header ? "关闭表头" : "开启表头", () => { blk.attrs.header = !blk.attrs.header; S.markDirty(); this.refresh({ id: blk.id }); });
        sep();
      }
      if (blk.type === "columns") {
        addItem("▥", "设置栏数", () => this.setColumnsCount(blk));
        sep();
      }
      if (blk.type === "snippet") {
        if (blk.attrs.pageId) {
          addItem("🔗", "清除代码文件关联", () => { delete blk.attrs.pageId; S.touch(page); S.markDirty(); this.refresh({ id: blk.id }); });
        } else {
          addItem("⌨", "关联代码文件", () => this.linkSnippet(blk));
        }
        sep();
      }
      if (blk.type === "html") {
        addItem("🛠", "用 AI 修复", () => this.aiFixBlock(blk));
        addItem("✏️", "编辑 HTML 源码", () => this.editHTML(blk));
        addItem("🧩", "用 AI 重新生成", () => this.aiGenerateHTML(blk));
        sep();
      }
      if (blk.type === "mermaid") {
        addItem("🛠", "用 AI 修复", () => this.aiFixBlock(blk));
        sep();
      }
      addItem("⧉", "复制块", () => this.duplicateBlock(blk));
      addItem("✂️", "剪切", () => { this._clipboard = U.clone(blk); this.deleteBlock(blk); U.toast(U.t("已剪切")); });
      if (this._clipboard) addItem("📋", "粘贴", () => this.pasteClipboard(blk));
      addItem("🔗", "复制块链接", () => {
        U.copyText(location.origin + location.pathname + "#" + page.id + "-" + blk.id);
        U.toast(U.t("块链接已复制"));
      });
      addItem("📦", "移至其他页面", () => this.moveBlockToPage(blk));
      addItem("💬", "评论 (" + (blk.comments ? blk.comments.length : 0) + ")", () => this.openComments(blk));
      sep();
      addItem("🗑", "删除", () => this.deleteBlock(blk), true);

      pop.style.position = "fixed";
      pop.style.left = x + "px";
      pop.style.top = y + "px";
      pop.style.display = "flex";
      document.body.appendChild(pop);
      const r = pop.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
      pop.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },

    createColumnsBlock(cols) {
      const nb = S.newBlock("columns");
      nb.children = [];
      for (let i = 0; i < (cols || 2); i++) {
        const col = S.newBlock("column");
        col.children = [];
        nb.children.push(col);
      }
      return nb;
    },

    async setColumnsCount(blk) {
      const page = this.page;
      const cur = (blk.children || []).length || 2;
      const n = parseInt(await U.promptModal({ title: U.t("设置栏数"), value: String(cur), placeholder: "2-4" }), 10);
      if (!n || n < 2 || n > 4 || n === cur) return;
      blk.children = blk.children || [];
      if (n > cur) {
        for (let i = cur; i < n; i++) {
          const col = S.newBlock("column");
          col.children = [];
          blk.children.push(col);
        }
      } else {
        const removed = blk.children.splice(n);
        removed.forEach(col => { if (col.children && col.children.length) blk.children[0].children = blk.children[0].children.concat(col.children); });
      }
      S.touch(page); S.markDirty();
      this.refresh({ id: blk.id });
    },

    insertSibling(blk, above) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      const nb = S.newBlock("paragraph");
      pos.list.splice(pos.index + (above ? 0 : 1), 0, nb);
      S.touch(page); S.markDirty();
      this.refresh({ id: nb.id, offset: 0 });
    },

    moveSibling(blk, dir) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      const target = pos.index + dir;
      if (target < 0 || target >= pos.list.length) return;
      pos.list.splice(pos.index, 1);
      pos.list.splice(target, 0, blk);
      S.touch(page); S.markDirty();
      this.refresh({ id: blk.id });
    },

    duplicateBlock(blk) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      const copy = U.clone(blk);
      copy.id = U.uid("blk");
      const remap = (b) => {
        b.children.forEach(c => { c.id = U.uid("blk"); remap(c); });
      };
      remap(copy);
      pos.list.splice(pos.index + 1, 0, copy);
      S.touch(page); S.markDirty();
      this.refresh({ id: copy.id });
    },

    pasteClipboard(blk) {
      const page = this.page;
      if (!this._clipboard) return;
      const pos = S.findBlockPos(page, blk.id);
      const copy = U.clone(this._clipboard);
      copy.id = U.uid("blk");
      const remap = (b) => { b.children.forEach(c => { c.id = U.uid("blk"); remap(c); }); };
      remap(copy);
      pos.list.splice(pos.index + 1, 0, copy);
      S.touch(page); S.markDirty();
      this.refresh({ id: copy.id });
    },

    deleteBlock(blk) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      const prev = pos.index > 0 ? pos.list[pos.index - 1] : null;
      pos.list.splice(pos.index, 1);
      S.touch(page); S.markDirty();
      this.refresh();
      if (prev) this.focusBlock(prev.id, 0);
    },

    tableOp(blk, op, index) {
      const res = S.tableMutate(blk.attrs.rows, blk.attrs.cols, op, index);
      blk.attrs.rows = res.rows;
      blk.attrs.cols = res.cols;
      S.markDirty();
      this.refresh({ id: blk.id });
    },

    tableEnter(blk, cellEl) {
      const page = this.page;
      const row = parseInt(cellEl.dataset.row, 10);
      const col = parseInt(cellEl.dataset.col, 10);
      const nextRow = row + 1;
      let nextEl = this.blocksEl.querySelector('.b-table .ed[data-block-id="' + blk.id + '"][data-row="' + nextRow + '"][data-col="' + col + '"]');
      if (!nextEl) {
        const res = S.tableMutate(blk.attrs.rows, blk.attrs.cols, "addRow");
        blk.attrs.rows = res.rows;
        blk.attrs.cols = res.cols;
        S.markDirty();
        this.refresh({ id: blk.id });
        nextEl = this.blocksEl.querySelector('.b-table .ed[data-block-id="' + blk.id + '"][data-row="' + nextRow + '"][data-col="' + col + '"]');
      }
      if (nextEl) { nextEl.focus(); B.setCaret(nextEl, 0); }
    },

    renderMermaid(blk) {
      const blockEl = this.blocksEl ? this.blocksEl.querySelector('.block[data-block-id="' + blk.id + '"]') : null;
      if (!blockEl) return;
      const ta = blockEl.querySelector(".mm-edit");
      const preview = blockEl.querySelector(".mm-preview");
      const err = blockEl.querySelector(".mm-error");
      const btn = blockEl.querySelector(".mm-btn");
      const source = blk.attrs.source || "";
      btn.disabled = true;
      MermaidR.ready(() => {
        MermaidR.render(source).then(res => {
          btn.disabled = false;
          if (res.ok) {
            preview.innerHTML = res.svg;
            preview.hidden = false;
            ta.hidden = true;
            err.hidden = true;
          } else {
            preview.hidden = true;
            ta.hidden = false;
            err.textContent = "渲染失败：" + res.error;
            err.hidden = false;
          }
        });
      });
    },

    toggleMermaidEdit(blk) {
      const blockEl = this.blocksEl ? this.blocksEl.querySelector('.block[data-block-id="' + blk.id + '"]') : null;
      if (!blockEl) return;
      const ta = blockEl.querySelector(".mm-edit");
      const preview = blockEl.querySelector(".mm-preview");
      const err = blockEl.querySelector(".mm-error");
      ta.hidden = false;
      preview.hidden = true;
      err.hidden = true;
      ta.focus();
    },

    /** 页面渲染后自动渲染所有有源码的 Mermaid 图表 */
    autoRenderMermaids(page) {
      const walk = blocks => (blocks || []).forEach(b => {
        if (b.type === "mermaid" && b.attrs && b.attrs.source && String(b.attrs.source).trim()) {
          this.renderMermaid(b);
        }
        if (b.children && b.children.length) walk(b.children);
      });
      walk(page.children);
      // 刷新后 Mermaid 库异步加载：加载完成后重新渲染一次（防重复挂钩）
      if (global.MermaidR && !MermaidR.isLoaded()) {
        if (!this._mmReadyHooked) {
          this._mmReadyHooked = true;
          MermaidR.ready(() => {
            this._mmReadyHooked = false;
            if (this.page) this.autoRenderMermaids(this.page);
          });
        }
      }
    },

    moveBlockToPage(blk) {
      const page = this.page;
      this.openPagePicker((target) => {
        const pos = S.findBlockPos(page, blk.id);
        pos.list.splice(pos.index, 1);
        const tp = S.getPage(target.id);
        if (tp) tp.children.push(blk);
        S.touch(page); S.touch(tp); S.markDirty();
        this.refresh();
        U.toast("已移动到「" + (U.segsText(tp.title) || "未命名") + "」");
      });
    },

    /* ---------- template button ---------- */
    insertTemplate(blk) {
      const page = this.page;
      const pos = S.findBlockPos(page, blk.id);
      if (!pos) return;
      const remap = (b) => { b.id = U.uid("blk"); (b.children || []).forEach(remap); };
      const copies = (blk.children || []).map(c => { const copy = U.clone(c); remap(copy); return copy; });
      if (!copies.length) { U.toast("模板还没有内容，先点击「＋ 子项」添加"); return; }
      pos.list.splice(pos.index + 1, 0, ...copies);
      S.touch(page); S.markDirty();
      this.refresh({ id: copies[0].id, offset: 0 });
    },

    /* ---------- comments ---------- */
    openComments(blk) {
      const page = this.page;
      const modal = U.modal({ title: "评论", onClose: () => this.refresh() });
      blk.comments = blk.comments || [];
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const render = () => {
        U.clear(list);
        if (!blk.comments.length) {
          const e = U.el("div", "empty-state");
          e.style.padding = "20px";
          e.textContent = "还没有评论";
          list.appendChild(e);
        }
        blk.comments.forEach(c => {
          const item = U.el("div", "comment-item");
          const head = U.el("div", "comment-head");
          head.innerHTML = '<span class="cm-author">🙂 我</span><span class="cm-time">' + U.fmtDate(c.createdAt) + '</span>';
          const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
          del.title = "删除评论";
          del.addEventListener("click", () => {
            blk.comments = blk.comments.filter(x => x !== c);
            S.touch(page); S.markDirty();
            render();
          });
          head.appendChild(del);
          const body = U.el("div", "cm-body", U.esc(c.text));
          item.appendChild(head); item.appendChild(body);
          list.appendChild(item);
        });
      };
      render();
      const ta = U.el("textarea", "modal-input");
      ta.style.minHeight = "60px";
      ta.placeholder = "写下评论…";
      modal.body.appendChild(ta);
      const foot = U.el("div", null);
      const send = U.el("button", "db-btn primary", U.t("发表"));
      send.addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) return;
        blk.comments.push({ id: U.uid("cm"), text, createdAt: Date.now() });
        ta.value = "";
        S.touch(page); S.markDirty();
        render();
      });
      foot.appendChild(send);
      modal.foot.appendChild(foot);
    },

    openTurnInto(blk, x, y) {
      const page = this.page;
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const types = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout", "divider", "code", "equation", "table", "toc", "breadcrumb", "template"];
      types.forEach(t => {
        const def = B.BLOCK_TYPES[t];
        if (!def) return;
        const it = U.el("div", "menu-item" + (t === blk.type ? " sel" : ""));
        it.innerHTML = '<span class="mi-ico">' + def.icon + '</span><span class="mi-label">' + U.esc(def.label) + '</span>';
        it.addEventListener("click", () => {
          const oldType = blk.type;
          blk.type = t;
          if (t === "todo") blk.checked = blk.checked || false;
          if (t === "code" && !blk.attrs.source) blk.attrs.source = U.segsText(blk.text);
          if (t === "table" && !blk.attrs.rows) {
            blk.attrs.cols = 3; blk.attrs.header = true;
            blk.attrs.rows = [[], [], []].map(() => [{ t: "" }, { t: "" }, { t: "" }]);
            blk.text = [];
          }
          if (t === "callout" && !blk.attrs.icon) blk.attrs.icon = "💡";
          if (oldType === "toggle" && t !== "toggle" && t !== "template") {
            // 转换为不使用 children 的类型时，把子块移到本块之后，避免静默丢弃
            if (blk.children && blk.children.length) {
              const tpos = S.findBlockPos(page, blk.id);
              if (tpos) tpos.list.splice(tpos.index + 1, 0, ...blk.children);
            }
            blk.children = [];
          }
          S.markDirty();
          pop.remove();
          this.refresh({ id: blk.id, offset: 0 });
        });
        scroll.appendChild(it);
      });
      pop.style.position = "fixed";
      pop.style.left = x + "px";
      pop.style.top = y + "px";
      pop.style.display = "flex";
      document.body.appendChild(pop);
      document.addEventListener("mousedown", function h(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
      });
    },
  };

  /* ---------- segment slicing ---------- */
  function sliceSegments(segs, start, end) {
    segs = segs || [];
    if (end == null) end = Infinity;
    const out = [];
    let pos = 0;
    for (const s of segs) {
      const len = (s.t || "").length;
      const sStart = pos, sEnd = pos + len;
      if (len === 0) {
        // zero-length segments (e.g. inline math): assign to exactly one slice
        if (end === Infinity ? pos >= start : (pos >= start && pos < end)) out.push(Object.assign({}, s));
      } else if (sEnd > start && sStart < end) {
        const from = Math.max(0, start - sStart);
        const to = Math.min(len, end - sStart);
        out.push(Object.assign({}, s, { t: s.t.slice(from, to) }));
      }
      pos = sEnd;
    }
    return out;
  }
  Blocks.sliceSegments = sliceSegments;

  global.Editor = Editor;
})(window);
