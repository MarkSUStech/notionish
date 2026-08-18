/* ============ Notionish Web Clipper - Popup ============ */
const SERVER = "http://127.0.0.1:8787";

document.getElementById("clipBtn").addEventListener("click", async () => {
  const btn = document.getElementById("clipBtn");
  const status = document.getElementById("status");
  btn.disabled = true;
  btn.textContent = "正在剪藏…";
  status.textContent = "";
  status.className = "status";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
      throw new Error("此页面无法剪藏（仅支持 http/https 网页）");
    }

    // 1. 从内容脚本获取提取结果
    let data;
    try {
      data = await chrome.tabs.sendMessage(tab.id, { action: "clip" });
    } catch (e) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/readability.js", "lib/turndown.js", "content.js"] });
      data = await chrome.tabs.sendMessage(tab.id, { action: "clip" });
    }

    if (!data || !data.ok) throw new Error((data && data.error) || "提取失败");

    // 2. 发送到 Notionish 服务端（popup 没有 CSP 限制）
    const res = await fetch(SERVER + "/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: data.title, markdown: data.markdown, url: data.url }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error("服务端错误");

    status.textContent = "✅ 已剪藏 → " + (data.title || "笔记");
    status.className = "status ok";
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    status.textContent = "❌ " + (err.message || "剪藏失败");
    status.className = "status err";
    btn.disabled = false;
    btn.textContent = "重试";
  }
});