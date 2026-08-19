/* ============ App: bootstrap, routing, topbar, shortcuts, import/export ============ */
(function (global) {
  "use strict";

  const S = Store;

  const App = {
    splitView: null,       // { leftId, rightId, active: "left"|"right" }
    _renderTarget: null,   // 分屏时当前渲染容器（活动窗格的 body）

    async boot() {
      if (global.I18n) I18n.init();
      await S.boot();
      if (global.I18n) I18n.applyToDom(document);
      // 一次性清理：移除误加到"待整理"页面里的 blocks，恢复被误删的子页面
      if (!S.state._migratedInboxV2) {
        const inbox = Object.values(S.state.pages).find(p => p.parentId === "root" && !p.deleted && U.segsText(p.title) === "待整理");
        if (inbox) {
          // 清理误加的 blocks（只保留子页面引用）
          inbox.children = (inbox.children || []).filter(c => c.type === "page");
          // 恢复被误删的子页面
          Object.values(S.state.pages).forEach(p => {
            if (p.parentId === inbox.id && p.deleted && p.type === "page") S.setPageDeleted(p.id, false);
          });
          S.markDirty(); S.save(true);
        }
        S.state._migratedInboxV2 = true;
        S.save(true);
      }
      if (global.Theme) Theme.load();
      this.renderThemeButton();
      // Electron 桌面端：自定义标题栏
      if (window.electronAPI) this._initElectronTitleBar();
      Editor.init();
      Database.bind(document.getElementById("content"));
      Sidebar.init();
      U.applyStaticIcons();
      this.wireTopbar();
      this.wireGlobal();
      if (global.MathR) MathR.ensure();
      if (global.MermaidR) MermaidR.ensure();
      this.route();
      if (global.Bridge) Bridge.start();
      if (global.AI) AI.start();
      if (global.PluginManager) PluginManager.loadAll();

      window.addEventListener("hashchange", () => this.route());
      // 接收 Bookmarklet 剪藏内容（postMessage）
      window.addEventListener("message", async (e) => {
        const data = e.data;
        if (!data) return;
        if (data.type === "notionish-clip-html") {
          // 互斥锁 + 5 秒冷却：正在处理或刚完成时不接受新请求
          if (this._clipBusy) return;
          const now = Date.now();
          if (this._clipDoneAt && now - this._clipDoneAt < 5000) return;
          this._clipBusy = true;
          try {
            U.toast("正在剪藏…");
            await this.clipHtmlToNote(data.title, data.html, data.url);
          } finally {
            this._clipBusy = false;
            this._clipDoneAt = Date.now();
          }
        } else if (data.type === "notionish-clip") {
          if (!data.markdown || !String(data.markdown).trim()) { U.toast("剪藏内容为空"); return; }
          this.createClippedNote(data.title || "剪藏笔记", data.markdown, data.url || "");
        }
      });
      // Electron 桌面端：监听来自 main process 的剪藏 URL
      if (window.electronAPI) {
        window.electronAPI.onClipUrl(async (url) => {
          U.toast("正在剪藏…");
          try {
            const res = await fetch("/api/web/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
            const result = await res.json();
            if (result && result.markdown) {
              this.createClippedNote(result.title || "剪藏笔记", result.markdown, url);
            } else {
              U.toast("无法提取页面内容");
            }
          } catch (err) {
            U.toast("剪藏失败：" + (err.message || "网络错误"));
          }
        });
      }
      window.addEventListener("storage", (e) => {
        if (e.key === S.LS_KEY && e.newValue) {
          try { S.state = JSON.parse(e.newValue); } catch (err) { return; }
          Sidebar.refresh();
          this.route();
        }
      });
      window.addEventListener("beforeunload", () => S.save(true));
      document.addEventListener("visibilitychange", () => { if (document.hidden) S.save(true); });
      setTimeout(() => this.checkReminders(), 3000);
      setInterval(() => this.checkReminders(), 30000);
      // 浏览器扩展剪藏：轮询服务端暂存的剪藏
      setInterval(() => this._pollPendingClips(), 2000);
    },

    /** Electron 桌面端：创建自定义标题栏（无边框窗口） */
    _initElectronTitleBar() {
      const bar = U.el("div", "electron-titlebar");
      bar.innerHTML = `<div class="etb-drag"><span class="etb-title">Notionish</span></div>
        <div class="etb-btns">
          <button class="etb-btn etb-min" title="最小化" data-icon="minus" data-icon-size="14">−</button>
          <button class="etb-btn etb-max" title="最大化" data-icon="square" data-icon-size="12">□</button>
          <button class="etb-btn etb-close" title="关闭" data-icon="x" data-icon-size="14">✕</button>
        </div>`;
      document.body.insertBefore(bar, document.body.firstChild);
      document.body.classList.add("electron");

      const min = bar.querySelector(".etb-min");
      const max = bar.querySelector(".etb-max");
      const close = bar.querySelector(".etb-close");

      min.addEventListener("click", () => window.electronAPI.winMinimize());
      max.addEventListener("click", () => window.electronAPI.winMaximize());
      close.addEventListener("click", () => window.electronAPI.winClose());

      // 更新最大化按钮图标
      window.electronAPI.winIsMaximized().then(isMax => {
        if (isMax) max.textContent = "❐";
      });
      window.electronAPI.onWinState((state) => {
        max.textContent = state === "maximized" ? "❐" : "□";
      });
    },

    /** 轮询服务端暂存的浏览器扩展剪藏 */
    async _pollPendingClips() {
      if (this._clipBusy) return;
      try {
        const res = await fetch("/api/clip/pending");
        const clips = await res.json();
        if (!Array.isArray(clips) || !clips.length) return;
        for (const c of clips) {
          this.createClippedNote(c.title || "剪藏笔记", c.markdown, c.url || "");
        }
      } catch (e) { /* 服务器不可用时静默 */ }
    },

    currentId() { return S.currentPageId; },

    /* ================= Routing ================= */
    route() {
      const hash = location.hash.replace(/^#/, "");
      if (this.splitView) {
        if (!hash || hash === "settings" || hash === "memory" || hash === "questions") {
          this.splitView = null;
          this._renderTarget = null;
          this.route();
          return;
        }
        const p = S.getPage(hash);
        if (!p || p.deleted) {
          this.splitView = null;
          this._renderTarget = null;
          this.route();
          return;
        }
        if (this.splitView.active === "left") this.splitView.leftId = hash;
        else this.splitView.rightId = hash;
        S.currentPageId = hash;
        this.renderSplit();
        Sidebar.refresh();
        this.renderTopbar(p);
        return;
      }
      if (!hash) { this.goHome(); return; }
      if (hash === "settings" || hash === "memory" || hash === "questions") {
        S.currentPageId = null;
        if (hash === "settings") Settings.render();
        else if (hash === "memory") MemoryPage.render();
        else QuestionBank.render();
        const bc = document.getElementById("breadcrumbs");
        U.clear(bc);
        bc.appendChild(U.el("span", "crumb current", hash === "settings" ? "⚙ 设置" : hash === "memory" ? "🧠 记忆" : "🗺 题库"));
        const actions = document.getElementById("topbar-actions");
        U.clear(actions);
        Sidebar.refresh();
        return;
      }
      if (hash === "clip") {
        // 剪藏信号：复用窗口时导航到 #clip，不跳转，保持当前视图
        if (!S.currentPageId) this.goHome();
        return;
      }
      if (hash === "kb" || hash.startsWith("kb/")) {
        S.currentPageId = null;
        KnowledgeBase.render(hash.startsWith("kb/") ? hash.slice(3) : null);
        const bc = document.getElementById("breadcrumbs");
        U.clear(bc);
        bc.appendChild(U.el("span", "crumb current", "🗄 知识库"));
        const actions = document.getElementById("topbar-actions");
        U.clear(actions);
        Sidebar.refresh();
        return;
      }
      const dash = hash.lastIndexOf("-");
      let pageId = hash, blockId = null;
      if (dash > 0 && /^(pg|blk)_/.test(hash)) {
        pageId = hash.slice(0, dash);
        blockId = hash.slice(dash + 1);
        if (!/^(pg|blk)_/.test(blockId)) blockId = null;
      }
      const page = S.getPage(pageId);
      if (!page || page.deleted) { this.goHome(); return; }
      S.currentPageId = page.id;
      if (page.database) Database.render(page);
      else if (page.code) IDE.render(page);
      else if (page.web) WebBrowser.render(page);
      else if (page.pdf) PDFViewer.render(page);
      else Editor.renderPage(page.id);
      if (blockId) setTimeout(() => Editor.focusBlock(blockId), 60);
      Sidebar.refresh();
      this.renderTopbar(page);
    },

    openPage(id) {
      if (location.hash === "#" + id) { this.route(); }
      else location.hash = id;
    },

    /* ================= Split view (分屏) ================= */
    toggleSplit() {
      if (this.splitView) {
        const keepId = this.splitView.active === "left" ? this.splitView.leftId : this.splitView.rightId;
        this.splitView = null;
        this._renderTarget = null;
        if (keepId) this.openPage(keepId);
        else this.goHome();
        return;
      }
      const cur = S.currentPageId;
      if (!cur) { U.toast("请先打开一个页面"); return; }
      this.splitView = { leftId: cur, rightId: null, active: "left" };
      this.renderSplit();
      if (global.Editor && Editor.openPagePicker) {
        Editor.openPagePicker(target => {
          if (!target || !this.splitView) return;
          this.splitView.rightId = target.id;
          this.splitView.active = "right";
          S.currentPageId = target.id;
          location.hash = target.id;
          this.renderSplit();
          this.renderTopbar(S.getPage(target.id));
        });
      }
    },

    renderSplit() {
      const content = document.getElementById("content");
      let split = content.querySelector(".split-container");
      if (!split) {
        content.innerHTML = "";
        split = U.el("div", "split-container");
        ["left", "right"].forEach(pane => {
          const p = U.el("div", "pane");
          p.dataset.pane = pane;
          const head = U.el("div", "pane-head");
          const title = U.el("div", "pane-title");
          const full = U.el("button", "pane-btn", "↗");
          full.title = U.t("全屏打开此页");
          const close = U.el("button", "pane-btn", "×");
          close.title = U.t("关闭此窗");
          head.appendChild(title); head.appendChild(full); head.appendChild(close);
          const body = U.el("div", "pane-body");
          p.appendChild(head); p.appendChild(body);
          split.appendChild(p);

          full.addEventListener("click", () => {
            const id = pane === "left" ? this.splitView.leftId : this.splitView.rightId;
            if (id) { this.splitView = null; this._renderTarget = null; this.openPage(id); }
          });
          close.addEventListener("click", () => this.closeSplitPane(pane));
          p.addEventListener("mousedown", () => {
            if (this.splitView && this.splitView.active !== pane) this.setActivePane(pane);
          });
        });
        content.appendChild(split);
      }
      this.renderPane("left", this.splitView.leftId);
      this.renderPane("right", this.splitView.rightId);
      this.highlightActivePane();
    },

    renderPane(pane, pageId) {
      const content = document.getElementById("content");
      const paneEl = content.querySelector('.pane[data-pane="' + pane + '"]');
      if (!paneEl) return;
      const body = paneEl.querySelector(".pane-body");
      const titleEl = paneEl.querySelector(".pane-title");
      const page = pageId ? S.getPage(pageId) : null;
      if (!page || page.deleted) {
        body.innerHTML = "";
        titleEl.textContent = "（空）";
        body.appendChild(U.el("div", "empty-state", "在左侧边栏点击页面，即可在此窗打开"));
        return;
      }
      titleEl.textContent = (page.icon || "📄") + " " + (U.segsText(page.title) || "未命名");
      this._renderTarget = body;
      try {
        if (page.database) Database.render(page);
        else if (page.code) IDE.render(page);
        else if (page.web) WebBrowser.render(page);
        else if (page.pdf) PDFViewer.render(page);
        else Editor.renderPage(page.id);
      } finally {
        this._renderTarget = null;
      }
    },

    setActivePane(pane) {
      if (!this.splitView) return;
      this.splitView.active = pane;
      const id = pane === "left" ? this.splitView.leftId : this.splitView.rightId;
      if (id) { S.currentPageId = id; if (location.hash !== "#" + id) location.hash = id; }
      this.renderSplit();
    },

    closeSplitPane(pane) {
      const other = pane === "left" ? "right" : "left";
      const keepId = this.splitView ? this.splitView[other + "Id"] : null;
      this.splitView = null;
      this._renderTarget = null;
      if (keepId) this.openPage(keepId);
      else this.goHome();
    },

    highlightActivePane() {
      const content = document.getElementById("content");
      content.querySelectorAll(".pane").forEach(p => {
        p.classList.toggle("active", this.splitView && p.dataset.pane === this.splitView.active);
      });
    },

    goHome() {
      S.currentPageId = null;
      location.hash = "";
      this.renderHome();
      this.renderTopbar(null);
      Sidebar.refresh();
    },

    newPage() {
      const p = S.createPage("root", { icon: "📄" });
      this.openPage(p.id);
      return p;
    },

    newDatabase() {
      const p = S.createPage("root", { icon: "🗄", database: true });
      this.openPage(p.id);
      return p;
    },

    newCodeFile() {
      const p = S.createPage("root", { icon: "⌨", code: true, language: "python" });
      this.openPage(p.id);
      return p;
    },

    newWebPage(url) {
      const p = S.createPage("root", { icon: "🌐", web: true, url: url == null ? "" : String(url).trim() });
      this.openPage(p.id);
      return p;
    },

    newPDFPage(url) {
      const p = S.createPage("root", { icon: "📕", pdf: true, url: url == null ? "" : String(url).trim() });
      if (url == null && global.PDFViewer) PDFViewer.autoUpload = true;
      this.openPage(p.id);
      return p;
    },

    /** 从网址剪藏：服务器抓取网页正文 → 创建笔记 */
    async clipFromUrl(presetUrl) {
      const url = presetUrl || await U.promptModal({ title: U.t("从网址剪藏"), placeholder: "https://…", value: "" });
      if (!url || !url.trim()) return;
      const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : "https://" + url.trim();
      U.toast("正在抓取网页…");
      try {
        const res = await fetch("/api/web/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: normalized }) });
        const data = await res.json();
        if (!data || !data.markdown) { U.toast("抓取失败：无法提取正文"); return; }
        this.createClippedNote(data.title || "", data.markdown, normalized);
      } catch (e) { U.toast("抓取失败：" + (e.message || String(e))); }
    },

    /* ================= Home ================= */
    renderHome() {
      const content = document.getElementById("content");
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll");
      content.appendChild(scroll);

      const h1 = U.el("div", null);
      h1.style.fontSize = "34px";
      h1.style.fontWeight = "700";
      h1.textContent = "欢迎使用 Notionish 📝";
      scroll.appendChild(h1);
      const sub = U.el("div", "page-meta");
      sub.innerHTML = "Notion 风格网页笔记 · 数据保存在本地浏览器 · 按 <span class='kbd'>Ctrl</span>+<span class='kbd'>K</span> 快速搜索";
      scroll.appendChild(sub);

      const actions = U.el("div", null);
      actions.style.display = "flex";
      actions.style.gap = "8px";
      actions.style.margin = "14px 0 6px";
      const newP = U.el("button", "db-btn primary", "＋ 新建页面");
      newP.addEventListener("click", () => this.newPage());
      const newD = U.el("button", "db-btn", "🗄 新建数据库");
      newD.addEventListener("click", () => this.newDatabase());
      const newC = U.el("button", "db-btn", "⌨ 新建代码文件");
      newC.addEventListener("click", () => this.newCodeFile());
      const newW = U.el("button", "db-btn", "🌐 新建网页");
      newW.addEventListener("click", () => this.newWebPage());
      const newPDF = U.el("button", "db-btn", "📕 新建 PDF");
      newPDF.addEventListener("click", () => this.newPDFPage());
      const clipUrl = U.el("button", "db-btn", "🔗 从网址剪藏");
      clipUrl.addEventListener("click", () => this.clipFromUrl());
      actions.appendChild(newP); actions.appendChild(newD); actions.appendChild(newC); actions.appendChild(newW); actions.appendChild(newPDF); actions.appendChild(clipUrl);
      scroll.appendChild(actions);

      const pages = S.allPages();
      const recent = pages.filter(p => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
      const favs = pages.filter(p => p.favorite && !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);

      if (favs.length) {
        const fh = U.el("h2", null);
        fh.style.cssText = "font-size:20px;font-weight:600;margin:26px 0 4px";
        fh.textContent = "⭐ 收藏";
        scroll.appendChild(fh);
        scroll.appendChild(this.cardGrid(favs));
      }
      const rh = U.el("h2", null);
      rh.style.cssText = "font-size:20px;font-weight:600;margin:26px 0 4px";
      rh.textContent = "🕒 最近编辑";
      scroll.appendChild(rh);
      scroll.appendChild(this.cardGrid(recent));

      const tpls = S.getTemplates();
      if (tpls.length) {
        const th = U.el("h2", null);
        th.style.cssText = "font-size:20px;font-weight:600;margin:26px 0 4px";
        th.textContent = "📑 模板";
        scroll.appendChild(th);
        const grid = U.el("div", "home-grid");
        tpls.forEach(tpl => {
          const card = U.el("div", "home-card");
          const t = U.el("div", "hc-title");
          t.innerHTML = '<span>' + U.esc(tpl.data && tpl.data.icon || "📄") + '</span><span>' + U.esc(tpl.name || "未命名模板") + '</span>';
          const d = U.el("div", "hc-desc", ((tpl.data && tpl.data.children) || []).length + " 个块");
          card.appendChild(t); card.appendChild(d);
          card.addEventListener("click", () => {
            const p = S.createPageFromTemplate(tpl.id, "root");
            if (p) { this.openPage(p.id); U.toast("已从模板创建"); }
          });
          const row = U.el("div", null);
          row.style.cssText = "display:flex;gap:8px;margin-top:8px";
          const del = U.el("button", "db-btn", "删除");
          del.addEventListener("click", (e) => { e.stopPropagation(); S.removeTemplate(tpl.id); this.route(); });
          row.appendChild(del);
          card.appendChild(row);
          grid.appendChild(card);
        });
        scroll.appendChild(grid);
      }

      const tips = U.el("div", "callout");
      tips.style.cssText = "margin-top:30px;border-radius:10px;background:var(--bg-subtle);padding:14px 16px;font-size:13.5px;color:var(--text-sub);line-height:1.8";
      tips.innerHTML =
        "💡 <b>快速上手：</b>输入 <span class='kbd'>/</span> 插入块 · <span class='kbd'>#</span> 空格=标题 · <span class='kbd'>-</span> 空格=列表 · <span class='kbd'>[]</span> 空格=待办<br>" +
        "🖱 悬停块左侧拖动 ⋮⋮ 排序，点击 ➕ 插入 · 选中文字出现格式工具栏<br>" +
        "🗄 数据库支持表格 / 看板 / 列表 / 画廊 / 日历五种视图<br>" +
        "⬇️ 左下角可导出 JSON 备份，支持导入恢复";
      scroll.appendChild(tips);
    },

    cardGrid(pages) {
      const grid = U.el("div", "home-grid");
      pages.forEach(p => {
        const card = U.el("div", "home-card");
        const t = U.el("div", "hc-title");
        t.innerHTML = '<span>' + U.esc(p.icon || (p.database ? "🗄" : "📄")) + '</span><span>' + U.esc(U.segsText(p.title) || "未命名") + '</span>' +
          (p.database ? '<span class="db-badge">数据库</span>' : "");
        const d = U.el("div", "hc-desc");
        const first = p.children && p.children[0] ? U.segsText(p.children[0].text) : "";
        d.textContent = p.database ? (S.getChildren(p.id).length + " 条记录") : (first || "空白页面");
        const date = U.el("div", "hc-date", "更新于 " + U.fmtDate(p.updatedAt));
        card.appendChild(t); card.appendChild(d); card.appendChild(date);
        card.addEventListener("click", () => this.openPage(p.id));
        grid.appendChild(card);
      });
      return grid;
    },

    /* ================= Topbar ================= */
    wireTopbar() {
      document.getElementById("tb-menu").addEventListener("click", () => {
        document.body.classList.toggle("sb-closed");
        localStorage.setItem("notionish_sb", document.body.classList.contains("sb-closed") ? "1" : "0");
      });
      const bell = U.el("button", "icon-btn", U.icon("bell", { size: 18 }));
      bell.id = "topbar-bell";
      bell.title = U.t("提醒");
      bell.setAttribute("aria-label", "提醒");
      document.getElementById("topbar").appendChild(bell);
      bell.addEventListener("click", () => this.openRemindersPanel());
      this.updateBell();

      const settings = U.el("button", "icon-btn", U.icon("settings", { size: 18 }));
      settings.id = "topbar-settings";
      settings.title = U.t("设置");
      settings.setAttribute("aria-label", "设置");
      document.getElementById("topbar").appendChild(settings);
      settings.addEventListener("click", () => { location.hash = "settings"; });

      const splitBtn = U.el("button", "icon-btn", U.icon("columns", { size: 18 }));
      splitBtn.id = "topbar-split";
      splitBtn.title = U.t("分屏（左右同时看两篇）");
      splitBtn.setAttribute("aria-label", "分屏");
      document.getElementById("topbar").appendChild(splitBtn);
      splitBtn.addEventListener("click", () => this.toggleSplit());
    },

    renderTopbar(page) {
      const bc = document.getElementById("breadcrumbs");
      const actions = document.getElementById("topbar-actions");
      U.clear(bc); U.clear(actions);
      if (!page) {
        const crumb = U.el("span", "crumb current", "🏠 主页");
        bc.appendChild(crumb);
        return;
      }
      const chain = S.breadcrumb(page.id);
      chain.forEach((p, i) => {
        if (i > 0) bc.appendChild(U.el("span", "crumb-sep", "›"));
        const c = U.el("span", "crumb" + (i === chain.length - 1 ? " current" : ""));
        c.innerHTML = (p.icon ? U.esc(p.icon) + " " : "") + U.esc(U.segsText(p.title) || "未命名");
        if (i < chain.length - 1) c.addEventListener("click", () => this.openPage(p.id));
        bc.appendChild(c);
      });
      // actions
      const fav = U.el("button", "icon-btn" + (page.favorite ? " active" : ""), U.icon("star", { size: 18 }));
      fav.title = page.favorite ? "取消收藏" : "收藏";
      fav.setAttribute("aria-label", fav.title);
      fav.addEventListener("click", () => {
        page.favorite = !page.favorite;
        S.markDirty();
        Sidebar.refresh();
        this.renderTopbar(page);
      });
      actions.appendChild(fav);

      const cov = U.el("button", "icon-btn", U.icon("image", { size: 18 }));
      cov.title = page.cover ? "更换封面" : "添加封面";
      cov.setAttribute("aria-label", cov.title);
      cov.addEventListener("click", () => this.openCoverPicker(page));
      actions.appendChild(cov);

      const more = U.el("button", "icon-btn", U.icon("ellipsis", { size: 18 }));
      more.title = U.t("页面菜单");
      more.setAttribute("aria-label", "页面菜单");
      more.addEventListener("click", (e) => {
        const r = more.getBoundingClientRect();
        this.openPageMenu(page, r.left, r.bottom);
      });
      actions.appendChild(more);
    },

    openPageMenu(page, x, y) {
      U.closePopovers();
      const pop = U.el("div", "popover");
      const scroll = U.el("div", "menu-scroll");
      pop.appendChild(scroll);
      const addItem = (icon, label, fn, danger) => {
        const it = U.el("div", "menu-item" + (danger ? " danger" : ""));
        it.innerHTML = '<span class="mi-ico">' + icon + '</span><span class="mi-label">' + U.esc(label) + '</span>';
        it.addEventListener("click", () => { pop.remove(); fn(); });
        scroll.appendChild(it);
      };
      addItem(U.icon("pencil", { size: 16 }), U.t("重命名"), async () => {
        const name = await U.promptModal({ title: U.t("重命名页面"), value: U.segsText(page.title) || "", placeholder: U.t("页面名称") });
        if (name != null && name.trim()) {
          page.title = [{ t: name.trim() }];
          S.markDirty();
          Sidebar.refresh();
          this.route();
        }
      });
      addItem(U.icon("star", { size: 16 }), page.favorite ? U.t("取消收藏") : U.t("设为收藏"), () => {
        page.favorite = !page.favorite;
        S.markDirty();
        Sidebar.refresh();
        this.renderTopbar(page);
      });
      addItem(U.icon("copy", { size: 16 }), U.t("复制页面"), () => {
        const copy = S.duplicatePage(page.id);
        if (copy) { this.openPage(copy.id); U.toast(U.t("已复制页面")); }
      });
      addItem(U.icon("folder-open", { size: 16 }), U.t("移至…"), () => {
        Editor.openPagePicker((target) => {
          S.movePage(page.id, target.id, null);
          Sidebar.refresh();
          this.route();
        });
      });
      addItem(U.icon("upload", { size: 16 }), U.t("导出为 JSON"), () => {
        U.download((U.segsText(page.title) || U.t("页面")) + ".json", JSON.stringify(page, null, 2), "application/json");
        U.toast(U.t("已导出"));
      });
      addItem(U.icon("file-text", { size: 16 }), U.t("导出为 Markdown"), () => {
        U.download((U.segsText(page.title) || U.t("页面")) + ".md", S.pageToMarkdown(page), "text/markdown;charset=utf-8");
        U.toast(U.t("已导出 Markdown"));
      });
      addItem(U.icon("globe", { size: 16 }), U.t("导出为 HTML"), () => {
        U.download((U.segsText(page.title) || U.t("页面")) + ".html", this.pageToHTML(page), "text/html;charset=utf-8");
        U.toast(U.t("已导出 HTML"));
      });
      addItem(U.icon("printer", { size: 16 }), U.t("打印 / 导出 PDF"), () => {
        if (S.currentPageId === page.id) this.printPage(page);
        else { this.openPage(page.id); setTimeout(() => this.printPage(page), 400); }
      });
      if (page.web && page.url) {
        addItem(U.icon("file-text", { size: 16 }), U.t("保存为笔记（抓取正文）"), () => this.clipFromUrl(page.url));
        addItem(U.icon("file-text", { size: 16 }), U.t("转换为 PDF（网页内容）"), () => this.convertWebPageToPdf(page));
      }
      addItem(U.icon("clock", { size: 16 }), U.t("设置提醒"), () => this.openAddReminder(page));
      addItem(U.icon("history", { size: 16 }), U.t("版本历史"), () => this.openVersionHistory(page));
      addItem(U.icon("save", { size: 16 }), U.t("保存为模板"), () => {
        S.addTemplate({ name: U.segsText(page.title) || U.t("未命名模板"), data: { title: U.clone(page.title), icon: page.icon, children: U.clone(page.children) } });
        U.toast(U.t("已保存为模板"));
      });
      addItem(U.icon("trash-2", { size: 16 }), U.t("删除页面"), async () => {
        const ok = await U.confirmModal({ title: U.t("删除页面"), message: U.t("将") + "「" + (U.segsText(page.title) || U.t("未命名")) + "」" + U.t("移到回收站？"), okText: U.t("移到回收站"), danger: true });
        if (ok) {
          S.deletePage(page.id, false);
          Sidebar.refresh();
          if (this.currentId() === page.id) this.goHome();
          else this.route();
          U.toast(U.t("已移入回收站"));
        }
      }, true);

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

    /* ================= Cover picker ================= */
    openCoverPicker(page) {
      const modal = U.modal({ title: U.t("设置封面"), size: "lg" });
      const tabs = U.el("div", "cover-tabs");
      const grid = U.el("div", "cover-grid");
      modal.body.appendChild(tabs);
      modal.body.appendChild(grid);

      const gradients = [
        "linear-gradient(135deg,#667eea,#764ba2)",
        "linear-gradient(135deg,#f093fb,#f5576c)",
        "linear-gradient(135deg,#4facfe,#00f2fe)",
        "linear-gradient(135deg,#43e97b,#38f9d7)",
        "linear-gradient(135deg,#fa709a,#fee140)",
        "linear-gradient(135deg,#30cfd0,#330867)",
        "linear-gradient(135deg,#a8edea,#fed6e3)",
        "linear-gradient(135deg,#ff9a9e,#fecfef)",
        "linear-gradient(135deg,#f6d365,#fda085)",
        "linear-gradient(135deg,#84fab0,#8fd3f4)",
        "linear-gradient(135deg,#d299c2,#fef9d7)",
        "linear-gradient(135deg,#5ee7df,#b490ca)",
      ];

      const cats = (U.COVER_CATALOG || []).map(c => ({ id: c.id, label: c.label })).concat({ id: "gradient", label: "渐变" });
      let activeCat = cats[0] ? cats[0].id : "gradient";

      const select = (value) => {
        page.cover = value;
        S.markDirty();
        modal.close();
        this.route();
      };

      const renderCat = () => {
        U.clear(tabs);
        cats.forEach(c => {
          const b = U.el("button", "cover-tab" + (c.id === activeCat ? " active" : ""), c.label);
          b.addEventListener("click", () => { activeCat = c.id; renderCat(); });
          tabs.appendChild(b);
        });
        U.clear(grid);
        if (activeCat === "gradient") {
          gradients.forEach(g => {
            const c = U.el("div", "cover-cell");
            c.style.background = g;
            c.addEventListener("click", () => select(g));
            grid.appendChild(c);
          });
        } else {
          const cat = U.COVER_CATALOG.find(x => x.id === activeCat);
          (cat ? cat.items : []).forEach(it => {
            const cell = U.el("div", "cover-cell cover-photo");
            cell.title = it.alt;
            const img = U.el("img", "cover-thumb");
            img.loading = "lazy";
            img.alt = it.alt;
            img.src = it.thumb;
            img.addEventListener("error", () => {
              cell.classList.add("cover-broken");
              cell.textContent = "图片暂不可用";
            });
            cell.appendChild(img);
            const credit = U.el("a", "cover-credit", U.esc(it.credit));
            credit.href = it.creditUrl;
            credit.target = "_blank";
            credit.rel = "noopener noreferrer";
            credit.addEventListener("click", e => e.stopPropagation());
            cell.appendChild(credit);
            cell.addEventListener("click", () => select(it.src));
            grid.appendChild(cell);
          });
        }
      };
      renderCat();

      const foot = U.el("div", "cover-actions");
      if (page.cover) {
        const rm = U.el("button", "db-btn", U.icon("trash-2", { size: 16 }) + " 移除封面");
        rm.addEventListener("click", () => {
          page.cover = null;
          S.markDirty();
          modal.close();
          this.route();
        });
        foot.appendChild(rm);
      }
      const up = U.el("button", "db-btn", U.icon("upload", { size: 16 }) + " 上传图片");
      up.addEventListener("click", () => {
        const inp = U.el("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.onchange = async () => {
          const f = inp.files[0];
          if (!f) return;
          page.cover = await U.fileToDataURL(f);
          S.markDirty();
          modal.close();
          this.route();
        };
        inp.click();
      });
      foot.appendChild(up);
      modal.body.appendChild(foot);
    },

    /* ================= Search modal ================= */
    openSearchModal(initial) {
      const modal = U.modal({ title: U.t("搜索"), size: "lg" });
      const inp = U.el("input", "modal-input");
      inp.placeholder = "搜索页面和块内容…";
      inp.value = initial || "";
      modal.body.appendChild(inp);
      const list = U.el("div", null);
      list.style.marginTop = "10px";
      modal.body.appendChild(list);
      const render = () => {
        const q = inp.value.trim();
        U.clear(list);
        if (!q) {
          const hint = U.el("div", "empty-state");
          hint.style.padding = "30px";
          hint.textContent = "输入关键字搜索页面与块内容";
          list.appendChild(hint);
          return;
        }
        const results = S.search(q);
        if (!results.length) {
          const none = U.el("div", "empty-state");
          none.style.padding = "30px";
          none.textContent = "没有找到「" + q + "」相关的内容";
          list.appendChild(none);
          return;
        }
        results.forEach(r => {
          const row = U.el("div", "search-result");
          const chain = S.breadcrumb(r.page.id);
          const bread = chain.slice(0, -1).map(p => U.segsText(p.title) || "未命名").join(" › ");
          row.innerHTML =
            '<span class="sr-ico">' + U.esc(r.page.icon || "📄") + '</span>' +
            '<div style="flex:1;min-width:0">' +
            '<div class="sr-title">' + U.esc(r.title || "未命名") + (r.page.database ? ' <span class="db-badge">数据库</span>' : "") + '</div>' +
            (r.type === "block" ? '<div class="sr-hit">…' + this.highlight(r.loc, q) + "…</div>" : "") +
            (bread ? '<div class="sr-bread">' + U.esc(bread) + "</div>" : "") +
            "</div>";
          row.addEventListener("click", () => {
            modal.close();
            if (r.type === "block") {
              this.openPage(r.page.id);
              setTimeout(() => Editor.focusBlock(r.block.id), 80);
            } else {
              this.openPage(r.page.id);
            }
          });
          list.appendChild(row);
        });
      };
      render();
      inp.addEventListener("input", render);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const first = list.querySelector(".search-result");
          if (first) first.click();
        }
      });
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    },

    highlight(text, q) {
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return U.esc(text.slice(0, 60));
      const start = Math.max(0, i - 12);
      return U.esc(text.slice(start, i)) +
        "<mark style='background:var(--accent-soft);color:var(--accent)'>" + U.esc(text.slice(i, i + q.length)) + "</mark>" +
        U.esc(text.slice(i + q.length, i + q.length + 40));
    },

    /* ================= Import / Export ================= */
    exportAll() {
      U.download("notionish-backup-" + new Date().toISOString().slice(0, 10) + ".json", S.exportJSON(), "application/json");
      U.toast("已导出全部数据");
    },

    tableToHTML(b) {
      const rows = (b.attrs.rows || []).map(r => (r || []).map(c => Blocks.segsToHTML(Array.isArray(c) ? c : (c ? [c] : []))));
      if (!rows.length) return "";
      const ncol = b.attrs.cols || rows[0].length;
      let out = "<table border='1' cellpadding='6' style='border-collapse:collapse;margin:8px 0'>";
      rows.forEach((r, i) => {
        out += "<tr>";
        for (let c = 0; c < ncol; c++) {
          const tag = (i === 0 && b.attrs.header) ? "th" : "td";
          out += "<" + tag + ">" + (r[c] || "") + "</" + tag + ">";
        }
        out += "</tr>";
      });
      return out + "</table>";
    },

    blockToHTML(b) {
      const text = Blocks.segsToHTML(b.text || []);
      switch (b.type) {
        case "heading1": return "<h1>" + text + "</h1>";
        case "heading2": return "<h2>" + text + "</h2>";
        case "heading3": return "<h3>" + text + "</h3>";
        case "bullet": return "<ul><li>" + text + "</li></ul>";
        case "numbered": return "<ol><li>" + text + "</li></ol>";
        case "todo": return '<div><input type="checkbox" ' + (b.checked ? "checked" : "") + " disabled> " + text + "</div>";
        case "toggle": return "<p>▸ " + text + "</p>" + (b.children || []).map(c => this.blockToHTML(c)).join("");
        case "quote": return "<blockquote>" + text + "</blockquote>";
        case "callout": return '<div style="background:#f1f1ef;padding:8px 12px;border-radius:6px;margin:8px 0">' + (b.attrs.icon || "💡") + " " + text + "</div>";
        case "code": return "<pre style='background:#f6f6f6;padding:12px;border-radius:6px;overflow:auto'><code>" + U.esc(b.attrs.source || "") + "</code></pre>";
        case "divider": return "<hr>";
        case "equation": return '<div style="text-align:center;padding:8px 0">' + (global.MathR ? MathR.renderDisplay(U.segsText(b.text)) : U.esc(U.segsText(b.text))) + "</div>";
        case "image": return b.attrs.src ? '<img src="' + U.escAttr(b.attrs.src) + '" style="max-width:100%;border-radius:6px">' : "";
        case "bookmark": return '<p><a href="' + U.escAttr(b.attrs.url || "") + '">' + U.esc(b.attrs.title || b.attrs.url || "") + "</a></p>";
        case "embed": return b.attrs.url ? '<p><a href="' + U.escAttr(b.attrs.url) + '">' + U.esc(b.attrs.url) + "</a></p>" : "";
        case "table": return this.tableToHTML(b);
        case "page": { const t = b.attrs.pageId ? S.getPage(b.attrs.pageId) : null; return '<p>📄 ' + U.esc(t ? (U.segsText(t.title) || "未命名") : "子页面") + "</p>"; }
        case "database": { const t = b.attrs.pageId ? S.getPage(b.attrs.pageId) : null; return '<p>🗄 ' + U.esc(t ? (U.segsText(t.title) || "数据库") : "数据库") + "</p>"; }
        default: return "<p>" + text + "</p>";
      }
    },

    pageToHTML(page) {
      const title = U.segsText(page.title) || "未命名";
      let body = "";
      if (page.database) {
        body += "<table border='1' cellpadding='6' style='border-collapse:collapse'>";
        body += "<tr>" + page.schema.props.map(p => "<th>" + U.esc(p.name) + "</th>").join("") + "</tr>";
        S.getChildren(page.id).forEach(row => {
          body += "<tr>" + page.schema.props.map(p => "<td>" + U.esc(S.displayPropValue(page, row, p)) + "</td>").join("") + "</tr>";
        });
        body += "</table>";
      }
      (page.children || []).forEach(b => { body += this.blockToHTML(b); });
      return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><title>" + U.esc(title) + "</title>" +
        "<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}" +
        "h1,h2,h3{margin:1em 0 .4em}code{background:#f2f2f2;padding:1px 4px;border-radius:3px}" +
        "blockquote{border-left:3px solid #ddd;margin:0;padding:0 14px;color:#666}hr{border:none;border-top:1px solid #eee}</style>" +
        "</head><body><h1>" + U.esc(title) + "</h1>" + body + "</body></html>";
    },

    /** 打印/导出 PDF 前：展开代码块、渲染 Mermaid，再打印 */
    async printPage(page) {
      // 把代码块 textarea 替换成 <pre>：长代码可自然分页，避免打印截断
      const swaps = [];
      document.querySelectorAll(".b-code textarea, .sn-code").forEach(ta => {
        const pre = document.createElement("pre");
        pre.textContent = ta.value;
        pre.className = "print-code";
        pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.5;background:transparent;margin:0;";
        ta.parentNode.replaceChild(pre, ta);
        swaps.push([pre, ta]);
      });
      await this.renderAllMermaidsForPrint(page);
      window.print();
      swaps.forEach(([pre, ta]) => { if (pre.parentNode) pre.parentNode.replaceChild(ta, pre); });
    },

    /** 把 Bookmarklet 剪藏的 Markdown 生成一篇笔记，放在「待整理」文件夹下 */
    createClippedNote(title, markdown, url) {
      const S = global.Store;
      // 找到或创建「待整理」文件夹
      let inboxId = this._inboxId;
      if (!inboxId) {
        const existing = Object.values(S.state.pages).find(p => p.parentId === "root" && !p.deleted && U.segsText(p.title) === "待整理");
        inboxId = existing ? existing.id : null;
      }
      if (inboxId) { const p = S.getPage(inboxId); if (!p || p.deleted) inboxId = null; }
      if (!inboxId) {
        const inbox = S.createPage("root", { title: U.t("待整理"), icon: "📥" });
        inboxId = inbox.id;
      }
      this._inboxId = inboxId;

      // 在「待整理」文件夹下新建子页面
      const page = S.createPage(inboxId, { title: title || "剪藏笔记", icon: "🌐" });
      if (url) {
        const srcBlk = S.newBlock("bookmark");
        srcBlk.attrs = { url, title: title || url };
        S.insertBlock(page, srcBlk, page.children.length);
      }
      const AI = global.AI;
      let blocks = (AI && AI.markdownToBlocks) ? AI.markdownToBlocks(String(markdown || "")) : [];
      // 若正文首块是标题且与页面标题一致，去掉重复 h1
      const first = blocks[0];
      if (first && first.type === "heading1") {
        const ht = (first.segments || []).map(s => s.t || "").join("").trim();
        const tt = (title || "").trim();
        if (tt && ht && (ht === tt || ht.replace(/\s+/g, "").toLowerCase() === tt.replace(/\s+/g, "").toLowerCase())) {
          blocks = blocks.slice(1);
        }
      }
      blocks.forEach(b => {
        const blk = S.newBlock(b.type);
        if (b.segments && b.segments.length) blk.text = b.segments;
        if (b.attrs && typeof b.attrs === "object") Object.assign(blk.attrs, b.attrs);
        S.insertBlock(page, blk, page.children.length);
      });

      S.touch(page);
      S.markDirty();
      S.save(true);
      // 自动打开新剪藏的页面
      if (global.App) App.openPage(page.id);
      U.toast("已剪藏 → " + (title || "剪藏笔记"));
    },

    /** 处理 Bookmarklet 传来的网页 HTML：本地 Readability + Turndown 转成笔记 */
    async clipHtmlToNote(title, html, url) {
      if (!html || !String(html).trim()) { U.toast("剪藏内容为空"); return; }
      const load = (src) => new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = res;
        s.onerror = () => rej(new Error("加载剪藏组件失败"));
        document.head.appendChild(s);
      });
      try {
        if (!window.Readability) await load("/vendor/readability/Readability.js");
        if (!window.TurndownService) await load("/vendor/turndown/turndown.js");
        // 1. Readability 提取正文（Wikipedia 等已知站点用专用选择器）
        const doc = new DOMParser().parseFromString(html, "text/html");
        let article = null;
        let isWiki = /wikipedia\.org/i.test(url);
        if (isWiki) {
          const wikiContent = doc.querySelector(".mw-parser-output") || doc.querySelector("#mw-content-text");
          const ogTitle = doc.querySelector('meta[property="og:title"]');
          const wikiTitle = ogTitle ? (ogTitle.getAttribute("content") || "").replace(/\s*[-–—]\s*Wikipedia\s*$/, "") : "";
          if (wikiContent) {
            article = { title: wikiTitle || doc.title || "", content: wikiContent.innerHTML };
          }
        }
        // GeeksforGeeks：Next.js 渲染，正文在 article--viewer 容器里，页面没有 <article>/<main>
        if (!article && /geeksforgeeks\.org/i.test(url)) {
          const gfg = doc.querySelector('.article--viewer, [class*="article--viewer"], [class*="articleViewer"]');
          if (gfg) {
            const ogTitle = doc.querySelector('meta[property="og:title"]');
            const gTitle = (ogTitle ? ogTitle.getAttribute("content") : "") || doc.title || "";
            article = { title: gTitle.replace(/\s*[-–—|]\s*GeeksforGeeks\s*$/i, "").trim(), content: gfg.innerHTML };
          }
        }
        if (!article) {
          // 用 defuddle 风格的评分找正文（比 Readability 更可靠，不丢图片和代码块）
          article = this._findContentByScoring(doc);
        }
        if (!article || !article.content) { U.toast("无法提取正文"); return; }
        // 2. 把提取的正文解析成 DOM，预处理相对 URL 转绝对
        const cdoc = new DOMParser().parseFromString(article.content, "text/html");
        // 清理 Wikipedia 信息框（infobox），避免表格污染正文
        if (isWiki) cdoc.querySelectorAll(".infobox, .sidebar, .navbox, .mw-editsection, .mw-empty-elt, .sistersitebox, .metadata").forEach(el => el.remove());
        cdoc.querySelectorAll("a").forEach(a => {
          const href = a.getAttribute("href") || "";
          if (href && !/^(javascript:|#)/i.test(href)) { try { a.setAttribute("href", (new URL(href, url)).href); } catch (e) {} }
        });
        // 图片标准化（移植 defuddle）：懒加载占位图 → 真实图，srcset 选最高清
        cdoc.querySelectorAll("img").forEach(img => {
          let src = img.getAttribute("src") || "";
          const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || img.getAttribute("data-srcset") || "";
          // 检测 base64 占位图（1x1 gif/png 或太小）或 SVG 占位，替换为真实地址
          const isPlaceholder = !src || /^data:image\/(?:gif|png)/i.test(src) && src.length < 300 || /^data:image\/svg\+xml/i.test(src);
          if (isPlaceholder && dataSrc) {
            // 提取真实 URL（data-srcset 里可能有多候选，取第一个）
            const realSrc = dataSrc.split(/\s+/)[0].replace(/^,\s*/, "");
            if (realSrc && !/^data:/i.test(realSrc)) {
              try { img.setAttribute("src", new URL(realSrc, url).href); } catch (e) { img.setAttribute("src", realSrc); }
            }
          }
          // 处理 srcset：选最高分辨率
          const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
          if (srcset) {
            let bestW = 0, bestUrl = src, parts = srcset.trim().split(/\s+/), urlParts = [];
            for (const t of parts) {
              const wm = t.match(/^(\d+)w,?$/);
              if (wm) { const w = parseInt(wm[1]); if (urlParts.length > 0 && w > bestW) { bestW = w; bestUrl = urlParts.join(" ").replace(/^,\s*/, ""); } urlParts = []; }
              else if (/^\d+(?:\.\d+)?x,?$/.test(t)) { urlParts = []; }
              else { urlParts.push(t); }
            }
            if (bestUrl && bestUrl !== src) {
              try { img.setAttribute("src", new URL(bestUrl, url).href); } catch (e) { img.setAttribute("src", bestUrl); }
            }
          }
          // 相对 URL 转绝对
          const finalSrc = img.getAttribute("src") || "";
          if (finalSrc && !/^data:/i.test(finalSrc)) { try { img.setAttribute("src", new URL(finalSrc, url).href); } catch (e) {} }
          // 移除懒加载属性
          img.removeAttribute("data-src"); img.removeAttribute("data-srcset"); img.removeAttribute("data-original");
          img.removeAttribute("loading"); img.classList.remove("lazy", "lazyload");
        });
        // 代码块标准化（移植 defuddle）：把各种语法高亮容器转成标准 <pre><code>
        // 0. 替换自定义元素（<gfg-panel> 等）为 div，解除嵌套
        Array.from((cdoc.body || cdoc).querySelectorAll("*")).reverse().forEach(el => {
          if (el.tagName.includes("-") && !["gfg-tab", "gfg-tab-item"].includes(el.tagName.toLowerCase())) {
            const div = cdoc.createElement("div");
            while (el.firstChild) div.appendChild(el.firstChild);
            const lang = el.getAttribute("data-code-lang");
            if (lang) div.setAttribute("data-lang", lang);
            el.replaceWith(div);
          }
        });
        // 1. .highlight 容器（Hugo/Chroma/GfG 等语法高亮器）→ 提取为 <pre><code>
        Array.from(cdoc.querySelectorAll(".highlight, div[class*='language-'], .code-block[data-lang]")).reverse().forEach(el => {
          if (el.closest("pre")) return;
          let lang = el.getAttribute("data-lang") || el.getAttribute("data-language") || "";
          if (!lang) {
            const lm = (el.getAttribute("class") || "").match(/language-(\w+)/);
            if (lm) lang = lm[1];
          }
          if (!lang) {
            let p = el.parentElement;
            while (p && !lang) {
              lang = p.getAttribute("data-lang") || p.getAttribute("data-language") || "";
              if (!lang) { const lm = (p.getAttribute("class") || "").match(/language-(\w+)/); if (lm) lang = lm[1]; }
              p = p.parentElement;
            }
          }
          const pre = cdoc.createElement("pre");
          const code = cdoc.createElement("code");
          if (lang) { code.setAttribute("data-lang", lang); code.setAttribute("class", "language-" + lang); }
          code.textContent = (el.textContent || "").replace(/\t/g, "    ").trim();
          pre.appendChild(code);
          el.replaceWith(pre);
        });
        // 2. 修复 <code> 包 <pre> 的非法嵌套（GfG 等），提取语言
        Array.from(cdoc.querySelectorAll("code > pre")).reverse().forEach(pre => {
          const outerCode = pre.parentElement;
          const lang = (outerCode.getAttribute("class") || "").match(/language-(\w+)/)?.[1] || outerCode.getAttribute("data-lang") || "";
          if (lang) {
            let innerCode = pre.querySelector("code");
            if (!innerCode) { innerCode = cdoc.createElement("code"); innerCode.textContent = pre.textContent || ""; pre.innerHTML = ""; pre.appendChild(innerCode); }
            innerCode.setAttribute("data-lang", lang);
            innerCode.setAttribute("class", "language-" + lang);
          }
          outerCode.replaceWith(pre);
        });
        // 2.5 噪音移除（移植 defuddle：隐藏元素 + 精确/部分选择器 + 小图标）
        const croot = cdoc.body || cdoc;
        const exactSel = [
          "script", "style", "noscript", "meta", "link",
          "nav", "footer", "header", "form", "button", "canvas", "dialog", "fieldset",
          "select", "textarea", "label", "option", "date",
          ".sidebar", ".Sidebar", "#sidebar", "#Sidebar", "#secondary",
          ".ad", "[class^='ad-']", "[class$='-ad']", "[id^='ad-']", ".promo", ".alert",
          ".author", ".Author", ".date", ".meta", ".entry-meta", ".tags", "#tags",
          ".headline", "#headline", "#title", "#Title", ".contributor",
          ".toc", ".Toc", "#toc", ".noprint",
          ".menu", ".navigation", "#navigation", "[role='navigation']", "[role='banner']",
          ".subscribe", "#newsletter", ".copyright", "#copyright",
          ".breadcrumb", ".crumbs", ".pagination", ".previous", ".next",
          ".share", ".social", "[class*='share-']", "[class*='social-']",
          ".comment", "#comments", "[class*='comment-']",
          ".related", "[class*='related']", ".recommend", "[class*='recommend']",
          ".jump-link", ".skip-link", "[aria-label*='skip']",
          ".gutter", "#rss", "#feed", ".logo", "#logo",
          "table.infobox", ".infobox", ".navbox", ".mw-editsection", ".mw-empty-elt",
          ".sistersitebox", ".metadata", ".ambox", ".shortdescription", ".hatnote",
          ".reflist", ".refbegin", ".authority-control", ".mw-jump-link",
          ".printfooter", ".catlinks", ".mw-indicators", ".mw-cite-backlink",
          ".gallery", ".thumbcaption"
        ];
        croot.querySelectorAll(exactSel.join(",")).forEach(el => { if (!el.closest("pre, code, math")) el.remove(); });
        const partialPat = /\b(advert|ad-|-ad|banner|cookie|breadcrumb|comments|comment-|copyright|footer|header|homepage|login|menu|newsletter|popular|privacy|recommended|register|related|responses|share|sidebar|sign.?in|sign.?up|social|sponsored|subscribe|terms|trending|byline|avatar|author-bio|author-box|meta|date|tags|category|pagination|prev|next|promo|widget|disqus|facebook|twitter|donate|feedback|carousel|gallery|lightbox|popup|modal|tooltip|dropdown|masthead|site-header|site-name|page-header|post-header|post-title|entry-title|page-title|read-more|keep-reading|more-|related-|similar-|outline|nav-|menu-|skip-|visually-hidden|screen-reader|sr-only|hidden-|no-print|print-|hamburger|back-to-top|scroll-to)/i;
        croot.querySelectorAll("[class], [id]").forEach(el => {
          if (el.closest("pre, code, math")) return;
          const cls = (el.className || "").toString();
          const id = (el.id || "").toString();
          if (/article|content|post|entry|story|main|text|body|section/i.test(cls + " " + id)) return;
          if (partialPat.test(cls) || partialPat.test(id)) el.remove();
        });
        croot.querySelectorAll("*").forEach(el => {
          if (el.closest("pre, code, math")) return;
          if (el.querySelector("math, .katex-mathml, [data-mathml]") || el.tagName.toLowerCase() === "math") return;
          const style = el.getAttribute("style") || "";
          if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i.test(style)) { el.remove(); return; }
          const cls = (el.className || "").toString();
          const toks = cls.split(/\s+/);
          for (const tok of toks) {
            if (tok === "hidden" || tok === "invisible" || tok === "sr-only" || tok === "visually-hidden" || tok === "screen-reader-text") { el.remove(); break; }
          }
        });
        croot.querySelectorAll("img, svg").forEach(el => {
          const w = parseInt(el.getAttribute("width") || "0");
          const h = parseInt(el.getAttribute("height") || "0");
          if (w > 0 && w < 33) { el.remove(); return; }
          if (h > 0 && h < 33) { el.remove(); return; }
          if (el.tagName.toLowerCase() === "svg") {
            const vb = el.getAttribute("viewBox") || "";
            const parts = vb.split(/[\s,]+/);
            if (parts.length === 4) {
              const vw = parseFloat(parts[2]) || 0, vh = parseFloat(parts[3]) || 0;
              if ((vw > 0 && vw < 33) || (vh > 0 && vh < 33)) { el.remove(); return; }
            }
          }
        });
        // 3. Turndown 配置（借鉴 defuddle/Obsidian Clipper）+ 自定义规则
        const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", preformattedCode: true });
        // 链接规则（defuddle 风格：括号转义、空格包裹）
        td.addRule("link", { filter: "a", replacement: function (content, node) {
          let href = node.getAttribute("href") || "";
          if (!href) return content;
          try { href = new URL(href, url).href; } catch (e) {}
          // Turndown 转义了链接文本中的 [ ]，还原；Wikipedia 引用链接 [1] 去掉外层方括号
          content = content.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
          content = content.replace(/^\[(\d+)\]$/, "$1");
          return "[" + content + "](" + href + ")";
        }});
        // 图片规则（defuddle 风格：srcset 智能选最高清 + alt 保留 + 懒加载占位回退）
        td.addRule("image", { filter: "img", replacement: function (content, node) {
          let src = node.getAttribute("src") || "";
          const dataSrc = node.getAttribute("data-src") || node.getAttribute("data-original") || node.getAttribute("data-lazy-src") || "";
          // 懒加载占位图（1x1 gif/png）时优先真实地址
          if (dataSrc && (!src || (/^data:image\/(?:gif|png)/i.test(src) && src.length < 300))) src = dataSrc;
          if (!src) src = dataSrc;
          const srcset = node.getAttribute("srcset");
          if (srcset) {
            let bestW = 0, bestUrl = src, parts = srcset.trim().split(/\s+/), urlParts = [];
            for (const t of parts) {
              const wm = t.match(/^(\d+)w,?$/);
              if (wm) { const w = parseInt(wm[1]); if (urlParts.length > 0 && w > bestW) { bestW = w; bestUrl = urlParts.join(" ").replace(/^,\s*/, ""); } urlParts = []; }
              else if (/^\d+(?:\.\d+)?x,?$/.test(t)) { urlParts = []; }
              else { urlParts.push(t); }
            }
            if (bestUrl) src = bestUrl;
          }
          if (src && !/^data:/i.test(src)) { try { src = new URL(src, url).href; } catch (e) {} }
          const alt = node.getAttribute("alt") || "";
          return src ? "![" + alt + "](" + src.replace(/([()])/g, "\\$1") + ")" : "";
        }});
        // figure 规则（defuddle 风格：图片 + 说明文字）
        td.addRule("figure", { filter: "figure", replacement: function (content, node) {
          const img = node.querySelector("img");
          const cap = node.querySelector("figcaption");
          if (!img) return content;
          let src = img.getAttribute("src") || "";
          const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || "";
          if (dataSrc && (!src || (/^data:image\/(?:gif|png)/i.test(src) && src.length < 300))) src = dataSrc;
          if (!src) src = dataSrc;
          const srcset = img.getAttribute("srcset");
          if (srcset) {
            let bestW = 0, bestUrl = src, parts = srcset.trim().split(/\s+/), urlParts = [];
            for (const t of parts) {
              const wm = t.match(/^(\d+)w,?$/);
              if (wm) { const w = parseInt(wm[1]); if (urlParts.length > 0 && w > bestW) { bestW = w; bestUrl = urlParts.join(" ").replace(/^,\s*/, ""); } urlParts = []; }
              else if (/^\d+(?:\.\d+)?x,?$/.test(t)) { urlParts = []; }
              else { urlParts.push(t); }
            }
            if (bestUrl) src = bestUrl;
          }
          if (src && !/^data:/i.test(src)) { try { src = new URL(src, url).href; } catch (e) {} }
          const alt = img.getAttribute("alt") || "";
          let caption = cap ? td.turndown(cap.innerHTML).trim() : "";
          return "![" + alt + "](" + src.replace(/([()])/g, "\\$1") + ")" + (caption ? "\n" + caption + "\n" : "");
        }});
        // 代码块规则（defuddle 风格：语言检测）
        td.addRule("preformattedCode", { filter: "pre", replacement: function (content, node) {
          // code 可能在 pre 内部（标准）或在 pre 外层（GfG: gfg-panel > code > div.highlight > pre）
          let codeEl = node.querySelector("code");
          if (!codeEl && node.closest) codeEl = node.closest("code");
          let lang = "";
          if (codeEl) {
            lang = codeEl.getAttribute("data-lang") || codeEl.getAttribute("data-language") || (codeEl.getAttribute("class") || "").match(/language-(\w+)/)?.[1] || "";
          }
          if (!lang && node.closest) {
            const panel = node.closest("[data-code-lang]");
            if (panel) lang = panel.getAttribute("data-code-lang") || "";
          }
          const text = (codeEl ? codeEl.textContent : node.textContent) || "";
          return "\n```" + lang + "\n" + text.trim().replace(/`/g, "\\`") + "\n```\n";
        }});
        // GfG 代码标签页标签（<gfg-tab>Python</gfg-tab>）不属于正文，移除
        td.addRule("gfgTab", { filter: function (node) {
          return node.nodeName.toLowerCase() === "gfg-tab" || node.nodeName.toLowerCase() === "gfg-tab-item";
        }, replacement: function () { return ""; }});
        // 公式规则（移植 defuddle：MathML/KaTeX/img → LaTeX，全站点通用）
        td.addRule("math", { filter: function (node) {
          const nn = node.nodeName.toLowerCase();
          return nn === "math" || (node.classList && (node.classList.contains("mwe-math-element") || node.classList.contains("mwe-math-fallback-image-inline") || node.classList.contains("mwe-math-fallback-image-display") || node.classList.contains("math") || node.classList.contains("katex")));
        }, replacement: function (content, node) {
          // 1. 从 annotation 提取 LaTeX（Wikipedia 标准）
          const ann = node.querySelector('annotation[encoding="application/x-tex"]');
          let latex = (ann && ann.textContent ? ann.textContent.trim() : "");
          // 2. data-latex 属性（KaTeX / 其他渲染器）
          if (!latex) latex = (node.getAttribute("data-latex") || "").trim();
          // 3. KaTeX 内嵌 MathML
          if (!latex) {
            const kmml = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]');
            latex = (kmml && kmml.textContent ? kmml.textContent.trim() : "");
          }
          // 4. alttext / img alt 兜底
          if (!latex) latex = (node.getAttribute("alttext") || "").trim();
          if (!latex && node.querySelector("img")) {
            latex = (node.querySelector("img").getAttribute("alt") || "").trim();
          }
          if (!latex) return content;

          // 判断行间/行内公式
          const isBlock = node.getAttribute("display") === "block"
            || node.classList.contains("mwe-math-fallback-image-display")
            || (node.parentNode && node.parentNode.nodeName === "P" && node.parentNode.children.length === 1);

          if (isBlock) {
            // 块级公式：检测 \begin{aligned} 等环境
            if (latex.includes("\\\\") || latex.includes("&")) {
              if (!/\\begin\{/.test(latex)) latex = "\\begin{aligned}\n" + latex + "\n\\end{aligned}";
            }
            return "\n$$\n" + latex + "\n$$\n";
          }
          return "$" + latex + "$";
        }});
        td.addRule("trimEmpty", { filter: function (node) { return node.nodeName === "P" && !node.textContent.trim(); }, replacement: function () { return ""; } });
        // 删除线（移植 defuddle）
        td.addRule("strikethrough", { filter: function (node) {
          return node.nodeName === "DEL" || node.nodeName === "S" || node.nodeName === "STRIKE";
        }, replacement: function (content) { return "~~" + content + "~~"; }});
        let md = td.turndown(cdoc.body || cdoc);
        // 后处理（defuddle 风格）：移除空链接 [](url)、清理多余空行
        md = md.replace(/\n*(?<!!)\[]\([^)]+\)\n*/g, "");
        md = md.replace(/\n{3,}/g, "\n\n");
        // 4. 外部链接转引用序号，内部链接保留可点击格式
        const mdWithCites = this._extractCitations(md, url);
        this.createClippedNote(title || article.title || "剪藏笔记", mdWithCites, url);
      } catch (e) {
        U.toast("剪藏失败：" + (e.message || String(e)));
      }
    },

    /** 启发式提取正文：Readability 失败时按 class 提示 + 文本密度选正文容器 */
    _heuristicArticle(doc) {
      const cands = doc.querySelectorAll('main, [role="main"], article, [class*="article"], [class*="content"], [class*="post"], [class*="entry"], [class*="viewer"]');
      let best = null, bestLen = 0;
      cands.forEach(el => {
        const cls = el.className || "";
        // 排除明显的导航/侧栏/页脚容器
        if (/(sidebar|nav|menu|footer|header|related|recommend|comment|breadcrumb|pagination|widget)/i.test(cls) && !/(article|content|post|entry|viewer)/i.test(cls)) return;
        const len = (el.textContent || "").trim().length;
        if (len > bestLen) { bestLen = len; best = el; }
      });
      // 至少要像样的正文量，避免捡到侧栏小卡片
      if (best && bestLen > 600 && best.querySelector("p, h1, h2, h3, pre, img")) {
        return { title: doc.title || "", content: best.innerHTML };
      }
      return null;
    },

    /** 用 defuddle 风格的评分找到正文容器（不丢图片和代码块，比 Readability 更可靠） */
    _findContentByScoring(doc) {
      const navWords = /\b(advertisement|all rights reserved|banner|cookie|comments|copyright|follow|footer|header|homepage|login|menu|more articles|more like this|most read|nav|navigation|newsletter|popular|privacy|recommended|register|related|responses|share|sidebar|sign in|sign up|signup|social|sponsored|subscribe|terms|trending)\b/i;
      let best = null, bestScore = 0;
      const body = doc.body || doc;
      // 候选：p, div, article, section, main, td (老式表格布局)
      body.querySelectorAll("p, div, article, section, main, td").forEach(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === "p" && el.textContent.trim().length < 80) return; // 短段落不参与
        const cls = (el.className || "").toLowerCase();
        const id = (el.id || "").toLowerCase();
        // 导航/侧栏/页脚 扣分
        let navPenalty = 0;
        if (navWords.test(cls) || navWords.test(id)) navPenalty = -200;
        if (/(sidebar|nav|menu|footer|header|related|recommend|comment|breadcrumb|pagination|widget|advert|banner|cookie|social|share|subscribe)/i.test(cls) && !/(article|content|post|entry|viewer|story|main)/i.test(cls)) navPenalty = -200;
        const text = el.textContent || "";
        const words = text.split(/\s+/).length;
        const paragraphs = el.getElementsByTagName("p").length;
        const commas = (text.match(/,/g) || []).length;
        const images = el.getElementsByTagName("img").length;
        const imageDensity = images / (words || 1);
        let score = words + paragraphs * 10 + commas - imageDensity * 3 + navPenalty;
        // 内容 class 加分
        if (/(content|article|post|entry|viewer|story|main)/i.test(cls)) score += 50;
        if (/(content|article|post|entry|main)/i.test(id)) score += 50;
        // 有 h1-h6 加分
        if (el.querySelector("h1, h2, h3, h4, h5, h6")) score += 30;
        if (score > bestScore) { bestScore = score; best = el; }
      });
      if (best && bestScore > 50) {
        const title = doc.title || "";
        return { title: title.replace(/\s*[-–—|]\s*[^-–—|]+$/, "").trim(), content: best.innerHTML };
      }
      // 回退到 Readability
      try { return new Readability(doc).parse(); } catch (e) { return null; }
    },

    /** 把 Markdown 里的 [文字](url) 外部链接替换成引用序号 [^n]，末尾列参考来源 */
    _extractCitations(markdown, pageUrl) {
      let md = markdown
        .replace(/\[edit\]/gi, "")
        .replace(/\[show\]/gi, "")
        .replace(/\[hide\]/gi, "")
        .replace(/\[citation needed\]/gi, "")
        .replace(/\[original research\?\]/gi, "")
        .replace(/\n{3,}/g, "\n\n");
      // 纯 URL 转成 [链接](url)
      md = md.replace(/(^|\s)(https?:\/\/[^\s\)\]\n]+)(?=\s|$)/g, '$1[$2]($2)');
      // 页面域名（用于区分内部/外部链接）
      let pageHost = "";
      try { pageHost = new URL(pageUrl).hostname; } catch (e) {}
      const re = /\[([^\]]+)\]\(((?:https?:\/\/)[^)]+)\)/g;
      const cites = [];
      const seen = new Map();
      const matches = [];
      let m;
      while ((m = re.exec(md))) {
        const title = m[1], link = m[2];
        // 只收集外部链接（不同域名），内部链接保留可点击的 [text](url) 格式
        let isExternal = true;
        try { isExternal = new URL(link).hostname !== pageHost; } catch (e) {}
        if (!isExternal) continue;
        if (!seen.has(link)) {
          seen.set(link, cites.length + 1);
          cites.push({ n: cites.length + 1, title, url: link });
        }
        matches.push({ index: m.index, length: m[0].length, title, link, n: seen.get(link) });
      }
      if (!cites.length) return md;
      // 从后往前替换（避免索引偏移）
      for (let i = matches.length - 1; i >= 0; i--) {
        const mt = matches[i];
        md = md.slice(0, mt.index) + mt.title + "[^" + mt.n + "]" + md.slice(mt.index + mt.length);
      }
      md += "\n\n参考来源：\n" + cites.map(c => "[^" + c.n + "] " + c.title + " - " + c.url).join("\n");
      return md;
    },

    /** 网页页面：直接打印已加载的 iframe（跨域也能 print，避免后端反爬）；失败则回退抓取正文 */
    convertWebPageToPdf(page) {
      const frame = document.querySelector(".web-frame");
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          return;
        } catch (e) { /* 跨域 print 被阻止时回退 */ }
      }
      const url = page.url;
      if (!url) { U.toast("这个网页页面没有网址"); return; }
      // 回退：抓取网页内容 → 美观 HTML → 打印窗口（另存为 PDF）
      const win = window.open("", "_blank", "width=920,height=720");
      if (!win) { U.toast("请允许弹窗后才能生成 PDF"); return; }
      win.document.open();
      win.document.write("<html><head><meta charset='utf-8'><style>body{font-family:sans-serif;padding:40px;color:#666}</style></head><body><p>正在获取网页内容…</p></body></html>");
      win.document.close();
      fetch("/api/web/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })
        .then(r => r.json().catch(() => ({})))
        .then(j => {
          const markdown = (j.markdown || "").trim();
          if (!markdown) { win.document.body.innerHTML = "<p>网页内容为空（该网站可能禁止服务器抓取）</p>"; return; }
          const title = j.title || U.segsText(page.title) || "网页";
          const html = this.markdownToPrintHtml(markdown, title);
          win.document.open();
          win.document.write(html);
          win.document.close();
          win.focus();
          setTimeout(() => { try { win.print(); } catch (e) { /* 忽略 */ } }, 500);
        })
        .catch(e => { win.document.body.innerHTML = "<p>获取网页失败：" + U.esc(e.message || String(e)) + "</p>"; });
    },

    /** 把网页 Markdown（含图片 base64）转成 Notionish 风格的可打印 HTML */
    markdownToPrintHtml(markdown, title) {
      const AI = global.AI;
      const inline = (AI && AI.inlineMarkdown) ? AI.inlineMarkdown.bind(AI) : ((s) => U.esc(s));
      const lines = String(markdown || "").split("\n");
      let body = "";
      let inCode = false, codeLines = [];
      const flushCode = () => {
        if (codeLines.length) body += "<pre><code>" + U.esc(codeLines.join("\n")) + "</code></pre>";
        codeLines = [];
      };
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith("```")) {
          if (inCode) { flushCode(); inCode = false; }
          else { inCode = true; codeLines = []; }
          continue;
        }
        if (inCode) { codeLines.push(lines[i]); continue; }
        if (!t) continue;
        let m;
        if ((m = t.match(/^!\[[^\]]*\]\(([^)]+)\)$/))) { body += '<img src="' + U.esc(m[1]) + '" alt="">'; continue; }
        if ((m = t.match(/^###\s+(.*)/))) { body += "<h3>" + inline(m[1]) + "</h3>"; continue; }
        if ((m = t.match(/^##\s+(.*)/))) { body += "<h2>" + inline(m[1]) + "</h2>"; continue; }
        if ((m = t.match(/^#\s+(.*)/))) { body += "<h1>" + inline(m[1]) + "</h1>"; continue; }
        if ((m = t.match(/^[-*]\s+(.*)/))) { body += "<div class='li'>• " + inline(m[1]) + "</div>"; continue; }
        if ((m = t.match(/^>\s?(.*)/))) { body += "<blockquote>" + inline(m[1]) + "</blockquote>"; continue; }
        body += "<p>" + inline(t) + "</p>";
      }
      if (inCode) flushCode();
      return "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><title>" + U.esc(title) + "</title><style>" +
        "body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:760px;margin:40px auto;padding:0 24px;line-height:1.7;color:#37352f}" +
        "h1{font-size:26px;line-height:1.3;margin:0 0 20px}h2{font-size:20px;line-height:1.3;margin:1em 0 .4em}h3{font-size:17px;line-height:1.3;margin:1em 0 .4em}" +
        "p{margin:.5em 0}img{max-width:100%;border-radius:8px;margin:12px 0}" +
        "pre{background:#f6f6f5;border:1px solid #eee;padding:12px;border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}" +
        "code{background:#f2f2f1;padding:1px 5px;border-radius:4px}pre code{background:transparent;padding:0}" +
        "blockquote{border-left:3px solid #ddd;padding:2px 16px;color:#666}" +
        ".li{padding-left:8px;margin:.3em 0}" +
        "</style></head><body><h1>" + U.esc(title) + "</h1>" + body + "</body></html>";
    },

    /** 打印前把页面上所有 Mermaid 图渲染成 SVG */
    async renderAllMermaidsForPrint(page) {
      const list = [];
      const walk = blocks => (blocks || []).forEach(b => {
        if (b.type === "mermaid") list.push(b);
        if (b.children && b.children.length) walk(b.children);
      });
      walk(page.children);
      await Promise.all(list.map(b => new Promise(resolve => {
        const blockEl = document.querySelector('.block[data-block-id="' + b.id + '"]');
        const preview = blockEl ? blockEl.querySelector(".mm-preview") : null;
        if (!preview || !preview.hidden) { resolve(); return; }
        const source = (b.attrs && b.attrs.source || "").trim();
        if (!source) { resolve(); return; }
        MermaidR.ready(() => {
          MermaidR.render(source).then(res => {
            if (res.ok) {
              preview.innerHTML = res.svg;
              preview.hidden = false;
              const ta = blockEl.querySelector(".mm-edit");
              if (ta) ta.hidden = true;
              const err = blockEl.querySelector(".mm-error");
              if (err) err.hidden = true;
            }
            resolve();
          });
        });
      })));
    },

    importFile(e) {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const res = S.importJSON(String(reader.result));
          U.toast("导入完成：新增 " + res.added + " 页，更新 " + res.replaced + " 页");
          Sidebar.refresh();
          this.route();
        } catch (err) {
          U.toast("导入失败：" + err.message);
        }
      };
      reader.readAsText(file);
    },

    openVersionHistory(page) {
      const modal = U.modal({ title: U.t("版本历史"), onClose: () => { Sidebar.refresh(); this.route(); } });
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const versions = S.getVersions(page.id);
      if (!versions.length) list.appendChild(U.el("div", "empty-state", "还没有历史版本，编辑后会自动记录"));
      versions.forEach(v => {
        const item = U.el("div", "ver-item");
        const info = U.el("div", "ver-info");
        info.innerHTML = '<div class="ver-time">' + U.fmtDate(v.at, true) + '</div><div class="ver-preview">' + U.esc(U.segsText(v.data.title) || "未命名") + '</div>';
        const restore = U.el("button", "db-btn", "恢复此版本");
        restore.addEventListener("click", async () => {
          const ok = await U.confirmModal({ title: U.t("恢复版本"), message: "恢复到此版本？当前内容将被此版本覆盖。", okText: "恢复" });
          if (ok) {
            S.restoreVersion(page.id, v.at);
            modal.close();
            Sidebar.refresh();
            this.route();
            U.toast("已恢复版本");
          }
        });
        item.appendChild(info); item.appendChild(restore);
        list.appendChild(item);
      });
    },

    /* ================= Reminders ================= */
    updateBell() {
      const bell = document.getElementById("topbar-bell");
      if (!bell) return;
      const pending = S.getReminders().filter(r => !r.done && r.at > Date.now()).length;
      bell.innerHTML = U.icon("bell", { size: 18 });
      if (pending) bell.appendChild(U.el("span", "bell-badge", String(pending)));
    },

    openRemindersPanel() {
      const modal = U.modal({ title: U.t("提醒"), onClose: () => this.updateBell() });
      const list = U.el("div", null);
      modal.body.appendChild(list);
      const render = () => {
        U.clear(list);
        const rs = S.getReminders();
        if (!rs.length) list.appendChild(U.el("div", "empty-state", "还没有提醒"));
        rs.forEach(r => {
          const item = U.el("div", "rem-item" + (r.done ? " done" : ""));
          const main = U.el("div", "rem-main");
          main.innerHTML = '<div class="rem-title">' + U.esc(r.title || "未命名") + '</div><div class="rem-time">⏰ ' + U.fmtDate(r.at, true) + (r.done ? " · 已完成" : "") + '</div>';
          const openBtn = U.el("button", "db-btn", "打开");
          openBtn.addEventListener("click", () => { modal.close(); if (r.pageId) this.openPage(r.pageId); });
          const doneBtn = U.el("button", "db-btn", r.done ? "↺ 恢复" : "✓ 完成");
          doneBtn.addEventListener("click", () => { S.toggleReminder(r.id, !r.done); render(); });
          const del = U.el("button", "icon-btn", U.icon("trash-2", { size: 16 }));
          del.title = U.t("删除提醒");
          del.addEventListener("click", () => { S.removeReminder(r.id); render(); });
          item.appendChild(main); item.appendChild(openBtn); item.appendChild(doneBtn); item.appendChild(del);
          list.appendChild(item);
        });
      };
      render();
      const foot = U.el("div", null);
      const add = U.el("button", "db-btn", "＋ 添加提醒");
      add.addEventListener("click", () => { modal.close(); this.openAddReminder(); });
      foot.appendChild(add);
      modal.foot.appendChild(foot);
    },

    openAddReminder(page) {
      const p = page || (S.currentPageId ? S.getPage(S.currentPageId) : null);
      const modal = U.modal({ title: U.t("添加提醒"), size: "sm" });
      const title = U.el("input", "modal-input");
      title.placeholder = "提醒内容";
      title.value = p ? (U.segsText(p.title) || "") : "";
      title.style.marginBottom = "8px";
      modal.body.appendChild(title);
      const dt = U.el("input", "modal-input");
      dt.type = "datetime-local";
      dt.style.marginBottom = "8px";
      modal.body.appendChild(dt);
      const ok = U.el("button", "db-btn primary", "添加");
      ok.style.marginLeft = "auto";
      modal.foot.appendChild(ok);
      const doAdd = () => {
        const at = dt.value ? new Date(dt.value).getTime() : Date.now() + 3600000;
        S.addReminder({ at, title: title.value.trim() || "提醒", pageId: p ? p.id : null });
        modal.close();
        this.updateBell();
        if (typeof Notification !== "undefined" && Notification.permission === "default") { try { Notification.requestPermission(); } catch (e) {} }
        U.toast("提醒已添加");
      };
      ok.addEventListener("click", doAdd);
      title.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
      title.focus();
    },

    checkReminders() {
      const now = Date.now();
      const due = (S.state.reminders || []).filter(r => !r.done && !r._notified && r.at <= now);
      due.forEach(r => {
        r._notified = true;
        U.toast("⏰ 提醒：" + (r.title || "未命名"), 6000);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try { new Notification("Notionish 提醒", { body: r.title || "未命名" }); } catch (e) {}
        }
      });
      if (due.length) { S.markDirty(); this.updateBell(); }
    },

    /* ================= Theme ================= */
    toggleTheme() {
      const cur = S.state.settings.theme || "light";
      S.state.settings.theme = cur === "light" ? "dark" : "light";
      S.markDirty();
      S.applyTheme();
      this.renderThemeButton();
    },

    renderThemeButton() {
      const btn = document.getElementById("sb-theme");
      if (!btn) return;
      const isLight = (S.state.settings.theme || "light") === "light";
      btn.innerHTML = U.icon(isLight ? "moon" : "sun", { size: 16 }) + " <span>" + (isLight ? "深色" : "浅色") + "</span>";
    },

    /* ================= AI 引用标注 ================= */
    /** 从当前页面块里解析「参考来源」：返回 [{ n, title, url }] */
    collectCitations() {
      const page = S.currentPageId ? S.getPage(S.currentPageId) : null;
      if (!page) return [];
      const cites = [];
      const re = /\[(?:\^)?(\d+)\]\s*([^-]+?)\s*-\s*(https?:\/\/[^\s\]]+)/g;
      const walk = blocks => (blocks || []).forEach(b => {
        const txt = U.segsText(b.text);
        let m;
        while ((m = re.exec(txt))) cites.push({ n: m[1], title: m[2].trim(), url: m[3] });
        if (b.children && b.children.length) walk(b.children);
      });
      walk(page.children);
      return cites;
    },

    openCitePanel(ref) {
      const cites = this.collectCitations();
      if (!cites.length) { U.toast("这个页面还没有参考来源（AI 生成时需带 [序号] 标注）"); return; }
      this.closeCitePanel();
      const panel = U.el("div", "cite-panel");
      panel.id = "cite-panel";
      const head = U.el("div", "cite-panel-head");
      head.appendChild(U.el("span", null, "📚 参考来源"));
      const close = U.el("button", "icon-btn", "✕");
      close.addEventListener("click", () => this.closeCitePanel());
      head.appendChild(close);
      panel.appendChild(head);
      const body = U.el("div", "cite-panel-body");
      let list = cites;
      if (ref) {
        const target = cites.find(c => c.n === ref);
        if (target) list = [target].concat(cites.filter(c => c !== target));
      }
      list.forEach(c => {
        const item = U.el("button", "cite-item");
        item.innerHTML = '<span class="cite-item-num">' + U.esc(c.n) + '</span><span class="cite-item-title">' + U.esc(c.title) + '</span><div class="cite-item-url">' + U.esc(c.url) + '</div>';
        item.addEventListener("click", () => { window.open(c.url, "_blank", "noopener"); });
        body.appendChild(item);
      });
      panel.appendChild(body);
      document.body.appendChild(panel);
    },

    closeCitePanel() {
      const p = document.getElementById("cite-panel");
      if (p) p.remove();
    },

    /* ================= Global shortcuts ================= */
    wireGlobal() {
      // Ctrl/Cmd 按住时标记 body（用于链接"Ctrl+点击跳转"的光标提示）
      const setCtrlLink = (on) => document.body.classList.toggle("ctrl-link", on);
      document.addEventListener("keydown", (e) => { if (e.ctrlKey || e.metaKey) setCtrlLink(true); });
      document.addEventListener("keyup", (e) => { if (!e.ctrlKey && !e.metaKey) setCtrlLink(false); });
      window.addEventListener("blur", () => setCtrlLink(false));
      document.addEventListener("click", (e) => {
        const cite = e.target && e.target.closest ? e.target.closest(".cite-ref") : null;
        if (cite) {
          e.preventDefault();
          this.openCitePanel(cite.getAttribute("data-ref"));
        }
      });
      document.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "k") {
          e.preventDefault();
          this.openSearchModal("");
        } else if (mod && e.key.toLowerCase() === "n") {
          e.preventDefault();
          this.newPage();
        } else if (mod && e.key === "\\") {
          e.preventDefault();
          this.toggleTheme();
        } else if (mod && e.key.toLowerCase() === "s") {
          e.preventDefault();
          S.save(true);
          U.toast("已保存");
        } else if (mod && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i" || e.key.toLowerCase() === "u")) {
          const active = document.activeElement;
          if (active && active.isContentEditable) {
            e.preventDefault();
            const cmd = { b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()];
            document.execCommand(cmd);
          }
        } else if (mod && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
          const active = document.activeElement;
          if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return; // 原生输入框撤销
          e.preventDefault();
          const isRedo = e.key.toLowerCase() === "y" || e.shiftKey;
          if (isRedo) S.redo(); else S.undo();
          U.toast(isRedo ? "已重做" : "已撤销");
          Sidebar.refresh();
          this.route();
        } else if (mod && e.shiftKey && e.key.toLowerCase() === "m") {
          // 块菜单快捷键
          const active = document.activeElement;
          const blockEl = active && active.closest ? active.closest(".block") : null;
          if (blockEl && blockEl.dataset.blockId) {
            e.preventDefault();
            const r = blockEl.getBoundingClientRect();
            Editor.openBlockMenu(blockEl.dataset.blockId, r.left + 24, r.top + 24);
          }
        } else if (!mod && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
          const active = document.activeElement;
          if (active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
          e.preventDefault();
          this.openShortcuts();
        }
      });

      // context menu on blocks → actions menu
      document.getElementById("content").addEventListener("contextmenu", (e) => {
        const blockEl = e.target.closest(".block");
        const curPage = Store.currentPageId ? Store.getPage(Store.currentPageId) : null;
        if (blockEl && curPage && !curPage.database) {
          e.preventDefault();
          Editor.openBlockMenu(blockEl.dataset.blockId, e.clientX, e.clientY);
        }
      });

      // tooltip helper
      document.addEventListener("mouseover", (e) => {
        const el = e.target.closest && e.target.closest("[title]");
        if (el && !el.dataset.noTip && el.title) {
          U.showTooltip(e.clientX, e.clientY, el.title);
        }
      });
      document.addEventListener("mouseout", () => U.hideTooltip());
      document.addEventListener("mousemove", (e) => {
        const tt = document.getElementById("tooltip-root");
        if (tt && tt.style.display === "block") {
          const r = tt.getBoundingClientRect();
          tt.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + "px";
          tt.style.top = (e.clientY + 16) + "px";
        }
      });
    },

    /** 快捷键帮助面板（按 ? 打开） */
    openShortcuts() {
      const modal = U.modal({ title: U.t("快捷键") });
      const list = U.el("div", "kbd-list");
      const rows = [
        ["Ctrl + K", "搜索页面 / 块"],
        ["Ctrl + N", "新建页面"],
        ["Ctrl + S", "保存"],
        ["Ctrl + \\", "切换深浅色主题"],
        ["Ctrl + Shift + A", "打开 / 关闭 AI 助手"],
        ["Ctrl + B / I / U", "加粗 / 斜体 / 下划线"],
        ["Ctrl + Z / Y", "撤销 / 重做"],
        ["Ctrl + Shift + M", "当前块的菜单"],
        ["/", "块斜杠菜单（输入 /）"],
        ["Tab / Shift+Tab", "块缩进 / 减少缩进"],
        ["Enter", "新建下一块"],
        ["Esc", "选中当前块"],
        ["右键", "块菜单（剪切 / 复制 / 粘贴 / 删除等）"],
        ["双击侧边栏标题", "行内重命名页面"],
        ["Ctrl + 点击链接", "新标签页打开链接"],
        ["?", "打开本帮助面板"],
      ];
      rows.forEach(([k, d]) => {
        const row = U.el("div", "kbd-row");
        row.innerHTML = '<span class="kbd">' + U.esc(k) + '</span><span class="kbd-desc">' + U.esc(d) + "</span>";
        list.appendChild(row);
      });
      modal.body.appendChild(list);
    },
  };

  global.App = App;

  document.addEventListener("DOMContentLoaded", () => App.boot());
})(window);
