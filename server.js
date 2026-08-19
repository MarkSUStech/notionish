/* ============ Notionish local runner service (zero-dependency) ============ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const mcp = require("./server-mcp.js");
const serverAI = require("./server-ai.js");
const { createMemoryStore } = require("./server-memory.js");
const { createKnowledgeStore } = require("./server-kb.js");

const ROOT = __dirname;
const DATA_DIR = process.env.NOTIONISH_DATA_DIR || path.join(__dirname, "data");
const pendingClips = new Map(); // 浏览器扩展暂存的剪藏
const DEFAULT_PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const BRIDGE_TOKEN = crypto.randomBytes(24).toString("hex");
const browserBridge = mcp.createBridge({ token: BRIDGE_TOKEN, timeoutMs: 30000 });
const aiIndex = serverAI.createIndexStore({ filePath: serverAI.AI_INDEX_PATH });
aiIndex.load();

/* ---------- L1/L2/L3 长期记忆：L1=当前对话上下文；L2=近期要点（少量注入）；L3=全量记忆（RAG 检索，AI 按需查询） ---------- */
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const MEMORY_INDEX_PATH = path.join(DATA_DIR, "memory-index.json");
const memoryIndex = serverAI.createIndexStore({ filePath: MEMORY_INDEX_PATH, maxLen: 2000 });
const memoryStore = createMemoryStore({
  dataPath: MEMORY_PATH,
  index: memoryIndex,
  embedTexts: texts => serverAI.embedTexts(serverAI.loadAIConfig(), texts),
});
/** L2：注入系统提示的近期/重要记忆摘要（少量、截断，避免浪费 token） */
function recentMemorySummary(limit) {
  return memoryStore.summary(limit);
}

/* ---------- 知识库：多库、文档、embedding 索引、RAG ---------- */
const kbStore = createKnowledgeStore({
  dataDir: DATA_DIR,
  index: aiIndex,
  embedTexts: texts => serverAI.embedTexts(serverAI.loadAIConfig(), texts),
});

const LANGS = ["python", "c", "cpp", "java"];
const CANDIDATES = {
  python: ["python", "python3", "py"],
  c: ["gcc", "clang", "cc"],
  cpp: ["g++", "clang++", "c++"],
};

/* ---------------- pure helpers (exported for tests) ---------------- */

/** 判断是否为低价值 URL（搜索引擎首页/结果页、网站首页/导航页），不适合收集进知识库 */
function isLowValueUrl(u) {
  try {
    const parsed = new URL(String(u || ""));
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    const engines = ["google.com", "baidu.com", "bing.com", "so.com", "sogou.com", "duckduckgo.com", "yahoo.com", "search.yahoo.com", "google.com.hk", "google.co.jp"];
    if (engines.includes(host)) return true; // 搜索引擎任何页面（首页或结果页）
    if (!path) return true; // 根路径 = 首页/导航页
    return false;
  } catch (e) { return true; }
}

function sanitizeRelPath(rel) {
  if (typeof rel !== "string") return null;
  const parts = rel.split(/[\\/]+/).filter(p => p && p !== ".");
  if (!parts.length || parts.includes("..")) return null;
  return parts.join("/");
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map(f => {
      if (!f || typeof f !== "object") return null;
      const rel = sanitizeRelPath(f.path);
      if (!rel) return null;
      const language = LANGS.includes(f.language) ? f.language : "python";
      return { path: rel, language, content: typeof f.content === "string" ? f.content : "" };
    })
    .filter(Boolean);
}

function sourceFiles(files, exts) {
  return files.map(f => f.path).filter(p => exts.some(e => p.toLowerCase().endsWith(e)));
}

/** build an ordered list of { cmd, args } steps for a language */
function planRun(language, entry, files, compilers) {
  compilers = compilers || {};
  if (language === "python") {
    return { steps: [{ cmd: compilers.python || "python", args: [entry] }] };
  }
  if (language === "java") {
    const javaFiles = sourceFiles(files, [".java"]);
    const mainClass = String(entry).replace(/\.java$/i, "");
    return { steps: [
      { cmd: compilers.java || "javac", args: javaFiles },
      { cmd: "java", args: [mainClass] },
    ] };
  }
  const exts = language === "c" ? [".c"] : [".c", ".cpp"];
  const compiler = language === "c" ? (compilers.c || "gcc") : (compilers.cpp || "g++");
  const out = process.platform === "win32" ? "program.exe" : "program";
  const runCmd = process.platform === "win32" ? "program.exe" : "./program";
  return { steps: [
    { cmd: compiler, args: sourceFiles(files, exts).concat(["-o", out]) },
    { cmd: runCmd, args: [] },
  ] };
}

/* ---------------- process helpers ---------------- */

function runCommand(cmd, args, opts) {
  return new Promise(resolve => {
    execFile(cmd, args, Object.assign({ timeout: 5000, maxBuffer: 1024 * 1024 }, opts || {}), (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve(String(stdout || "").trim());
    });
  });
}

