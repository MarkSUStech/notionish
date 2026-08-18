/* ============ AI bridge: executes local MCP tools against browser storage ============ */
(function (global) {
  "use strict";

  function asError(message) {
    return { ok: false, error: String(message || U.t("未知错误")) };
  }

  function pageSummary(page) {
    return {
      id: page.id,
      parentId: page.parentId,
      title: U.segsText(page.title),
      icon: page.icon,
      database: !!page.database,
      code: !!page.code,
      web: !!page.web,
      url: page.url || "",
      pdf: !!page.pdf,
      page: page.page || 1,
      favorite: !!page.favorite,
      deleted: !!page.deleted,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
  }

  const Bridge = {
    token: null,
    polling: false,
    retryTimer: null,

    start() {
      if (this.polling || this.token) return;
      this.showStatus("connecting");
      this.getToken().then(ok => {
        if (ok) this.pollLoop();
      });
    },

    async getToken() {
      try {
        const response = await fetch("/api/bridge/token", { cache: "no-store" });
        if (!response.ok) throw new Error(U.t("本地 MCP 服务未启动"));
        const data = await response.json();
        if (!data || typeof data.token !== "string") throw new Error(U.t("MCP 服务未返回令牌"));
        this.token = data.token;
        this.showStatus("online");
        return true;
      } catch (error) {
        this.token = null;
        this.showStatus("offline");
        return false;
      }
    },

    async pollLoop() {
      if (this.polling || !this.token) return;
      this.polling = true;
      while (this.token) {
        try {
          const response = await fetch("/api/bridge/poll?token=" + encodeURIComponent(this.token), { cache: "no-store" });
          if (!response.ok) throw new Error(U.t("桥接轮询失败"));
          const data = await response.json();
          if (data && data.request) await this.handleRequest(data.request);
          else await this.pause(500);
        } catch (error) {
          this.token = null;
          this.showStatus("offline");
          this.retryTimer = setTimeout(() => this.start(), 2500);
        }
      }
      this.polling = false;
    },

    async handleRequest(request) {
      const output = this.run(request);
      try {
        await fetch("/api/bridge/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: this.token, id: request.id, ok: output.ok, result: output.result, error: output.error }),
        });
      } catch (error) {
        // The server timeout returns a clear error to the MCP caller.
      }
    },

    pause(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    showStatus(state) {
      let badge = document.getElementById("ai-bridge-status");
      const topbar = document.getElementById("topbar");
      if (!badge && topbar) {
        badge = U.el("span", "ai-bridge-status");
        badge.id = "ai-bridge-status";
        topbar.appendChild(badge);
      }
      if (!badge) return;
      badge.className = "ai-bridge-status " + state;
      badge.textContent = state === "online" ? U.t("AI 已连接") : state === "connecting" ? U.t("AI 连接中") : U.t("AI 未连接");
      badge.title = state === "online" ? U.t("本地 MCP 浏览器桥接已连接") : U.t("请使用 node server.js 打开此页面以连接本地 MCP");
    },

    run(request) {
      if (!request || typeof request.tool !== "string") return asError(U.t("无效的桥接请求"));
      try {
        return this.execute(request.tool, request.args || {});
      } catch (error) {
        return asError(error && error.message ? error.message : error);
      }
    },

    execute(tool, args) {
      const S = global.Store;
      if (!S || !S.state) return asError(U.t("工作区尚未初始化"));
      const write = () => {
        S.save(true);
        if (global.App && typeof global.App.route === "function") global.App.route();
      };
      const page = id => {
        const value = S.getPage(id);
        if (!value) throw new Error(U.t("页面不存在: ") + id);
        return value;
      };
      const block = (pageId, blockId) => {
        const value = S.findBlock(page(pageId), blockId);
        if (!value) throw new Error(U.t("块不存在: ") + blockId);
        return value;
      };
      const result = value => ({ ok: true, result: value });
      const parseText = (text, type) => type === "equation"
        ? [{ t: text }]
        : (global.AI && global.AI.inlineToSegments ? global.AI.inlineToSegments(text) : [{ t: text }]);

      switch (tool) {
        case "workspace.get":
          return result({
            theme: S.state.settings && S.state.settings.theme || "light",
            pageCount: Object.keys(S.state.pages || {}).length,
            questionCount: Object.keys(S.state.questions || {}).length,
            flashcardCount: Object.keys(S.state.flashcards || {}).length,
            templateCount: (S.state.templates || []).length,
            reminderCount: (S.state.reminders || []).length,
          });
        case "workspace.update_theme":
          if (!["light", "dark"].includes(args.theme)) return asError(U.t("theme 必须为 light 或 dark"));
          S.state.settings.theme = args.theme;
          S.applyTheme();
          S.markDirty();
          write();
          return result({ theme: args.theme });

        case "page.list":
          return result(Object.values(S.state.pages || {}).filter(p => args.includeTrash || !p.deleted).map(pageSummary));
        case "page.get": {
          const value = page(args.id);
          return result(U.clone(value));
        }
        case "page.create": {
          const value = S.createPage(args.parentId || "root", {
            title: typeof args.title === "string" ? args.title : "",
            icon: typeof args.icon === "string" ? args.icon : undefined,
            database: !!args.database,
            code: !!args.code,
            language: typeof args.language === "string" ? args.language : undefined,
            web: !!args.web,
            url: typeof args.url === "string" ? args.url : undefined,
            pdf: !!args.pdf,
            page: Number.isInteger(args.page) ? args.page : undefined,
          });
          write();
          return result(pageSummary(value));
        }
        case "page.update": {
          const value = page(args.id);
          if (typeof args.title === "string") value.title = [{ t: args.title }];
          if (typeof args.icon === "string") value.icon = args.icon;
          if (typeof args.cover === "string") value.cover = args.cover;
          if (typeof args.favorite === "boolean") value.favorite = args.favorite;
          if (typeof args.source === "string" && value.codeData) value.codeData.source = args.source;
          if (typeof args.deleted === "boolean") S.setPageDeleted(value.id, args.deleted);
          else { S.touch(value); S.markDirty(); }
          write();
          return result(pageSummary(page(value.id)));
        }
        case "page.delete":
          page(args.id);
          S.deletePage(args.id, !!args.permanent);
          write();
          return result({ id: args.id, deleted: true, permanent: !!args.permanent });
        case "page.move":
          page(args.id);
          if (!S.movePage(args.id, args.parentId, Number.isFinite(args.order) ? args.order : undefined)) return asError(U.t("页面移动失败"));
          write();
          return result(pageSummary(page(args.id)));

        case "block.list": 
          return result(U.clone(page(args.pageId).children || []));
        case "block.create": {
          const owner = page(args.pageId);
          const value = S.newBlock(args.type);
          if (typeof args.text === "string") value.text = parseText(args.text, value.type);
          if (args.attrs && typeof args.attrs === "object" && !Array.isArray(args.attrs)) Object.assign(value.attrs, U.clone(args.attrs));
          let index = Number.isInteger(args.index) ? args.index : undefined;
          if (index === undefined) {
            const afterIdx = typeof args.after === "string" ? owner.children.findIndex(b => b.id === args.after) : -1;
            const beforeIdx = typeof args.before === "string" ? owner.children.findIndex(b => b.id === args.before) : -1;
            if (afterIdx >= 0) index = afterIdx + 1;
            else if (beforeIdx >= 0) index = beforeIdx;
          }
          S.insertBlock(owner, value, index);
          if (value.type === "question") S.createQuestion(owner.id, value.id, { type: "single" });
          if (value.type === "flashcard") S.createFlashcard(owner.id, value.id, {});
          write();
          return result(U.clone(value));
        }
        case "block.update": {
          const owner = page(args.pageId);
          const value = block(owner.id, args.blockId);
          const nextType = typeof args.type === "string" ? args.type : value.type;
          if (typeof args.text === "string") value.text = parseText(args.text, nextType);
          if (typeof args.type === "string") value.type = args.type;
          if (args.attrs && typeof args.attrs === "object" && !Array.isArray(args.attrs)) Object.assign(value.attrs, U.clone(args.attrs));
          S.touch(owner);
          S.markDirty();
          write();
          return result(U.clone(value));
        }
        case "block.move": {
          const owner = page(args.pageId);
          block(owner.id, args.blockId);
          if (args.targetId) block(owner.id, args.targetId);
          S.moveBlock(owner, args.blockId, args.targetId || null, args.position || "after");
          write();
          return result({ id: args.blockId, moved: true });
        }
        case "block.delete": {
          const owner = page(args.pageId);
          block(owner.id, args.blockId);
          const removed = S.removeBlock(owner, args.blockId);
          if (!removed) return asError("块删除失败");
          write();
          return result({ id: args.blockId, deleted: true });
        }
        case "block_comment.list":
          return result(U.clone(block(args.pageId, args.blockId).comments || []));
        case "block_comment.create": {
          if (typeof args.text !== "string" || !args.text.trim()) return asError("评论需要 text");
          const owner = page(args.pageId);
          const value = block(owner.id, args.blockId);
          value.comments = value.comments || [];
          const comment = { id: U.uid("cm"), text: args.text.trim(), createdAt: Date.now() };
          value.comments.push(comment);
          S.touch(owner);
          S.markDirty();
          write();
          return result(U.clone(comment));
        }
        case "block_comment.delete": {
          const owner = page(args.pageId);
          const value = block(owner.id, args.blockId);
          const before = (value.comments || []).length;
          value.comments = (value.comments || []).filter(comment => comment.id !== args.commentId);
          if (value.comments.length === before) return asError("评论不存在: " + args.commentId);
          S.touch(owner);
          S.markDirty();
          write();
          return result({ id: args.commentId, deleted: true });
        }
        case "database_schema.get": {
          const db = page(args.databaseId);
          if (!db.database) return asError("目标页面不是数据库");
          return result(U.clone({ props: db.schema && db.schema.props || [], viewState: db.viewState || {} }));
        }
        case "database_schema.update": {
          const db = page(args.databaseId);
          if (!db.database) return asError("目标页面不是数据库");
          if (args.props !== undefined) {
            if (!Array.isArray(args.props) || !args.props.length) return asError("数据库至少需要一个属性");
            db.schema = db.schema || {};
            db.schema.props = U.clone(args.props);
          }
          if (args.viewState !== undefined) {
            if (!args.viewState || typeof args.viewState !== "object" || Array.isArray(args.viewState)) return asError("viewState 必须是对象");
            db.viewState = U.clone(args.viewState);
          }
          S.touch(db);
          S.markDirty();
          write();
          return result(U.clone({ props: db.schema.props, viewState: db.viewState || {} }));
        }

        case "database_row.create": {
          const db = page(args.databaseId);
          if (!db.database) return asError("目标页面不是数据库");
          const row = S.createRow(db, typeof args.title === "string" ? args.title : "未命名");
          write();
          return result(pageSummary(row));
        }
        case "database_row.update": {
          const db = page(args.databaseId);
          if (!db.database) return asError("目标页面不是数据库");
          const row = page(args.rowId);
          if (!args.props || typeof args.props !== "object" || Array.isArray(args.props)) return asError("props 必须是对象");
          Object.entries(args.props).forEach(([propId, value]) => S.setPropValue(db, row, { id: propId }, value));
          write();
          return result(U.clone(row));
        }
        case "database_row.delete": {
          const db = page(args.databaseId);
          if (!db.database) return asError("目标页面不是数据库");
          const row = page(args.rowId);
          if (row.parentId !== db.id) return asError("记录不属于指定数据库");
          S.deletePage(args.rowId, true);
          write();
          return result({ id: args.rowId, deleted: true });
        }

        case "question.list":
          return result(S.getQuestions().map(q => U.clone(q)));
        case "question.get": {
          const value = S.getQuestion(args.id);
          if (!value) return asError("题目不存在: " + args.id);
          return result(U.clone(value));
        }
        case "question.create": {
          const value = S.createQuestion(null, null, args);
          write();
          return result(U.clone(value));
        }
        case "question.update": {
          const patch = Object.assign({}, args);
          delete patch.id;
          const value = S.updateQuestion(args.id, patch);
          if (!value) return asError("题目不存在: " + args.id);
          write();
          return result(U.clone(value));
        }
        case "question.delete":
          if (!S.getQuestion(args.id)) return asError("题目不存在: " + args.id);
          S.deleteQuestion(args.id);
          write();
          return result({ id: args.id, deleted: true });

        case "flashcard.list":
          return result(S.getFlashcards().map(card => U.clone(card)));
        case "flashcard.get": {
          const value = S.getFlashcard(args.id);
          if (!value) return asError("闪卡不存在: " + args.id);
          return result(U.clone(value));
        }
        case "flashcard.create": {
          if (typeof args.front !== "string" || typeof args.back !== "string") return asError("闪卡需要 front 和 back 文本");
          const value = S.createFlashcard(null, null, args);
          write();
          return result(U.clone(value));
        }
        case "flashcard.update": {
          const patch = Object.assign({}, args);
          delete patch.id;
          const value = S.updateFlashcard(args.id, patch);
          if (!value) return asError("闪卡不存在: " + args.id);
          write();
          return result(U.clone(value));
        }
        case "flashcard.delete":
          if (!S.getFlashcard(args.id)) return asError("闪卡不存在: " + args.id);
          S.deleteFlashcard(args.id);
          write();
          return result({ id: args.id, deleted: true });

        case "template.list":
          return result(U.clone(S.getTemplates()));
        case "template.create": {
          if (typeof args.name !== "string" || !args.name.trim()) return asError("模板需要 name");
          const value = S.addTemplate({ name: args.name.trim(), data: args.data && typeof args.data === "object" ? U.clone(args.data) : {} });
          write();
          return result(U.clone(value));
        }
        case "template.delete":
          S.removeTemplate(args.id);
          write();
          return result({ id: args.id, deleted: true });

        case "reminder.list":
          return result(U.clone(S.getReminders()));
        case "reminder.create": {
          if (!Number.isFinite(args.at)) return asError("提醒需要有效的 at 毫秒时间戳");
          const value = S.addReminder({ at: args.at, title: typeof args.title === "string" ? args.title : "提醒", pageId: typeof args.pageId === "string" ? args.pageId : null });
          write();
          return result(U.clone(value));
        }
        case "reminder.complete":
          S.toggleReminder(args.id, args.done !== false);
          write();
          return result({ id: args.id, done: args.done !== false });
        case "reminder.delete":
          S.removeReminder(args.id);
          write();
          return result({ id: args.id, deleted: true });
        default:
          return asError("未允许的浏览器桥接工具: " + tool);
      }
    },
  };

  global.Bridge = Bridge;
})(window);
