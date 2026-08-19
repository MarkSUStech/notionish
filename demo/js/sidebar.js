/* ============ Sidebar: page tree, favorites, search, trash ============ */
(function (global) {
  "use strict";

  const S = Store;

  const Sidebar = {
    expanded: null, // Set of explicitly expanded page ids
    searchMode: false,
    _drag: null,
    _navTimer: null,

    init() {
      this.expanded = new Set();
      const tree = document.getElementById("sb-tree");
      this.treeEl = tree;
      // 私人页面折叠/展开
      const pagesTitle = document.getElementById("sb-pages-title");
      if (pagesTitle) {
        pagesTitle.addEventListener("click", () => {
          const collapsed = tree.style.display === "none";
          tree.style.display = collapsed ? "" : "none";
          pagesTitle.textContent = collapsed ? "▼ 私人页面" : "▶ 私人页面";
          localStorage.setItem("notionish_pages_folded", collapsed ? "0" : "1");
        });
        if (localStorage.getItem("notionish_pages_folded") === "1") {
          tree.style.display = "none";
          pagesTitle.textContent = "▶ 私人页面";
        }
      }
      this.bindEvents();
      this.render();
    },

    bindEvents() {
      const tree = document.getElementById("sb-tree");
      tree.addEventListener("click", (e) => this.onTreeClick(e));
      tree.addEventListener("dragover", (e) => this.onTreeDragOver(e));
      tree.addEventListener("drop", (e) => this.onTreeDrop(e));
      tree.addEventListener("dragend", () => this.onTreeDragEnd());
      tree.addEventListener("mousedown", (e) => this.onTreeMouseDown(e));
      tree.addEventListener("dblclick", (e) => this.onTreeDblClick(e));

      document.getElementById("sb-new").addEventListener("click", (e) => this.openCreateMenu(e.currentTarget));
      document.getElementById("sb-brand").addEventListener("click", () => App.goHome());
      document.getElementById("sb-collapse").addEventListener("click", () => {
        document.body.classList.toggle("sb-closed");
        localStorage.setItem("notionish_sb", document.body.classList.contains("sb-closed") ? "1" : "0");
      });
      if (localStorage.getItem("notionish_sb") === "1") document.body.classList.add("sb-closed");

      const searchInput = document.getElementById("sb-search-input");
      searchInput.addEventListener("input", () => this.render());
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && searchInput.value.trim()) {
          App.openSearchModal(searchInput.value.trim());
        }
        if (e.key === "Escape") { searchInput.value = ""; this.render(); }
      });
      searchInput.addEventListener("click", (e) => e.stopPropagation());

      document.getElementById("sb-questions").addEventListener("click", () => { location.hash = "questions"; });
      document.getElementById("sb-kb-add").addEventListener("click", () => {
        location.hash = "kb";
        if (global.KnowledgeBase) setTimeout(() => KnowledgeBase.createKb(), 60);
      });
      document.getElementById("sb-export").addEventListener("click", () => App.exportAll());
      document.getElementById("sb-import").addEventListener("click", () => document.getElementById("import-file").click());
      document.getElementById("import-file").addEventListener("change", (e) => App.importFile(e));
      document.getElementById("sb-theme").addEventListener("click", () => App.toggleTheme());
    },

    openCreateMenu(anchor) {
      const pop = U.el("div", "popover sb-create-menu");
      const mk = (label, icon, fn) => {
        const item = U.el("button", "menu-item");
        item.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        item.addEventListener("click", () => { pop.remove(); fn(); });
        pop.appendChild(item);
      };
      mk(U.t("新建页面"), "📄", () => App.newPage());
      mk(U.t("新建数据库"), "🗄", () => App.newDatabase());
      mk(U.t("新建代码文件"), "⌨", () => App.newCodeFile());
      mk(U.t("新建网页"), "🌐", () => App.newWebPage());
      mk(U.t("新建 PDF"), "📕", () => App.newPDFPage());
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
      pop.style.top = (r.bottom + 6) + "px";
      document.addEventListener("mousedown", function handler(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", handler); }
      });
    },

    /* ---------- render ---------- */
    render() {
      const q = document.getElementById("sb-search-input").value.trim().toLowerCase();
      // favorites
      const favs = S.allPages().filter(p => p.favorite).sort((a, b) => (a.updatedAt - b.updatedAt));
      const favSection = document.getElementById("sb-favorites-section");
      const favEl = document.getElementById("sb-favorites");
      U.clear(favEl);
      if (favs.length) {
        favSection.hidden = false;
        favs.forEach(p => {
          const row = this.makeRow(p, 0, true);
          row.classList.add("fav-row");
          favEl.appendChild(row);
        });
      } else {
        favSection.hidden = true;
      }

      // tree
      const tree = document.getElementById("sb-tree");
      U.clear(tree);
      const treeData = S.pageTree();
      if (q) {
        // filter mode: show matching pages + parents
        const matching = new Set();
        const collect = (nodes) => nodes.forEach(n => {
          const title = U.segsText(n.page.title).toLowerCase();
          if (title.includes(q)) matching.add(n.page.id);
          collect(n.children);
        });
        collect(treeData);
        const renderFiltered = (nodes, depth) => nodes.forEach(n => {
          const visible = matching.has(n.page.id) || n.children.some(c => matching.has(c.page.id));
          if (visible) {
            tree.appendChild(this.makeRow(n.page, depth, false, true));
            renderFiltered(n.children, depth + 1);
          }
        });
        renderFiltered(treeData, 0);
      } else {
        const renderNode = (nodes, depth) => nodes.forEach(n => {
          tree.appendChild(this.makeRow(n.page, depth, false));
          if (this.isExpanded(n.page.id) && n.children.length) renderNode(n.children, depth + 1);
        });
        renderNode(treeData, 0);
      }
      if (!tree.children.length && !q) {
        const empty = U.el("div", "empty-state");
        empty.style.padding = "30px 10px";
        empty.innerHTML = '<div style="font-size:30px">🌱</div><div>还没有页面</div><div style="font-size:12px;margin-top:6px">点击上方 ＋ 新建</div>';
        tree.appendChild(empty);
      }

      // trash
      const trash = S.getTrashPages();
      const trashSection = document.getElementById("sb-trash-section");
      const trashEl = document.getElementById("sb-trash");
      U.clear(trashEl);
      if (trash.length) {
        trashSection.hidden = false;
        // 清空回收站按钮
        const emptyBtn = U.el("button", "mini-btn sb-trash-empty", "清空回收站");
        emptyBtn.addEventListener("click", async () => {
          const ok = await U.confirmModal({ title: U.t("清空回收站"), message: "将彻底删除回收站中所有页面，此操作不可撤销。", okText: "全部删除", danger: true });
          if (ok) {
            trash.forEach(p => S.deletePage(p.id, true));
            this.render();
            U.toast("回收站已清空");
          }
        });
        trashEl.appendChild(emptyBtn);
        trash.slice(0, 50).forEach(p => {
          const row = U.el("div", "tree-row trash-row");
          row.dataset.pageId = p.id;
          const ico = U.el("span", "t-icon", "🗑");
          const nm = U.el("span", "t-name", U.segsText(p.title) || "未命名");
          const tools = U.el("span", "t-tools");
          const restore = U.el("button", "mini-btn", "↩");
          restore.title = U.t("恢复");
          restore.dataset.action = "restore";
          const del = U.el("button", "mini-btn", "✕");
          del.title = U.t("彻底删除");
          del.dataset.action = "purge";
          tools.appendChild(restore); tools.appendChild(del);
          row.appendChild(ico); row.appendChild(nm); row.appendChild(tools);
          trashEl.appendChild(row);
        });
      } else {
        trashSection.hidden = true;
      }

      // 知识库类别
      this.renderKnowledgeBases();
      // 插件钩子
      if (global.PluginManager) PluginManager.emit("sidebarRendered");
    },

    renderKnowledgeBases() {
      const el = document.getElementById("sb-kb-list");
      if (!el) return;
      const seq = (this._kbSeq = (this._kbSeq || 0) + 1);
      U.clear(el);
      fetch("/api/kb/list")
        .then(res => res.json())
        .then(j => {
          if (seq !== this._kbSeq) return; // 过期请求，忽略（避免并发导致重复）
          const kbs = Array.isArray(j.kbs) ? j.kbs : [];
          // 「新建」入口只保留在知识库列表页，这里只做导航列出已有库
          kbs.forEach(k => {
            const row = U.el("div", "tree-row");
            row.innerHTML = '<span class="t-icon">🗄</span><span class="t-name">' + U.esc(k.name) + "</span>";
            row.addEventListener("click", () => { location.hash = "kb/" + k.id; });
            el.appendChild(row);
          });
          if (!kbs.length) {
            const empty = U.el("div", "tree-row");
            empty.innerHTML = '<span class="t-icon">🗄</span><span class="t-name" style="color:var(--text-faint)">点击进入列表</span>';
            empty.addEventListener("click", () => { location.hash = "kb"; });
            el.appendChild(empty);
          }
        })
        .catch(() => { /* 服务未启动时静默 */ });
    },

    makeRow(page, depth, isFav, filtered) {
      const row = U.el("div", "tree-row");
      row.dataset.pageId = page.id;
      row.draggable = true;
      row.style.paddingLeft = (8 + depth * 14) + "px";
      if (App.currentId() === page.id && !filtered) row.classList.add("active");
      const hasChildren = S.getChildren(page.id).length > 0;
      const tw = U.el("span", "tw", "");
      if (hasChildren) {
        tw.textContent = this.isExpanded(page.id) ? "▾" : "▸";
        tw.dataset.action = "toggle";
        tw.title = this.isExpanded(page.id) ? "折叠" : "展开";
      } else {
        tw.textContent = "";
      }
      const ico = U.el("span", "t-icon", page.icon || (page.database ? "🗄" : page.code ? "⌨" : page.web ? "🌐" : page.pdf ? "📕" : "📄"));
      const nm = U.el("span", "t-name", U.segsText(page.title) || "未命名");
      if (page.favorite) nm.innerHTML += ' <span class="fav-star">★</span>';
      const tools = U.el("span", "t-tools");
      if (!isFav) {
        const add = U.el("button", "mini-btn", "＋");
        add.title = U.t("在页面下新建子页面");
        add.dataset.action = "add-child";
        tools.appendChild(add);
      }
      const more = U.el("button", "mini-btn", "⋯");
      more.title = U.t("更多操作");
      more.dataset.action = "more";
      tools.appendChild(more);
      row.appendChild(tw); row.appendChild(ico); row.appendChild(nm); row.appendChild(tools);
      return row;
    },

    isExpanded(id) {
      return this.expanded.has(id);
    },

    /* ---------- tree interactions ---------- */
    onTreeMouseDown(e) {
      const row = e.target.closest(".tree-row");
      if (!row) return;
      // only start drag from the row body, not tools
      if (e.target.closest(".t-tools") || e.target.closest(".tw")) return;
      this._drag = { id: row.dataset.pageId };
      row.classList.add("dragging");
    },

    async onTreeClick(e) {
      const row = e.target.closest(".tree-row");
      if (!row) return;
      const pageId = row.dataset.pageId;
      const action = e.target.dataset && e.target.dataset.action;
      if (action === "toggle") {
        const id = row.dataset.pageId;
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this.render();
        return;
      }
      if (action === "add-child") {
        const p = S.createPage(pageId, {});
        App.openPage(p.id);
        return;
      }
      if (action === "restore") {
        S.setPageDeleted(pageId, false);
        this.render();
        U.toast(U.t("已恢复"));
        return;
      }
      if (action === "purge") {
        const p = S.getPage(pageId);
        const ok = await U.confirmModal({ title: U.t("彻底删除"), message: U.t("彻底删除") + "「" + (p ? (U.segsText(p.title) || U.t("未命名")) : U.t("此页面")) + "」？" + U.t("此操作不可撤销。"), okText: U.t("彻底删除"), danger: true });
        if (ok) {
          S.deletePage(pageId, true);
          this.render();
          if (App.currentId() === pageId) App.goHome();
        }
        return;
      }
      if (action === "more") {
        const page = S.getPage(pageId);
        if (!page) return;
        const rect = e.target.getBoundingClientRect();
        App.openPageMenu(page, rect.left, rect.bottom);
        return;
      }
      // navigate（延迟以区分双击重命名）
      if (pageId) {
        clearTimeout(this._navTimer);
        this._navTimer = setTimeout(() => { this._navTimer = null; App.openPage(pageId); }, 220);
      }
    },

    onTreeDblClick(e) {
      clearTimeout(this._navTimer);
      const row = e.target.closest(".tree-row");
      if (!row) return;
      if (e.target.closest(".t-tools") || e.target.closest(".tw")) return;
      const nameEl = row.querySelector(".t-name");
      if (nameEl) this.startRename(row.dataset.pageId, nameEl);
    },

    /** 行内重命名：把标题替换为输入框，Enter/失焦提交，Esc 取消 */
    startRename(pageId, nameEl) {
      const page = S.getPage(pageId);
      if (!page) return;
      const inp = document.createElement("input");
      inp.className = "rename-input";
      inp.value = U.segsText(page.title) || "";
      inp.spellcheck = false;
      nameEl.innerHTML = "";
      nameEl.appendChild(inp);
      inp.focus();
      inp.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (v && v !== (U.segsText(page.title) || "")) { page.title = [{ t: v }]; S.markDirty(); }
        this.render();
      };
      const cancel = () => { if (!done) { done = true; this.render(); } };
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      inp.addEventListener("blur", commit);
      inp.addEventListener("click", e => e.stopPropagation());
      inp.addEventListener("mousedown", e => e.stopPropagation());
    },

    onTreeDragOver(e) {
      if (!this._drag) return;
      e.preventDefault();
      const row = e.target.closest(".tree-row");
      document.querySelectorAll(".tree-drop-line").forEach(l => l.remove());
      if (!row || row.dataset.pageId === this._drag.id) return;
      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = rect.height;
      let pos = "after";
      const hasKids = S.getChildren(row.dataset.pageId).length > 0;
      if (y < h * 0.25) pos = "before";
      else if (y > h * 0.75) pos = hasKids ? "inside" : "after";
      else pos = hasKids ? "inside" : "after";
      this._dropTarget = { id: row.dataset.pageId, pos };
      // visual: reuse row styling via class
      document.querySelectorAll(".tree-row.drop-over").forEach(r => r.classList.remove("drop-over"));
      row.classList.add("drop-over");
      row.dataset.dropPos = pos;
    },

    onTreeDrop(e) {
      e.preventDefault();
      document.querySelectorAll(".tree-drop-line").forEach(l => l.remove());
      document.querySelectorAll(".tree-row.drop-over").forEach(r => r.classList.remove("drop-over"));
      const t = this._dropTarget;
      const id = this._drag && this._drag.id;
      this.onTreeDragEnd();
      if (!t || !id) return;
      const page = S.getPage(id);
      if (!page) return;
      const target = S.getPage(t.id);
      if (!target || target.id === id) return;
      // prevent moving into own descendant
      let cur = target;
      while (cur) {
        if (cur.id === id) { U.toast("不能移动到自身的子页面中"); return; }
        cur = cur.parentId === "root" ? null : S.getPage(cur.parentId);
      }
      if (t.pos === "inside") {
        S.movePage(id, target.id, null);
        this.expanded.add(target.id);
      } else {
        S.reorderPage(id, target.id, t.pos, false);
      }
      this.render();
    },

    onTreeDragEnd() {
      this._drag = null;
      this._dropTarget = null;
      document.querySelectorAll(".tree-row.dragging, .tree-row.drop-over").forEach(r => {
        r.classList.remove("dragging", "drop-over");
        delete r.dataset.dropPos;
      });
    },

    /** refresh active state */
    refresh() { this.render(); },
  };

  global.Sidebar = Sidebar;
})(window);