function findCommand(cmd) {
  return new Promise(resolve => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [cmd], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

function findCommandAll(cmd) {
  return new Promise(resolve => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [cmd], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}

async function detectCompilers() {
  const result = {};
  LANGS.forEach(l => (result[l] = []));
  for (const lang of ["python", "c", "cpp"]) {
    for (const cmd of CANDIDATES[lang]) {
      let found = null;
      try { found = await findCommand(cmd); } catch (e) { found = null; }
      if (found) {
        let version = "";
        try { version = (await runCommand(cmd, ["--version"])) || ""; } catch (e) { version = ""; }
        result[lang].push({ cmd, path: found, version });
        break;
      }
    }
  }
  try {
    const javac = await findCommand("javac");
    const java = await findCommand("java");
    if (javac && java) {
      let version = "";
      try { version = (await runCommand("javac", ["--version"])) || ""; } catch (e) { version = ""; }
      result.java.push({ cmd: "javac", path: javac, version });
    }
  } catch (e) { /* java unavailable */ }
  return result;
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { try { child.kill("SIGKILL"); } catch (e2) {} }
    }
  } catch (e) { /* ignore */ }
}

/* ---------------- run orchestration ---------------- */

const runs = new Map(); // runId -> current child

function runProject({ language, entry, files, timeoutMs, runId, onLine }) {
  return new Promise(resolve => {
    const normalized = normalizeFiles(files);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notionish-"));
    const start = Date.now();
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
    const emit = (obj) => { if (onLine) { try { onLine(obj); } catch (e) {} } };
    const finish = (obj) => { if (runId) runs.delete(runId); cleanup(); resolve(obj); };

    let written = 0;
    try {
      for (const f of normalized) {
        const full = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content || "");
        written++;
      }
    } catch (e) {
      return finish({ done: true, ok: false, exitCode: 1, timedOut: false, error: "写入临时文件失败: " + e.message, durationMs: Date.now() - start });
    }
    if (!written) return finish({ done: true, ok: false, exitCode: 1, timedOut: false, error: "没有可运行的文件", durationMs: 0 });

    let plan;
    try {
      plan = planRun(language, entry, normalized);
    } catch (e) {
      return finish({ done: true, ok: false, exitCode: 1, timedOut: false, error: "无法规划运行步骤: " + e.message, durationMs: 0 });
    }

    const runStep = (index) => {
      if (index >= plan.steps.length) {
        return finish({ done: true, ok: true, exitCode: 0, timedOut: false, error: null, durationMs: Date.now() - start });
      }
      const step = plan.steps[index];
      let child;
      try {
        child = spawn(step.cmd, step.args, { cwd: dir, shell: false, detached: process.platform !== "win32" });
      } catch (e) {
        return finish({ done: true, ok: false, exitCode: 1, timedOut: false, error: "无法启动 " + step.cmd + ": " + e.message, durationMs: Date.now() - start });
      }
      if (runId) runs.set(runId, child);
      child._canceled = false;
      const timer = setTimeout(() => { child._timedOut = true; killTree(child); }, timeoutMs || DEFAULT_TIMEOUT_MS);
      child.stdout && child.stdout.on("data", d => emit({ stream: "stdout", text: d.toString() }));
      child.stderr && child.stderr.on("data", d => emit({ stream: "stderr", text: d.toString() }));
      child.on("error", err => {
        clearTimeout(timer);
        finish({ done: true, ok: false, exitCode: 1, timedOut: !!child._timedOut, error: step.cmd + ": " + err.message, durationMs: Date.now() - start });
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (child._canceled) return finish({ done: true, ok: false, exitCode: code, timedOut: false, error: "已停止", durationMs: Date.now() - start });
        if (child._timedOut) return finish({ done: true, ok: false, exitCode: code, timedOut: true, error: "运行超时（" + ((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000) + " 秒）", durationMs: Date.now() - start });
        if (code !== 0) return finish({ done: true, ok: false, exitCode: code, timedOut: false, error: null, durationMs: Date.now() - start });
        runStep(index + 1);
      });
    };
    runStep(0);
  });
}

function cancelRun(id) {
  const child = runs.get(String(id));
  if (!child) return false;
  child._canceled = true;
  killTree(child);
  return true;
}

/* ---------------- HTTP layer ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  // 允许浏览器扩展（chrome-extension:// / moz-extension://）
  if (/^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin)) return true;
  try {
    const u = new URL(origin);
    // 允许本地回环任意端口（浏览器 / Cordis 服务器 8788 等）
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return true;
    return u.host === req.headers.host;
  } catch (e) { return false; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id == null ? null : id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id == null ? null : id, result };
}

async function handleMcpRequest(req, res) {
  let message;
  try {
    message = JSON.parse(await readBody(req, MAX_BODY));
  } catch (error) {
    sendJSON(res, 400, rpcError(null, -32700, "无法解析 JSON-RPC 请求: " + error.message));
    return;
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    sendJSON(res, 400, rpcError(message && message.id, -32600, "无效的 JSON-RPC 请求"));
    return;
  }

  const id = message.id;
  const params = message.params || {};
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    res.writeHead(202, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (message.method === "initialize") {
    sendJSON(res, 200, rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "notionish-mcp", version: "1.0.0" },
    }));
    return;
  }
  if (message.method === "ping") {
    sendJSON(res, 200, rpcResult(id, {}));
    return;
  }
  if (message.method === "tools/list") {
    sendJSON(res, 200, rpcResult(id, { tools: mcp.listTools() }));
    return;
  }
  if (message.method !== "tools/call") {
    sendJSON(res, 200, rpcError(id, -32601, "未知 MCP 方法: " + message.method));
    return;
  }
  if (bearerToken(req) !== BRIDGE_TOKEN) {
    sendJSON(res, 401, rpcError(id, -32001, "未授权的 MCP 请求：请提供本地服务启动时输出的 Bearer token"));
    return;
  }
  const checked = mcp.validateTool(params.name, params.arguments || {});
  if (!checked.ok) {
    sendJSON(res, 200, rpcError(id, -32602, checked.error));
    return;
  }
  const request = browserBridge.enqueue(checked.tool, checked.args);
  const output = await browserBridge.waitResult(request.id);
  if (!output || !output.ok) {
    sendJSON(res, 200, rpcError(id, -32000, output && output.error || "浏览器桥接未返回结果"));
    return;
  }
  sendJSON(res, 200, rpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(output.result) }],
    structuredContent: output.result,
    isError: false,
  }));
}

async function handleAIRequest(req, res, url) {
  // read JSON body helper for AI endpoints
  const readJSON = async () => {
    try { return JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { sendJSON(res, 400, { error: "无效的请求体: " + e.message }); return null; }
  };

  if (url === "/api/ai/config" && req.method === "GET") {
    sendJSON(res, 200, serverAI.publicConfig(serverAI.loadAIConfig()));
    return true;
  }
  if (url === "/api/ai/config" && req.method === "PUT") {
    const body = await readJSON();
    if (body === null) return true;
    const saved = serverAI.saveAIConfig(body);
    sendJSON(res, 200, serverAI.publicConfig(saved));
    return true;
  }
  if (url === "/api/ai/skill" && req.method === "GET") {
    const params = new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const content = serverAI.loadSkill(serverAI.SKILLS_DIR, params.get("name") || "");
    if (content == null) { sendJSON(res, 404, { error: "未找到技能：" + (params.get("name") || "") }); return true; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(content);
    return true;
  }
  if (url === "/api/ai/status" && req.method === "GET") {
    const config = serverAI.loadAIConfig();
    sendJSON(res, 200, { configured: !!config.openaiApiKey, indexSize: aiIndex.size(), config: serverAI.publicConfig(config) });
    return true;
  }

  // ---- L1/L2/L3 长期记忆端点 ----
  if (url === "/api/memory/save" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    try {
      const result = await memoryStore.create(body);
      sendJSON(res, 200, { ok: true, entry: result.entry, indexed: result.indexed, size: memoryStore.list().length });
    } catch (error) {
      sendJSON(res, 400, { error: error.message });
    }
    return true;
  }
  if (url === "/api/memory/query" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) { sendJSON(res, 200, { ok: true, results: [] }); return true; }
    const config = serverAI.loadAIConfig();
    const k = Math.max(1, Math.min(10, Number(body.k) || 5));
    let results = [];
    try {
      const qv = (await serverAI.embedTexts(config, [query]))[0] || [];
      results = memoryIndex.retrieve(qv, k).map(h => ({ id: h.chunk.blockId, text: h.chunk.text, score: Math.round(h.score * 100) / 100 }));
      memoryStore.touch(results.map(result => result.id));
    } catch (e) { /* 嵌入失败返回空 */ }
    sendJSON(res, 200, { ok: true, results });
    return true;
  }
  if (url === "/api/memory/list" && req.method === "GET") {
    sendJSON(res, 200, { ok: true, entries: memoryStore.list() });
    return true;
  }
  const memoryMatch = url.match(/^\/api\/memory\/([^/]+)$/);
  if (memoryMatch && req.method === "PUT") {
    const body = await readJSON();
    if (body === null) return true;
    try {
      const result = await memoryStore.update(decodeURIComponent(memoryMatch[1]), body);
      sendJSON(res, 200, { ok: true, entry: result.entry, indexed: result.indexed });
    } catch (error) {
      sendJSON(res, error.message === "记忆不存在" ? 404 : 400, { error: error.message });
    }
    return true;
  }
  if (memoryMatch && req.method === "DELETE") {
    try {
      const entry = memoryStore.remove(decodeURIComponent(memoryMatch[1]));
      sendJSON(res, 200, { ok: true, entry, size: memoryStore.list().length });
    } catch (error) {
      sendJSON(res, 404, { error: error.message });
    }
    return true;
  }

  if (url === "/api/questions/embed" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const texts = Array.isArray(body.texts) ? body.texts.filter(t => typeof t === "string" && t.trim()) : [];
    if (!texts.length) { sendJSON(res, 200, { ok: true, vectors: [] }); return true; }
    try {
      const vectors = await serverAI.embedTexts(serverAI.loadAIConfig(), texts);
      sendJSON(res, 200, { ok: true, vectors });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: "Embedding 失败：" + (e.message || String(e)) });
    }
    return true;
  }

  // ---- 联网搜索（DeepSeek 原生 web_search） ----
  if (url === "/api/search" && req.method === "GET") {
    const params = new URL(req.url || "/", "http://127.0.0.1").searchParams;
    const q = params.get("q") || "";
    if (!q) { sendJSON(res, 200, { ok: true, text: "", results: [] }); return true; }
    try {
      const r = await serverAI.deepseekWebSearch(serverAI.loadAIConfig(), q, params.get("count") || 5);
      sendJSON(res, 200, { ok: true, text: r.text, results: r.citations });
    } catch (e) { sendJSON(res, 200, { ok: false, text: "", results: [], error: e.message || String(e) }); }
    return true;
  }

  // ---- 知识库端点 ----
  if (url === "/api/kb/list" && req.method === "GET") {
    sendJSON(res, 200, { ok: true, kbs: kbStore.listKbs() });
    return true;
  }
  const kbWebMatch = url.match(/^\/api\/kb\/([^/]+)\/web$/);
  if (kbWebMatch && req.method === "POST") {
    const kbId = decodeURIComponent(kbWebMatch[1]);
    const body = await readJSON();
    if (body === null) return true;
    const webUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!webUrl) { sendJSON(res, 400, { error: "缺少 url" }); return true; }
    if (isLowValueUrl(webUrl)) { sendJSON(res, 400, { error: "这是搜索引擎首页/结果页或网站首页，没有可收集的文章内容，请提供具体文章、博客、教程的网址" }); return true; }
    try {
      const text = await serverAI.fetchUrlText(webUrl);
      if (!text.trim()) { sendJSON(res, 400, { error: "网页正文为空" }); return true; }
      const doc = await kbStore.addDoc(kbId, { name: body.name || webUrl, kind: "url", text, url: webUrl });
      sendJSON(res, 200, { ok: true, doc });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return true;
  }
  if (url === "/api/kb/create" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    try { sendJSON(res, 200, { ok: true, kb: kbStore.createKb(body && body.name) }); }
    catch (e) { sendJSON(res, 400, { error: e.message }); }
    return true;
  }
  if (url === "/api/kb/query" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const q = typeof body.query === "string" ? body.query.trim() : "";
    if (!q) { sendJSON(res, 200, { ok: true, results: [] }); return true; }
    try {
      const results = await kbStore.query(body.kbId || null, q, body.k || 5);
      sendJSON(res, 200, { ok: true, results });
    } catch (e) { sendJSON(res, 200, { ok: true, results: [] }); }
    return true;
  }
  const kbDocMatch = url.match(/^\/api\/kb\/([^/]+)\/docs\/([^/]+)$/);
  if (kbDocMatch && req.method === "GET") {
    try {
      const doc = kbStore.getDoc(decodeURIComponent(kbDocMatch[1]), decodeURIComponent(kbDocMatch[2]));
      sendJSON(res, 200, { ok: true, doc });
    } catch (e) { sendJSON(res, 404, { error: e.message }); }
    return true;
  }
  if (kbDocMatch && req.method === "DELETE") {
    try {
      const doc = kbStore.removeDoc(decodeURIComponent(kbDocMatch[1]), decodeURIComponent(kbDocMatch[2]));
      sendJSON(res, 200, { ok: true, doc });
    } catch (e) { sendJSON(res, 404, { error: e.message }); }
    return true;
  }
  const kbSubMatch = url.match(/^\/api\/kb\/([^/]+)(?:\/(docs|reindex))?$/);
  if (kbSubMatch) {
    const kbId = decodeURIComponent(kbSubMatch[1]);
    const sub = kbSubMatch[2];
    if (sub === "docs" && req.method === "POST") {
      const body = await readJSON();
      if (body === null) return true;
      try {
        const kind = body.kind === "url" ? "url" : body.kind === "note" ? "note" : "text";
        let text = typeof body.text === "string" ? body.text : "";
        const url = typeof body.url === "string" ? body.url.trim() : null;
        if (kind === "url" && url && !text.trim()) {
          try { text = await serverAI.fetchUrlText(url); } catch (e) { sendJSON(res, 400, { error: "抓取网址失败：" + (e.message || String(e)) }); return true; }
        }
        const doc = await kbStore.addDoc(kbId, { name: body.name, kind, text, url });
        sendJSON(res, 200, { ok: true, doc });
      } catch (e) { sendJSON(res, 400, { error: e.message }); }
      return true;
    }
    if (sub === "reindex" && req.method === "POST") {
      try { const n = await kbStore.reindex(kbId); sendJSON(res, 200, { ok: true, count: n }); }
      catch (e) { sendJSON(res, 404, { error: e.message }); }
      return true;
    }
    if (!sub && req.method === "GET") {
      try { sendJSON(res, 200, { ok: true, docs: kbStore.listDocs(kbId) }); }
      catch (e) { sendJSON(res, 404, { error: e.message }); }
      return true;
    }
    if (!sub && req.method === "PUT") {
      const body = await readJSON();
      if (body === null) return true;
      try { sendJSON(res, 200, { ok: true, kb: kbStore.renameKb(kbId, body && body.name) }); }
      catch (e) { sendJSON(res, 404, { error: e.message }); }
      return true;
    }
    if (!sub && req.method === "DELETE") {
      try { kbStore.removeKb(kbId); sendJSON(res, 200, { ok: true, deleted: true }); }
      catch (e) { sendJSON(res, 404, { error: e.message }); }
      return true;
    }
  }

  if (url === "/api/ai/index/upsert" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) { sendJSON(res, 400, { error: "缺少 items" }); return true; }
    const config = serverAI.loadAIConfig();
    try {
      const result = await aiIndex.upsert(items, texts => serverAI.embedTexts(config, texts));
      aiIndex.persist();
      sendJSON(res, 200, Object.assign({ ok: true }, result, { indexSize: aiIndex.size() }));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return true;
  }
  if (url === "/api/ai/index/delete" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    let removed = 0;
    if (typeof body.pageId === "string") removed += aiIndex.deletePage(body.pageId);
    if (typeof body.blockId === "string") removed += aiIndex.deleteBlock(body.blockId);
    aiIndex.persist();
    sendJSON(res, 200, { ok: true, removed, indexSize: aiIndex.size() });
    return true;
  }
  if (url === "/api/ai/index/rebuild" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const items = Array.isArray(body.items) ? body.items : [];
    const config = serverAI.loadAIConfig();
    try {
      const result = await aiIndex.rebuild(items, texts => serverAI.embedTexts(config, texts));
      aiIndex.persist();
      sendJSON(res, 200, Object.assign({ ok: true }, result, { indexSize: aiIndex.size() }));
    } catch (e) { sendJSON(res, 500, { error: e.message }); }
    return true;
  }

  if (url === "/api/ai/chat" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m.role === "string") : [];
    if (!messages.length) { sendJSON(res, 400, { error: "缺少 messages" }); return true; }
    const config = serverAI.loadAIConfig();
    if (!config.openaiApiKey) { sendJSON(res, 400, { error: "未配置 OpenAI API Key" }); return true; }
    try {
      const pageContent = typeof body.pageContent === "string" ? body.pageContent : "";
      const pageBlocks = Array.isArray(body.pageBlocks) ? body.pageBlocks : null;
      const currentPage = body.currentPage && typeof body.currentPage === "object" ? body.currentPage : null;
      const style = typeof body.style === "string" && body.style.trim() ? body.style.trim() : "";
      let citations = [];
      const lastUser = [...messages].reverse().find(m => m.role === "user");
      const queryText = lastUser ? String(lastUser.content || "") : "";
      if (queryText) {
        try {
          const queryVector = (await serverAI.embedTexts(config, [queryText]))[0] || [];
          citations = aiIndex.retrieve(queryVector, 5).map(h => ({ pageId: h.chunk.pageId, blockId: h.chunk.blockId, pageTitle: h.chunk.pageTitle, text: h.chunk.text }));
        } catch (e) { citations = []; }
      }
      const context = [];
      if (currentPage) context.push("当前打开的页面：" + JSON.stringify(currentPage));
      if (pageContent) context.push("当前页面内容：\n" + pageContent);
      if (pageBlocks) context.push("当前页面块结构（含 id，供 create_block / update_block / delete_block / move_block 使用）：\n" + JSON.stringify(pageBlocks));
      if (citations.length) context.push("工作区相关笔记：\n" + citations.map((c, i) => "[" + (i + 1) + "] " + (c.pageTitle || "笔记") + "：" + c.text).join("\n"));
      const memSummary = recentMemorySummary(8);
      if (memSummary) context.push("近期记忆要点（L2）：\n" + memSummary);
      const skills = serverAI.scanSkills(serverAI.SKILLS_DIR);
      const skillsSummary = skills.map(s => "- " + s.name + "：" + (s.description || "")).join("\n");
      const system = "你是本地笔记助手。你可以调用技能（工具）帮用户：新建笔记(create_note)、补充当前页(append_blocks)、出题(create_questions)、做闪卡(create_flashcards)、新建网页页面(create_web_page)、新建 PDF 页面(create_pdf_page)，以及直接编辑当前页的块：新建任意类型的块(create_block，含表格 table / 公式 equation / 代码 code / 嵌入 embed / PDF pdf 等，可传 after/before 指定插到某个块之后/之前)、替换已有块(update_block，用新内容覆盖旧块)、删除块(delete_block)、移动块(move_block)。" +
        "你还可以访问工作区的资料：列出所有页面(list_pages，含笔记/网页/PDF/数据库等)、读取 PDF 文字内容(read_pdf)、读取网页正文(read_web)。当用户要求你阅读、总结、引用某个 PDF 或网页时，先 list_pages 找到对应的页面 id，再调用 read_pdf / read_web 读取内容。若用户说的“这份/这个 PDF 或网页”就是「当前打开的页面」，直接用当前页面信息里的 id 调用 read_pdf / read_web，不要再拒绝说无法读取。" +
        "当用户要求「在某个位置插入」或「插到某段后面/前面」时，用 create_block/append_blocks 的 after 或 before 参数指定位置；当用户要求「改写/替换某段内容」时，用 update_block 覆盖该块，而不是新建块。" +
        "数学公式用 LaTeX 表示：行内公式写在一对美元符号之间（如 $E=mc^2$），单独成行的公式用两个美元符号（$$...$$）或 equation 块。" +
        "制作图表 / 流程图 / 架构图时，在 mermaid 与 draw.io 之间按需取舍：diagrams-as-code（代码即图、需在 Markdown 里渲染）用 mermaid 块；需要精确排版、丰富形状库、泳道图，或要导出 PNG/SVG/PDF 的架构图 / 网络拓扑 / UML / ERD / 思维导图等，先调用 load_skill 加载 drawio-skill，再按其要求生成。" +
        "当用户要求**生成长篇内容**（撰写笔记、文章、教程、报告、讲义、总结、大纲等）时，不要直接生成：先调用 ask_block_types 工具（传入 purpose 说明内容主题），等用户在多选中选定块类型后，再根据返回的 blockTypes 调用 create_note 或 append_blocks 生成；生成时必须严格只使用用户选中的块类型，不要额外添加未选中的类型。" +
        "当用户要求**生成可交互网页 / 可视化教学 / HTML 作品**时，先调用 load_skill 加载 html 技能（有效 HTML 设计规范），再按其规范用 create_block 创建 html 块，把完整 HTML 放在 attrs.source；不要输出 HTML 代码块（```）或 code 块。" +
        "当用户要求**修改、改写、扩写、缩写、重写某个已有块**时，直接生成并调用对应工具写入，不要反问；当用户要求出题或做闪卡时，直接生成并调用 create_questions / create_flashcards。" +
        (style ? "当前写作范式要求：" + style + " 请严格遵循该范式来撰写笔记和讲解。" : "") +
        "当用户询问已有笔记内容相关的问题时，优先依据下方提供的笔记内容回答，内容不足时说明。" +
        "你拥有分层长期记忆：L1 是当前对话；L2 是系统注入的近期记忆要点；L3 是全部历史记忆，不会自动注入。需要回忆用户偏好、身份、过往决定、约定、项目背景等时，主动调用 query_memory(查询) 检索相关记忆（RAG）；在对话中得知值得长期记住的重要事实/偏好/决定时，调用 save_memory(text, importance) 保存。不要假设全部记忆都在上下文里，按需查询以节省 token。" +
        "你还可以检索用户的知识库（用户上传的资料、网址、代码文件、笔记等）：当用户询问的知识可能存在于知识库时，先调用 list_knowledge_bases 列出知识库获取 id，再调用 query_knowledge_base(query, kbId?) 检索；不指定 kbId 则检索全部知识库。检索结果只作为参考，回答时说明依据。" +
        "生成笔记/长内容时，如果参考了知识库(query_knowledge_base)、网页(read_web/save_web_to_kb/web_search)里的内容，请在引用句子的末尾用「[^1]」「[^2]」这样的上标序号标注（序号从 1 开始连续），并在整个笔记的最后单独写一个块「参考来源：」，随后每行一条「[1] 标题 - 网址」，与正文里的序号一一对应。这样用户点击序号能看到来源网页。" +
        "当用户要求查最新资料、或需要工作区/知识库之外的信息时，调用 web_search(query) 联网搜索（DeepSeek 原生搜索，返回整合答案和引用网址）。搜索到有用的网页后，调用 save_web_to_kb(url, kbId?) 抓取网页正文并存入知识库（不指定 kbId 则存入第一个知识库）。" +
        "收集网页到知识库时，只收集有价值的**文章、博客、教程、文档、百科、论文**类资源；跳过搜索引擎首页/结果页（如 google.com、baidu.com、bing.com 的首页或 /search、/s 结果页）、门户首页、导航页、登录注册页、广告页等无实质内容的页面。" +
        (skillsSummary ? "\n\n本机可用的技能（skills）：\n" + skillsSummary + "\n当用户提到某个技能或人物时，先调用 load_skill 加载该技能完整说明，再按其要求执行或扮演。" : "");
      const full = [{ role: "system", content: system + (context.length ? "\n\n" + context.join("\n\n") : "") }].concat(messages);
      const result = await serverAI.chatOnce(config, full, serverAI.AI_TOOLS);
      sendJSON(res, 200, { content: result.content || "", reasoning_content: result.reasoning_content || "", tool_calls: result.tool_calls || [], citations });
    } catch (e) {
      sendJSON(res, 500, { error: e.message || String(e) });
    }
    return true;
  }

  if (url === "/api/ai/fetch" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const target = String(body.url || "").trim();
    if (!target) { sendJSON(res, 400, { error: "缺少 url" }); return true; }
    try {
      const text = await serverAI.fetchUrlText(target);
      sendJSON(res, 200, { ok: true, text });
    } catch (e) { sendJSON(res, 500, { error: e.message || String(e) }); }
    return true;
  }

  if (url === "/api/web/meta" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const target = String(body.url || "").trim();
    if (!target) { sendJSON(res, 400, { error: "缺少 url" }); return true; }
    try {
      const meta = await serverAI.fetchWebMarkdown(target);
      sendJSON(res, 200, { ok: true, title: meta.title, markdown: meta.markdown, url: target });
    } catch (e) { sendJSON(res, 500, { error: e.message || String(e) }); }
    return true;
  }

  if (url === "/api/ai/query" && req.method === "POST") {
    const body = await readJSON();
    if (body === null) return true;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) { sendJSON(res, 400, { error: "缺少 query" }); return true; }
    const config = serverAI.loadAIConfig();
    if (!config.openaiApiKey) { sendJSON(res, 400, { error: "未配置 OpenAI API Key" }); return true; }

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive" });
    const sendEvent = obj => {
      if (res.writableEnded || res.destroyed) return;
      try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) { /* 客户端断开时忽略 */ }
    };
    try {
      if (body.direct === true) {
        sendEvent({ type: "meta", citations: [] });
        await serverAI.streamChat(config, [{ role: "user", content: query }], delta => sendEvent({ type: "delta", text: delta }));
        sendEvent({ type: "done" });
        res.end();
        return true;
      }
      const queryVector = (await serverAI.embedTexts(config, [query]))[0] || [];
      const k = Math.min(20, Math.max(1, Number(body.k) || 5));
      const hits = aiIndex.retrieve(queryVector, k);
      const citations = hits.map(h => ({ pageId: h.chunk.pageId, blockId: h.chunk.blockId, pageTitle: h.chunk.pageTitle, text: h.chunk.text, score: h.score }));
      sendEvent({ type: "meta", citations });
      const prompt = serverAI.buildPrompt(query, hits.map(h => h.chunk));
      await serverAI.streamChat(config, [{ role: "user", content: prompt }], delta => sendEvent({ type: "delta", text: delta }));
      sendEvent({ type: "done" });
    } catch (e) {
      try { sendEvent({ type: "error", message: e.message || String(e) }); } catch (e2) { /* 忽略二次写入错误 */ }
    }
    try { if (!res.writableEnded) res.end(); } catch (e) { /* 忽略 */ }
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || "/").split("?")[0]); } catch (e) { urlPath = "/"; }
  if (urlPath === "/") urlPath = process.env.NOTIONISH_SERVE_DEMO === "1" ? "/demo/index.html" : "/index.html";
  let filePath = path.join(ROOT, path.normalize(urlPath));
  // 目录访问：默认找 index.html
  try {
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
  } catch (e) {}
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

