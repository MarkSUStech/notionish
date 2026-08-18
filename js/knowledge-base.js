/* ============ 知识库：文件系统视图、上传、网址、笔记、RAG ============ */
(function (global) {
  "use strict";

  const request = async (url, options) => {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ("请求失败：" + response.status));
    return body;
  };

  const KIND_LABEL = { text: "文本", url: "网址", note: "笔记" };
  const KIND_ICON = { text: "📄", url: "🌐", note: "📝" };

  const KnowledgeBase = {
    /** kbId 为空则显示知识库列表 */
    async render(kbId) {
      const content = document.getElementById("content");
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll kb-scroll");
      scroll.style.maxWidth = "820px";
      content.appendChild(scroll);
      if (kbId) await this.renderKb(scroll, kbId);
      else await this.renderList(scroll);
    },

    async renderList(scroll) {
      const head = U.el("div", "kb-head");
      const copy = U.el("div", "kb-head-copy");
      copy.appendChild(U.el("div", "settings-title", "知识库"));
      copy.appendChild(U.el("div", "settings-section-desc", "创建知识库，上传资料、网址或笔记，AI 可在此检索（RAG）。支持代码、文本、网页、PDF（提取文字）等。"));
      const add = U.el("button", "db-btn primary", "＋ 新建知识库");
      add.addEventListener("click", () => this.createKb());
      head.appendChild(copy);
      head.appendChild(add);
      scroll.appendChild(head);

      const list = U.el("div", "kb-list");
      scroll.appendChild(list);
      try {
        const j = await request("/api/kb/list");
        const kbs = j.kbs || [];
        if (!kbs.length) {
          list.appendChild(U.el("div", "empty-state", "还没有知识库。点击「新建知识库」创建第一个。"));
          return;
        }
        kbs.forEach(k => {
          const row = U.el("div", "kb-row");
          row.innerHTML = '<span class="kb-ico">🗄</span><span class="kb-name">' + U.esc(k.name) + "</span>";
          row.addEventListener("click", () => { location.hash = "kb/" + k.id; });
          list.appendChild(row);
        });
      } catch (e) {
        list.appendChild(U.el("div", "empty-state", "加载失败：" + e.message + "（请用 node server.js 启动本应用）"));
      }
    },

    async renderKb(scroll, kbId) {
      try {
        const [kbRes, docsRes] = await Promise.all([
          request("/api/kb/list"),
          request("/api/kb/" + encodeURIComponent(kbId)),
        ]);
        const kb = (kbRes.kbs || []).find(k => k.id === kbId);
        const name = kb ? kb.name : "知识库";

        const head = U.el("div", "kb-head");
        const back = U.el("button", "db-btn", "← 知识库列表");
        back.addEventListener("click", () => { location.hash = "kb"; });
        head.appendChild(back);
        head.appendChild(U.el("div", "settings-title", U.esc(name)));
        const reindex = U.el("button", "db-btn", "🔄 重建索引");
        reindex.addEventListener("click", () => this.reindex(kbId));
        head.appendChild(reindex);
        const del = U.el("button", "db-btn danger", "删除库");
        del.addEventListener("click", () => this.removeKb(kbId));
        head.appendChild(del);
        scroll.appendChild(head);

        const addBar = U.el("div", "kb-addbar");
        const upBtn = U.el("button", "db-btn primary", "📁 上传文件");
        upBtn.addEventListener("click", () => this.uploadFile(kbId));
        const urlBtn = U.el("button", "db-btn", "🌐 添加网址");
        urlBtn.addEventListener("click", () => this.addUrl(kbId));
        const noteBtn = U.el("button", "db-btn", "📝 添加当前笔记");
        noteBtn.addEventListener("click", () => this.addCurrentNote(kbId, name));
        addBar.appendChild(upBtn);
        addBar.appendChild(urlBtn);
        addBar.appendChild(noteBtn);
        scroll.appendChild(addBar);

        const list = U.el("div", "kb-list");
        const docs = docsRes.docs || [];
        if (!docs.length) {
          list.appendChild(U.el("div", "empty-state", "还没有资料。上传文件、添加网址，或把笔记添加进来。"));
        }
        docs.forEach(d => list.appendChild(this.renderDoc(kbId, d)));
        scroll.appendChild(list);
      } catch (e) {
        scroll.appendChild(U.el("div", "empty-state", "加载失败：" + e.message));
      }
    },

    renderDoc(kbId, d) {
      const row = U.el("div", "kb-doc");
      const ico = U.el("span", "kb-ico", KIND_ICON[d.kind] || "📄");
      row.appendChild(ico);
      const name = U.el("span", "kb-doc-name", U.esc(d.name));
      name.style.cursor = "pointer";
      name.title = "点击预览";
      name.addEventListener("click", () => this.previewDoc(kbId, d));
      row.appendChild(name);
      row.appendChild(U.el("span", "kb-doc-kind", U.esc(KIND_LABEL[d.kind] || d.kind)));
      row.appendChild(U.el("span", "kb-doc-status " + (d.indexed ? "ok" : "warn"), d.indexed ? "已索引" : "未索引"));

      const del = U.el("button", "icon-btn", "🗑");
      del.title = "删除";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (await U.confirmModal("删除资料", "确定删除「" + d.name + "」吗？", "删除")) {
          try { await this.removeDoc(kbId, d.id); this.render(kbId); }
          catch (err) { U.toast("删除失败：" + err.message); }
        }
      });
      row.appendChild(del);
      return row;
    },

    /** 预览单个文档：网址直接渲染网页，其它显示正文 */
    async previewDoc(kbId, d) {
      try {
        const j = await request("/api/kb/" + encodeURIComponent(kbId) + "/docs/" + encodeURIComponent(d.id));
        const doc = j.doc || d;
        const modal = U.modal({ title: doc.name || "预览", size: "xl" });
        modal.el.classList.add("kb-preview");
        const meta = U.el("div", "kb-preview-meta", (KIND_LABEL[doc.kind] || doc.kind) + (doc.url ? " · " + doc.url : ""));
        modal.body.appendChild(meta);
        if (doc.url) {
          const bar = U.el("div", "kb-preview-actions");
          const open = U.el("a", "db-btn", "↗ 在新标签打开");
          open.href = doc.url;
          open.target = "_blank";
          open.rel = "noopener noreferrer";
          const save = U.el("button", "db-btn primary", "💾 保存为笔记");
          save.addEventListener("click", () => { modal.close(); this.saveWebAsNote(doc.url); });
          const toggle = U.el("button", "db-btn", "📄 查看提取正文");
          bar.appendChild(open);
          bar.appendChild(save);
          bar.appendChild(toggle);
          modal.body.appendChild(bar);
          const frame = U.el("iframe", "kb-preview-frame");
          frame.src = doc.url;
          frame.setAttribute("loading", "lazy");
          frame.setAttribute("sandbox", "allow-same-origin allow-scripts allow-popups");
          modal.body.appendChild(frame);
          const text = U.el("pre", "kb-preview-text");
          text.textContent = doc.text || "（无正文内容）";
          text.hidden = true;
          toggle.addEventListener("click", () => {
            text.hidden = !text.hidden;
            frame.hidden = !text.hidden;
            toggle.textContent = text.hidden ? "📄 查看提取正文" : "🌐 查看网页";
          });
          modal.body.appendChild(text);
        } else {
          const text = U.el("pre", "kb-preview-text");
          text.textContent = doc.text || "（无正文内容）";
          modal.body.appendChild(text);
        }
      } catch (e) {
        U.toast("预览失败：" + e.message);
      }
    },

    /** 抓取网页正文并保存为一个独立笔记页面 */
    async saveWebAsNote(url) {
      try {
        const res = await request("/api/web/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const markdown = (res.markdown || "").trim();
        if (!markdown) { U.toast("网页正文为空，无法保存"); return; }
        const title = res.title || "网页笔记";
        const pageRes = global.Bridge.execute("page.create", { title, icon: "🌐" });
        if (!pageRes.ok) { U.toast("创建笔记失败：" + pageRes.error); return; }
        const pageId = pageRes.result.id;
        const S = global.Store;
        const page = S.getPage(pageId);
        if (!page) return;
        const srcBlk = S.newBlock("bookmark");
        srcBlk.attrs = { url, title: res.title || url };
        S.insertBlock(page, srcBlk, page.children.length);
        // markdown → 结构化块（标题/加粗/斜体/代码/列表/引用/图片）
        const AI = global.AI;
        const blocks = (AI && AI.markdownToBlocks) ? AI.markdownToBlocks(markdown) : [];
        blocks.forEach(b => {
          const blk = S.newBlock(b.type);
          if (b.segments && b.segments.length) blk.text = b.segments;
          if (b.attrs && typeof b.attrs === "object") Object.assign(blk.attrs, b.attrs);
          S.insertBlock(page, blk, page.children.length);
        });
        S.touch(page);
        S.markDirty();
        S.save(true);
        if (global.App) App.openPage(pageId);
        U.toast("已保存为笔记");
      } catch (e) {
        U.toast("保存为笔记失败：" + (e.message || String(e)));
      }
    },

    async createKb() {
      const name = await U.promptModal({ title: U.t("新建知识库"), placeholder: U.t("知识库名称"), value: "" });
      if (!name || !name.trim()) return;
      try {
        const j = await request("/api/kb/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
        location.hash = "kb/" + j.kb.id;
        U.toast(U.t("已创建知识库"));
      } catch (e) { U.toast(U.t("创建失败：") + e.message); }
    },

    async removeKb(kbId) {
      if (!(await U.confirmModal("删除知识库", "确定删除整个知识库及其全部资料吗？此操作不可撤销。", "删除"))) return;
      try {
        await request("/api/kb/" + encodeURIComponent(kbId), { method: "DELETE" });
        location.hash = "kb";
        U.toast("知识库已删除");
      } catch (e) { U.toast("删除失败：" + e.message); }
    },

    async uploadFile(kbId) {
      const inp = U.el("input");
      inp.type = "file";
      inp.accept = ".txt,.md,.markdown,.json,.csv,.html,.htm,.js,.ts,.tsx,.jsx,.py,.c,.cpp,.cc,.java,.go,.rs,.css,.xml,.yaml,.yml,.log,.sql,.sh,.bat,.pdf";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        try {
          let text = "";
          if (/\.pdf$/i.test(f.name)) {
            text = await this.extractPdfText(f);
            if (!text.trim()) { U.toast("无法从该 PDF 提取文字（可能是扫描件）"); return; }
          } else {
            text = await f.text();
            if (!text.trim()) { U.toast("文件内容为空"); return; }
          }
          await request("/api/kb/" + encodeURIComponent(kbId) + "/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, kind: "text", text }) });
          this.render(kbId);
          U.toast("已添加到知识库");
        } catch (e) { U.toast("上传失败：" + e.message); }
      };
      inp.click();
    },

    async extractPdfText(file) {
      try {
        const lib = global.pdfjsLib;
        if (!lib) return "";
        const buf = await file.arrayBuffer();
        const doc = await lib.getDocument({ data: buf }).promise;
        let text = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        return text;
      } catch (e) { return ""; }
    },

    async addUrl(kbId) {
      const url = await U.promptModal({ title: U.t("添加网址"), placeholder: "https://example.com/...", value: "https://" });
      if (!url || !url.trim()) return;
      try {
        await request("/api/kb/" + encodeURIComponent(kbId) + "/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: url.trim(), kind: "url", url: url.trim() }) });
        this.render(kbId);
        U.toast("已抓取网页正文并添加到知识库");
      } catch (e) { U.toast("添加失败：" + e.message); }
    },

    /** 把当前打开的笔记页面文本添加到知识库 */
    async addCurrentNote(kbId, kbName) {
      const S = global.Store;
      const pageId = S.currentPageId;
      const page = pageId ? S.getPage(pageId) : null;
      if (!page) { U.toast("请先打开一个页面，再把它添加到知识库"); return; }
      const lines = [];
      const walk = blocks => (blocks || []).forEach(b => {
        const t = U.segsText(b.text);
        if (t && t.trim()) lines.push(t.trim());
        if (b.children && b.children.length) walk(b.children);
      });
      walk(page.children);
      const text = lines.join("\n");
      if (!text.trim()) { U.toast("这个页面没有可添加的文字内容"); return; }
      try {
        await request("/api/kb/" + encodeURIComponent(kbId) + "/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: (U.segsText(page.title) || "未命名笔记") + "（笔记）", kind: "note", text }) });
        this.render(kbId);
        U.toast("已把笔记添加到知识库");
      } catch (e) { U.toast("添加失败：" + e.message); }
    },

    async removeDoc(kbId, docId) {
      await request("/api/kb/" + encodeURIComponent(kbId) + "/docs/" + encodeURIComponent(docId), { method: "DELETE" });
    },

    async reindex(kbId) {
      try {
        const j = await request("/api/kb/" + encodeURIComponent(kbId) + "/reindex", { method: "POST" });
        this.render(kbId);
        U.toast("已重建索引（" + (j.count || 0) + " 个文档）");
      } catch (e) { U.toast("重建失败：" + e.message); }
    },
  };

  global.KnowledgeBase = KnowledgeBase;
})(window);
