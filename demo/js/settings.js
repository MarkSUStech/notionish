/* ============ Settings page: theme, AI config, index, data ============ */
(function (global) {
  "use strict";

  const Settings = {
    render() {
      const content = document.getElementById("content");
      content.innerHTML = "";
      const scroll = U.el("div", "page-scroll settings-scroll");
      scroll.style.maxWidth = "640px";
      content.appendChild(scroll);

      scroll.appendChild(U.el("div", "settings-title", U.t("设置")));
      this.renderMemory(scroll);
      this.renderTheme(scroll);
      this.renderLayout(scroll);
      this.renderAI(scroll);
      this.renderData(scroll);
    },


    section(title, desc) {
      const wrap = U.el("div", "settings-section");
      wrap.appendChild(U.el("div", "settings-section-title", U.t(title)));
      if (desc) wrap.appendChild(U.el("div", "settings-section-desc", U.t(desc)));
      return wrap;
    },

    renderMemory(scroll) {
      const sec = this.section("长期记忆", "查看和维护 AI 助手保存的全部长期记忆。");
      const row = U.el("div", "settings-row");
      const open = U.el("button", "db-btn primary", U.t("🧠 打开记忆"));
      open.addEventListener("click", () => global.App.openPage("memory"));
      row.appendChild(open);
      sec.appendChild(row);
      scroll.appendChild(sec);
    },

    renderTheme(scroll) {
      const S = global.Store;
      const sec = this.section("外观", "选择应用主题（快捷键 Ctrl+\\）。");
      const row = U.el("div", "settings-row");
      ["light", "dark"].forEach(t => {
        const btn = U.el("button", "db-btn" + (S.state.settings.theme === t ? " primary" : ""), t === "light" ? U.t("☀️ 浅色") : U.t("🌙 深色"));
        btn.addEventListener("click", () => {
          S.state.settings.theme = t;
          S.markDirty();
          S.applyTheme();
          S.save(true);
          this.render();
        });
        row.appendChild(btn);
      });
      sec.appendChild(row);
      scroll.appendChild(sec);
    },

    renderLayout(scroll) {
      const S = global.Store;
      const sec = this.section("布局", "调整页面内容宽度与正文行间距。");

      sec.appendChild(U.el("div", "q-form-label", U.t("页宽")));
      const widthRow = U.el("div", "settings-row");
      [["640px", "窄"], ["760px", "标准"], ["960px", "宽"], ["100%", "全宽"]].forEach(([v, l]) => {
        const btn = U.el("button", "db-btn" + (S.state.settings.pageWidth === v ? " primary" : ""), U.t(l));
        btn.addEventListener("click", () => {
          S.state.settings.pageWidth = v;
          S.markDirty();
          S.applyLayout();
          S.save(true);
          this.render();
        });
        widthRow.appendChild(btn);
      });
      sec.appendChild(widthRow);

      sec.appendChild(U.el("div", "q-form-label", U.t("行间距")));
      const lineRow = U.el("div", "settings-row");
      [[1.4, "紧凑"], [1.62, "标准"], [1.9, "宽松"], [2.2, "极宽"]].forEach(([v, l]) => {
        const btn = U.el("button", "db-btn" + (Math.abs(S.state.settings.lineHeight - v) < 0.01 ? " primary" : ""), U.t(l));
        btn.addEventListener("click", () => {
          S.state.settings.lineHeight = v;
          S.markDirty();
          S.applyLayout();
          S.save(true);
          this.render();
        });
        lineRow.appendChild(btn);
      });
      sec.appendChild(lineRow);

      // 字体选择
      sec.appendChild(U.el("div", "q-form-label", U.t("字体")));
      const fontRow = U.el("div", "settings-row");
      [
        ["default", "默认"],
        ["hei", "黑体"],
        ["song", "宋体"],
        ["kai", "楷体"],
        ["serif", "衬线"],
        ["mono", "等宽"],
      ].forEach(([v, l]) => {
        const btn = U.el("button", "db-btn" + (S.state.settings.fontFamily === v ? " primary" : ""), U.t(l));
        btn.addEventListener("click", () => {
          S.state.settings.fontFamily = v;
          S.markDirty();
          S.applyLayout();
          S.save(true);
          this.render();
        });
        fontRow.appendChild(btn);
      });
      sec.appendChild(fontRow);

      // 字号选择
      sec.appendChild(U.el("div", "q-form-label", U.t("字号")));
      const sizeRow = U.el("div", "settings-row");
      [
        [14, "小"],
        [15, "较小"],
        [16, "标准"],
        [17, "较大"],
        [18, "大"],
        [20, "特大"],
      ].forEach(([v, l]) => {
        const btn = U.el("button", "db-btn" + (S.state.settings.fontSize === v ? " primary" : ""), U.t(l) + " (" + v + "px)");
        btn.addEventListener("click", () => {
          S.state.settings.fontSize = v;
          S.markDirty();
          S.applyLayout();
          S.save(true);
          this.render();
        });
        sizeRow.appendChild(btn);
      });
      sec.appendChild(sizeRow);

      // 语言切换（与字体/字号同风格）
      sec.appendChild(U.el("div", "q-form-label", U.t("语言")));
      const langRow = U.el("div", "settings-row");
      const curLang = (global.I18n && I18n.lang) || "zh";
      ["zh", "en"].forEach(lang => {
        const label = lang === "zh" ? U.t("中文") : U.t("English");
        const btn = U.el("button", "db-btn" + (curLang === lang ? " primary" : ""), label);
        btn.addEventListener("click", () => { if (global.I18n && I18n.lang !== lang) { I18n.setLang(lang); location.reload(); } });
        langRow.appendChild(btn);
      });
      sec.appendChild(langRow);

      scroll.appendChild(sec);
    },

    renderAI(scroll) {
      const sec = this.section("AI 助手", "检索走 Ollama（可在另一台机器上），生成走 OpenAI 兼容接口。API Key 只保存在本机服务端 ai-config.json，不会进入浏览器。");
      const form = U.el("div", "settings-form");
      const field = (label, key, ph, type) => {
        form.appendChild(U.el("div", "q-form-label", U.t(label)));
        const input = U.el("input", "modal-input");
        input.type = type || "text";
        input.placeholder = ph || "";
        input.dataset.key = key;
        form.appendChild(input);
        return input;
      };
      const ollama = field("Ollama 地址", "ollamaUrl", "http://127.0.0.1:11434");
      const embed = field("Embedding 模型", "embedModel", "nomic-embed-text");
      const base = field("OpenAI Base URL", "openaiBaseUrl", "https://api.openai.com/v1");
      const model = field("OpenAI 模型名", "openaiModel", "gpt-4o-mini");
      const key = field("OpenAI API Key", "openaiApiKey", "sk-...", "password");
      const searxng = field("SearXNG 地址（可选，联网搜索用）", "searxngUrl", "http://127.0.0.1:8080");
      const ytKey = field("YouTube API Key（可选，视频搜索用）", "youtubeApiKey", "AIza...", "password");

      fetch("/api/ai/config").then(r => { if (r.ok) return r.json(); throw 0; }).then(cfg => {
        ollama.value = cfg.ollamaUrl || "";
        embed.value = cfg.embedModel || "";
        base.value = cfg.openaiBaseUrl || "";
        model.value = cfg.openaiModel || "";
        searxng.value = cfg.searxngUrl || "";
        ytKey.placeholder = cfg.youtubeApiKey ? U.t("已配置（留空则保持不变）") : "AIza...";
        key.placeholder = cfg.configured ? U.t("已配置（留空则保持不变）") : "sk-...";
      }).catch(() => {});

      const status = U.el("div", "settings-status", U.t("索引状态加载中…"));
      fetch("/api/ai/status").then(r => { if (r.ok) return r.json(); throw 0; }).then(st => {
        status.textContent = st.configured ? (U.t("AI 已就绪 · 索引") + " " + st.indexSize + " " + U.t("段")) : U.t("未配置 API Key");
      }).catch(() => { status.textContent = U.t("本地服务未启动：请用 node server.js 打开 http://127.0.0.1:8787"); });

      const row = U.el("div", "settings-row");
      const save = U.el("button", "db-btn primary", U.t("保存 AI 配置"));
      save.addEventListener("click", async () => {
        const payload = {};
        form.querySelectorAll("input[data-key]").forEach(inp => { const v = inp.value.trim(); if (v) payload[inp.dataset.key] = v; });
        try {
          const res = await fetch("/api/ai/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            U.toast(U.t("保存失败：") + (j.error || res.status) + U.t("。请确认已用 node server.js 启动并刷新页面"));
            return;
          }
          U.toast(U.t("已保存 AI 配置"));
          if (global.AI) { AI.refreshStatus(); AI.scheduleSync(); }
        } catch (e) {
          U.toast(U.t("保存失败：无法连接本地服务，请用 node server.js 启动后重试"));
        }
      });
      const rebuild = U.el("button", "db-btn", U.t("🔄 重建索引"));
      rebuild.addEventListener("click", () => { if (global.AI) AI.rebuildIndex(); });
      row.appendChild(save);
      row.appendChild(rebuild);
      form.appendChild(row);
      form.appendChild(status);
      sec.appendChild(form);
      scroll.appendChild(sec);
    },

    renderData(scroll) {
      const sec = this.section("数据", "导出全部数据为 JSON，或从备份导入合并恢复。");
      const row = U.el("div", "settings-row");
      const exp = U.el("button", "db-btn", U.t("⬇️ 导出数据"));
      exp.addEventListener("click", () => global.App.exportAll());
      const imp = U.el("button", "db-btn", U.t("⬆️ 导入数据"));
      const fileInput = U.el("input", null);
      fileInput.type = "file";
      fileInput.accept = "application/json,.json";
      fileInput.hidden = true;
      fileInput.addEventListener("change", e => global.App.importFile(e));
      imp.addEventListener("click", () => fileInput.click());
      sec.appendChild(fileInput);
      row.appendChild(exp);
      row.appendChild(imp);
      sec.appendChild(row);
      scroll.appendChild(sec);
    },
  };

  global.Settings = Settings;
})(window);