function start() {
  const server = http.createServer(async (req, res) => {
    // CORS 预检请求
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }
    const url = (req.url || "/").split("?")[0];
    const bridgeRoute = url === "/mcp" || url.startsWith("/api/bridge/");
    if (!bridgeRoute && !allowedOrigin(req)) { sendJSON(res, 403, { error: "不允许的来源" }); return; }
    const query = new URL(req.url || "/", "http://127.0.0.1").searchParams;

    if (url === "/mcp" && req.method === "POST") {
      await handleMcpRequest(req, res);
      return;
    }

    if (url === "/api/bridge/token" && req.method === "GET") {
      sendJSON(res, 200, { token: BRIDGE_TOKEN, protocolVersion: MCP_PROTOCOL_VERSION });
      return;
    }

    if (url === "/api/bridge/status" && req.method === "GET") {
      const authorized = query.get("token") === BRIDGE_TOKEN;
      sendJSON(res, authorized ? 200 : 403, authorized ? { connected: true, pending: browserBridge.pendingCount() } : { error: "无效桥接令牌" });
      return;
    }

    if (url === "/api/bridge/poll" && req.method === "GET") {
      const request = browserBridge.poll(query.get("token") || "");
      if (query.get("token") !== BRIDGE_TOKEN) { sendJSON(res, 403, { error: "无效桥接令牌" }); return; }
      sendJSON(res, 200, { request });
      return;
    }

    if (url === "/api/bridge/result" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (error) { sendJSON(res, 400, { error: "无效桥接结果: " + error.message }); return; }
      if (!body || body.token !== BRIDGE_TOKEN) { sendJSON(res, 403, { error: "无效桥接令牌" }); return; }
      const ok = browserBridge.submitResult(body.token, body.id, { ok: !!body.ok, result: body.result, error: body.error });
      sendJSON(res, ok ? 200 : 404, { ok });
      return;
    }

    if ((url.startsWith("/api/ai/") || url.startsWith("/api/memory/") || url.startsWith("/api/questions/") || url.startsWith("/api/kb/") || url.startsWith("/api/web/") || url === "/api/search") && await handleAIRequest(req, res, url)) return;

    // 插件列表
    if (url === "/api/plugins" && req.method === "GET") {
      const pluginsDir = path.join(ROOT, "plugins");
      const list = [];
      try {
        if (fs.existsSync(pluginsDir)) {
          fs.readdirSync(pluginsDir, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => {
            const mf = path.join(pluginsDir, d.name, "plugin.json");
            if (fs.existsSync(mf)) {
              try { list.push(JSON.parse(fs.readFileSync(mf, "utf8"))); } catch (e) {}
            }
          });
        }
      } catch (e) {}
      sendJSON(res, 200, list);
      return;
    }

    // 浏览器扩展剪藏：接收 markdown，暂存等待前端取走
    if (url === "/api/clip" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { sendJSON(res, 400, { error: e.message }); return; }
      if (!body || !body.markdown) { sendJSON(res, 400, { error: "缺少 markdown" }); return; }
      const id = String(Date.now());
      pendingClips.set(id, { title: body.title || "剪藏笔记", markdown: body.markdown, url: body.url || "", time: Date.now() });
      sendJSON(res, 200, { ok: true, id });
      return;
    }
    // 前端轮询取走暂存的剪藏
    if (url === "/api/clip/pending" && req.method === "GET") {
      const clips = [];
      pendingClips.forEach((v, k) => { clips.push({ id: k, ...v }); pendingClips.delete(k); });
      sendJSON(res, 200, clips);
      return;
    }

    // 工作区状态持久化：浏览器和 Electron 共享同一份数据文件
    if (url === "/api/state" && req.method === "GET") {
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, "workspace.json"), "utf8");
        sendJSON(res, 200, JSON.parse(raw));
      } catch (e) {
        sendJSON(res, 200, { pages: null });
      }
      return;
    }
    if (url === "/api/state" && req.method === "POST") {
      let body;
      try { body = await readBody(req, MAX_BODY); } catch (e) { sendJSON(res, 400, { error: e.message }); return; }
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, "workspace.json"), JSON.stringify(body), "utf8");
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }

    // 题库 RAG 检索：根据主题向量检索最相关的题目
    if (url === "/api/questions/rag" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { sendJSON(res, 400, { error: e.message }); return; }
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const questions = Array.isArray(body.questions) ? body.questions : [];
      if (!query || !questions.length) { sendJSON(res, 200, { ids: [] }); return; }
      try {
        const config = serverAI.loadAIConfig();
        // 嵌入查询和所有题目
        const texts = [query, ...questions.map(q => (q.prompt || "").slice(0, 500))];
        const vectors = await serverAI.embedTexts(config, texts);
        if (!vectors || vectors.length < 2) { sendJSON(res, 200, { ids: [] }); return; }
        const queryVec = vectors[0];
        const scores = questions.map((q, i) => {
          const v = vectors[i + 1];
          if (!v || !v.length) return { id: q.id, score: 0 };
          let dot = 0, na = 0, nb = 0;
          for (let j = 0; j < queryVec.length; j++) {
            dot += queryVec[j] * v[j];
            na += queryVec[j] * queryVec[j];
            nb += v[j] * v[j];
          }
          const score = na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
          return { id: q.id, score };
        });
        scores.sort((a, b) => b.score - a.score);
        const k = Math.max(1, Math.min(30, Number(body.count) || 5));
        const ids = scores.slice(0, k).map(s => s.id);
        sendJSON(res, 200, { ids });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }

    if (url === "/api/compilers" && req.method === "GET") {
      try { sendJSON(res, 200, await detectCompilers()); } catch (e) { sendJSON(res, 500, { error: e.message }); }
      return;
    }

    const runMatch = url.match(/^\/api\/run\/([^/]+)\/cancel$/);
    if (runMatch && req.method === "POST") {
      sendJSON(res, 200, { ok: cancelRun(runMatch[1]) });
      return;
    }

    if (url === "/api/run" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req, MAX_BODY)); } catch (e) { sendJSON(res, 400, { error: e.message }); return; }
      const language = LANGS.includes(body.language) ? body.language : "python";
      const entry = sanitizeRelPath(body.entry);
      if (!entry) { sendJSON(res, 400, { error: "无效的入口文件" }); return; }
      const timeoutMs = Math.min(120000, Math.max(1000, Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS));
      const runId = String(Date.now()) + "_" + Math.floor(Math.random() * 100000);

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Run-Id": runId,
      });
      const result = await runProject({
        language, entry, files: body.files, timeoutMs, runId,
        onLine: obj => res.write(JSON.stringify(obj) + "\n"),
      });
      res.write(JSON.stringify(result) + "\n");
      res.end();
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") { serveStatic(req, res); return; }
    sendJSON(res, 404, { error: "Not found" });
  });

  // 兜底：任何未捕获异常/未处理拒绝都只记录日志，不让整个服务崩溃
  process.on("uncaughtException", (err) => { console.error("[未捕获异常]", err && err.stack || err); });
  process.on("unhandledRejection", (reason) => { console.error("[未处理的 Promise 拒绝]", reason && reason.stack || reason); });

  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log("Notionish 运行服务已启动: http://127.0.0.1:" + DEFAULT_PORT);
    console.log("MCP 端点: http://127.0.0.1:" + DEFAULT_PORT + "/mcp");
    console.log("MCP Bearer token: " + BRIDGE_TOKEN);
  });
}

module.exports = { detectCompilers, planRun, sanitizeRelPath, isLowValueUrl, normalizeFiles, runProject, cancelRun, LANGS, BRIDGE_TOKEN, browserBridge, handleMcpRequest, handleAIRequest, aiIndex };

if (require.main === module) start();
