/* ============ Web browser page: address bar + embedded iframe ============ */
(function (global) {
  "use strict";

  const WebBrowser = {
    page: null,

    render(page) {
      this.page = page;
      const content = U.renderRoot();
      content.innerHTML = "";

      const wrap = U.el("div", "web-page");
      const bar = U.el("div", "web-bar");

      const back = U.el("button", "web-btn", "←");
      back.title = "后退";
      const fwd = U.el("button", "web-btn", "→");
      fwd.title = "前进";
      const reload = U.el("button", "web-btn", "↻");
      reload.title = "刷新";
      const input = U.el("input", "web-url");
      input.type = "text";
      input.spellcheck = false;
      input.placeholder = "输入网址，如 example.com…";
      input.value = page.url || "";
      const open = U.el("button", "web-btn", "↗");
      open.title = "在新标签页打开";
      const clip = U.el("button", "web-btn", "📝");
      clip.title = "保存为笔记（服务器抓取正文）";
      clip.style.cssText = "margin-left:auto";

      bar.appendChild(back);
      bar.appendChild(fwd);
      bar.appendChild(reload);
      bar.appendChild(input);
      bar.appendChild(clip);
      bar.appendChild(open);
      wrap.appendChild(bar);

      const hint = U.el("div", "web-hint", "提示：部分网站（YouTube、需登录或 Cloudflare 防护的站点）禁止被嵌入；若无法加载，请点 ↗ 在浏览器打开。");
      wrap.appendChild(hint);

      const frame = U.el("iframe", "web-frame");
      frame.allow = "fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture; display-capture";
      frame.referrerPolicy = "no-referrer-when-downgrade";
      wrap.appendChild(frame);
      content.appendChild(wrap);

      const load = (url) => {
        const raw = String(url || "").trim();
        page.url = raw;
        input.value = raw;
        if (!raw) { frame.removeAttribute("src"); return; }
        const normalized = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
        try { frame.src = normalized; } catch (e) { /* invalid url */ }
        global.Store.touch(page);
        global.Store.markDirty();
      };
      if (page.url) load(page.url);

      back.addEventListener("click", () => {
        try { frame.contentWindow.history.back(); } catch (e) { /* cross-origin */ }
      });
      fwd.addEventListener("click", () => {
        try { frame.contentWindow.history.forward(); } catch (e) { /* cross-origin */ }
      });
      reload.addEventListener("click", () => {
        try { frame.contentWindow.location.reload(); } catch (e) { frame.src = frame.src; }
      });
      input.addEventListener("keydown", e => { if (e.key === "Enter") load(input.value); });
      input.addEventListener("focus", () => input.select());
      open.addEventListener("click", () => { if (page.url) window.open(page.url, "_blank"); });
      clip.addEventListener("click", async () => {
        const url = page.url;
        if (!url) { U.toast("请先输入网址"); return; }
        clip.disabled = true;
        clip.textContent = "⏳";
        U.toast("正在抓取网页…");
        try {
          const res = await fetch("/api/web/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
          const data = await res.json();
          if (!data || !data.markdown) { U.toast("抓取失败：无法提取正文"); return; }
          global.App.createClippedNote(data.title || page.title, data.markdown, url);
        } catch (e) { U.toast("抓取失败：" + (e.message || String(e))); }
        finally { clip.disabled = false; clip.textContent = "📝"; }
      });
    },
  };

  global.WebBrowser = WebBrowser;
})(window);
