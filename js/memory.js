/* ============ Long-term memory management page ============ */
(function (global) {
  "use strict";

  const request = async (url, options) => {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (U.t("请求失败：") + response.status));
    return body;
  };

  const formatTime = value => {
    if (!value) return U.t("从未");
    try { return new Date(value).toLocaleString("zh-CN"); } catch (error) { return U.t("未知"); }
  };

  const MemoryPage = {
    entries: [],

    async render() {
      const content = document.getElementById("content");
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll memory-page");
      content.appendChild(scroll);
      this.renderHeader(scroll);
      const body = U.el("div", "memory-list");
      body.appendChild(U.el("div", "empty-state", U.t("正在加载记忆…")));
      scroll.appendChild(body);
      try {
        const result = await request("/api/memory/list");
        this.entries = Array.isArray(result.entries) ? result.entries : [];
        this.renderList(body);
      } catch (error) {
        this.renderError(body, error);
      }
    },

    renderHeader(scroll) {
      const header = U.el("div", "memory-header");
      const copy = U.el("div", "memory-header-copy");
      copy.appendChild(U.el("div", "settings-title", U.t("记忆")));
      copy.appendChild(U.el("div", "settings-section-desc", U.t("这里汇总 AI 助手的全部长期记忆。修改后会同步用于近期提示和按需检索。")));
      const add = U.el("button", "db-btn primary", U.t("＋ 添加记忆"));
      add.addEventListener("click", () => this.create());
      header.appendChild(copy);
      header.appendChild(add);
      scroll.appendChild(header);
      const count = U.el("div", "memory-count", "");
      count.dataset.role = "memory-count";
      scroll.appendChild(count);
    },

    renderList(body) {
      U.clear(body);
      const count = document.querySelector('[data-role="memory-count"]');
      if (count) count.textContent = this.entries.length + " " + U.t("条长期记忆");
      if (!this.entries.length) {
        body.appendChild(U.el("div", "empty-state", U.t("还没有长期记忆。点击“添加记忆”创建第一条。")));
        return;
      }
      this.entries.forEach(entry => body.appendChild(this.renderCard(entry)));
    },

    renderCard(entry) {
      const card = U.el("article", "memory-card");
      card.dataset.id = entry.id;
      const text = U.el("textarea", "memory-text");
      text.value = entry.text || "";
      text.maxLength = 2000;
      text.rows = 4;
      text.setAttribute("aria-label", U.t("记忆正文"));

      const footer = U.el("div", "memory-card-footer");
      const meta = U.el("div", "memory-meta", U.t("创建于") + " " + formatTime(entry.createdAt) + " · " + U.t("最近访问") + " " + formatTime(entry.lastAccess));
      const actions = U.el("div", "memory-actions");
      const label = U.el("label", "memory-importance-label", U.t("重要性"));
      const importance = U.el("select", "memory-importance");
      importance.setAttribute("aria-label", U.t("记忆重要性"));
      for (let value = 1; value <= 5; value++) {
        const option = U.el("option", null, value + (value === 1 ? " · " + U.t("低") : value === 5 ? " · " + U.t("高") : ""));
        option.value = String(value);
        option.selected = value === Number(entry.importance);
        importance.appendChild(option);
      }
      label.appendChild(importance);
      const save = U.el("button", "db-btn primary", U.t("保存"));
      save.addEventListener("click", () => this.save(entry.id, text, importance, save));
      const remove = U.el("button", "db-btn danger", U.t("删除"));
      remove.addEventListener("click", () => this.remove(entry.id));
      actions.appendChild(label);
      actions.appendChild(save);
      actions.appendChild(remove);
      footer.appendChild(meta);
      footer.appendChild(actions);
      card.appendChild(text);
      card.appendChild(footer);
      return card;
    },

    renderError(body, error) {
      U.clear(body);
      const wrap = U.el("div", "empty-state");
      wrap.appendChild(U.el("div", "es-ico", "⚠️"));
      wrap.appendChild(U.el("div", null, U.t("记忆加载失败：") + error.message));
      const retry = U.el("button", "db-btn", U.t("重试"));
      retry.addEventListener("click", () => this.render());
      wrap.appendChild(retry);
      body.appendChild(wrap);
    },

    async create() {
      try {
        const result = await request("/api/memory/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: U.t("新记忆"), importance: 3 }),
        });
        this.entries.unshift(result.entry);
        const body = document.querySelector(".memory-list");
        if (body) this.renderList(body);
        setTimeout(() => {
          const text = document.querySelector('.memory-card[data-id="' + result.entry.id + '"] .memory-text');
          if (text) { text.focus(); text.select(); }
        }, 0);
        U.toast(result.indexed ? U.t("已添加记忆") : U.t("已添加记忆；向量索引暂未同步"));
      } catch (error) {
        U.toast(U.t("添加失败：") + error.message);
      }
    },

    async save(id, text, importance, button) {
      const value = text.value.trim();
      if (!value) { U.toast(U.t("记忆正文不能为空")); text.focus(); return; }
      button.disabled = true;
      try {
        const result = await request("/api/memory/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: value, importance: Number(importance.value) }),
        });
        const position = this.entries.findIndex(entry => entry.id === id);
        if (position >= 0) this.entries[position] = result.entry;
        U.toast(result.indexed ? U.t("记忆已保存") : U.t("记忆已保存；向量索引暂未同步"));
      } catch (error) {
        U.toast(U.t("保存失败：") + error.message);
      } finally {
        button.disabled = false;
      }
    },

    async remove(id) {
      const confirmed = await U.confirmModal(U.t("删除记忆"), U.t("确定永久删除这条长期记忆吗？此操作不可撤销。"), U.t("删除"));
      if (!confirmed) return;
      try {
        await request("/api/memory/" + encodeURIComponent(id), { method: "DELETE" });
        this.entries = this.entries.filter(entry => entry.id !== id);
        const body = document.querySelector(".memory-list");
        if (body) this.renderList(body);
        U.toast(U.t("记忆已删除"));
      } catch (error) {
        U.toast(U.t("删除失败：") + error.message);
      }
    },
  };

  global.MemoryPage = MemoryPage;
})(window);
