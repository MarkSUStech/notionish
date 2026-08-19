/* ============ Notionish AI RAG primitives (zero-dependency, testable) ============ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { StringDecoder } = require("string_decoder");

const DEFAULT_MAX_LEN = 1000;
const DATA_DIR = process.env.NOTIONISH_DATA_DIR || path.join(__dirname, "data");
const AI_CONFIG_PATH = process.env.AI_CONFIG_PATH || path.join(__dirname, "ai-config.json");
const AI_INDEX_PATH = path.join(DATA_DIR, "ai-index.json");
const SKILLS_DIR = path.join(__dirname, "skills");

/** split text into retrieval chunks; merges short paragraphs and hard-splits long ones */
function chunkText(text, maxLen) {
  const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const limit = Math.max(200, Math.floor(Number(maxLen) || DEFAULT_MAX_LEN));
  const paragraphs = s.split("\n").map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  const flush = () => { if (buf) { chunks.push(buf); buf = ""; } };
  for (const p of paragraphs) {
    if (p.length > limit) {
      flush();
      for (let i = 0; i < p.length; i += limit) chunks.push(p.slice(i, i + limit));
      continue;
    }
    if (buf && buf.length + 1 + p.length > limit) flush();
    buf = buf ? buf + "\n" + p : p;
  }
  flush();
  return chunks;
}

/** cosine similarity; zero vectors score 0 */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function buildChunkId(pageId, blockId, index) {
  return pageId + "|" + blockId + "|" + index;
}

/** deterministic djb2 string hash for dedup */
function hashText(s) {
  let h = 5381;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function buildPrompt(query, chunks) {
  const context = (chunks || []).map((c, i) => "[" + (i + 1) + "] " + (c.pageTitle ? c.pageTitle + "：" : "") + (c.text || "")).join("\n");
  return [
    "你是本地笔记的助手。请仅依据下面的笔记内容回答用户问题；内容不足以回答时请明确说明，不要编造。",
    "",
    "笔记内容：",
    context || "（无相关笔记）",
    "",
    "用户问题：" + (query == null ? "" : query),
  ].join("\n");
}

/** in-memory vector index backed by a JSON file; embedFn(texts) => vectors[][] */
function createIndexStore(options) {
  const opts = options || {};
  const filePath = opts.filePath || null;
  const maxLen = Math.max(50, Math.floor(Number(opts.maxLen) || DEFAULT_MAX_LEN));

  const store = {
    chunks: new Map(), // id -> chunk
    byBlock: new Map(), // blockId -> Set<chunkId>
    byPage: new Map(), // pageId -> Set<chunkId>
    maxLen,
    filePath,

    size() {
      return store.chunks.size;
    },

    indexBlock(blockId, id) {
      if (!store.byBlock.has(blockId)) store.byBlock.set(blockId, new Set());
      store.byBlock.get(blockId).add(id);
    },

    indexPage(pageId, id) {
      if (!store.byPage.has(pageId)) store.byPage.set(pageId, new Set());
      store.byPage.get(pageId).add(id);
    },

    _removeChunk(id) {
      const chunk = store.chunks.get(id);
      if (!chunk) return;
      store.chunks.delete(id);
      const blocks = store.byBlock.get(chunk.blockId);
      if (blocks) { blocks.delete(id); if (!blocks.size) store.byBlock.delete(chunk.blockId); }
      const pages = store.byPage.get(chunk.pageId);
      if (pages) { pages.delete(id); if (!pages.size) store.byPage.delete(chunk.pageId); }
    },

    /** incremental upsert; items: [{pageId, blockId, pageTitle, text}] */
    async upsert(items, embedFn) {
      const list = Array.isArray(items) ? items.filter(i => i && typeof i.text === "string") : [];
      let added = 0, updated = 0, skipped = 0;
      const pending = [];

      for (const item of list) {
        const texts = chunkText(item.text, maxLen);
        const existingIds = store.byBlock.get(item.blockId) || new Set();
        let identical = existingIds.size === texts.length;
        if (identical) {
          for (let i = 0; i < texts.length; i++) {
            const existing = store.chunks.get(buildChunkId(item.pageId, item.blockId, i));
            if (!existing || existing.hash !== hashText(texts[i])) { identical = false; break; }
          }
        }
        if (identical) { skipped++; continue; }

        const isNew = existingIds.size === 0;
        [...existingIds].forEach(id => store._removeChunk(id));
        texts.forEach((text, i) => {
          pending.push({
            id: buildChunkId(item.pageId, item.blockId, i),
            pageId: item.pageId,
            blockId: item.blockId,
            pageTitle: typeof item.pageTitle === "string" ? item.pageTitle : "",
            text,
            hash: hashText(text),
          });
        });
        if (isNew) added++; else updated++;
      }

      if (pending.length) {
        const vectors = await embedFn(pending.map(c => c.text));
        pending.forEach((c, i) => {
          const vector = Array.isArray(vectors[i]) ? vectors[i] : [];
          store.chunks.set(c.id, Object.assign({}, c, { vector }));
          store.indexBlock(c.blockId, c.id);
          store.indexPage(c.pageId, c.id);
        });
      }
      return { added, updated, skipped };
    },

    async rebuild(items, embedFn) {
      store.chunks.clear();
      store.byBlock.clear();
      store.byPage.clear();
      return store.upsert(items, embedFn);
    },

    deleteBlock(blockId) {
      const ids = store.byBlock.get(blockId);
      if (!ids) return 0;
      const count = ids.size;
      [...ids].forEach(id => store._removeChunk(id));
      return count;
    },

    deletePage(pageId) {
      const ids = store.byPage.get(pageId);
      if (!ids) return 0;
      const count = ids.size;
      [...ids].forEach(id => store._removeChunk(id));
      return count;
    },

    retrieve(queryVector, k) {
      const limit = Math.max(1, Math.floor(Number(k) || 5));
      const scored = [];
      store.chunks.forEach(chunk => {
        scored.push({ chunk, score: cosine(queryVector, chunk.vector) });
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    persist() {
      if (!filePath) return;
      const data = { version: 1, maxLen, chunks: [...store.chunks.values()] };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data));
    },

    load() {
      if (!filePath || !fs.existsSync(filePath)) return;
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (e) { return; }
      const chunks = Array.isArray(data.chunks) ? data.chunks : [];
      store.chunks.clear();
      store.byBlock.clear();
      store.byPage.clear();
      chunks.forEach(c => {
        if (!c || typeof c.id !== "string") return;
        store.chunks.set(c.id, c);
        store.indexBlock(c.blockId, c.id);
        store.indexPage(c.pageId, c.id);
      });
    },
  };

  return store;
}

/* ---------------- AI configuration ---------------- */

function loadAIConfig(filePath) {
  filePath = filePath || AI_CONFIG_PATH;
  const defaults = {
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiApiKey: "",
    openaiModel: "gpt-4o-mini",
    searxngUrl: "http://127.0.0.1:8080",
  };
  if (!fs.existsSync(filePath)) return defaults;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Object.assign(defaults, data);
  } catch (e) {
    return defaults;
  }
}

function saveAIConfig(config, filePath) {
  filePath = filePath || AI_CONFIG_PATH;
  const current = loadAIConfig(filePath);
  const next = {
    ollamaUrl: typeof config.ollamaUrl === "string" && config.ollamaUrl.trim() ? config.ollamaUrl.trim() : current.ollamaUrl,
    embedModel: typeof config.embedModel === "string" && config.embedModel.trim() ? config.embedModel.trim() : current.embedModel,
    openaiBaseUrl: typeof config.openaiBaseUrl === "string" && config.openaiBaseUrl.trim() ? config.openaiBaseUrl.trim() : current.openaiBaseUrl,
    openaiApiKey: typeof config.openaiApiKey === "string" ? config.openaiApiKey.trim() : current.openaiApiKey,
    openaiModel: typeof config.openaiModel === "string" && config.openaiModel.trim() ? config.openaiModel.trim() : current.openaiModel,
    searxngUrl: typeof config.searxngUrl === "string" && config.searxngUrl.trim() ? config.searxngUrl.trim() : current.searxngUrl,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

/** config shape safe to send to the browser (never includes the API key) */
function publicConfig(config) {
  return {
    ollamaUrl: config.ollamaUrl,
    embedModel: config.embedModel,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    searxngUrl: config.searxngUrl,
    configured: !!config.openaiApiKey,
  };
}

/* ---------------- HTTP helpers ---------------- */

function requestJSON(url, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error("无效的 URL")); return; }
    const mod = parsed.protocol === "https:" ? https : http;
    const body = options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : null;
    const headers = Object.assign({}, options.headers || {});
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers,
      timeout: options.timeout || 30000,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) {
          const isHtml = /^\s*(<!DOCTYPE|<html|<head)/i.test(text);
          let detail;
          if (isHtml) {
            const title = (text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
            detail = "HTTP " + res.statusCode + (res.statusCode === 504 ? "（网关超时，接口上游无响应）" : res.statusCode === 401 || res.statusCode === 403 ? "（鉴权失败，请检查 API Key）" : res.statusCode === 404 ? "（接口不存在，请检查 Base URL 与模型名）" : "") + (title ? " · " + title.trim() : "");
          } else {
            detail = text.slice(0, 300);
          }
          reject(new Error((options.errorLabel || "HTTP " + res.statusCode) + ": " + detail));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { resolve({ raw: text }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** strip HTML tags/scripts/styles down to readable text (zero-dep) */
function htmlToText(html, maxLen) {
  const limit = typeof maxLen === "number" ? maxLen : 20000;
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** fetch a URL and return raw HTML (server-side, no CORS) */
async function fetchRawHtml(url) {
  url = String(url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("无效的网址");
  return await new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error("无效的网址")); return; }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 400) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

/** fetch a URL and return readable text */
async function fetchUrlText(url) {
  return htmlToText(await fetchRawHtml(url));
}

/** 提取网页正文主体并保留段落换行（去掉导航/脚本/样式，块级标签转行） */
function extractArticleText(html) {
  let body = String(html || "");
  const art = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(body);
  if (art) body = art[1];
  else {
    const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(body);
    if (main) body = main[1];
    else {
      const bm = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(body);
      if (bm) body = bm[1];
    }
  }
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote|pre|article)>/gi, "\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  return String(body)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    .split("\n").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
    .slice(0, 100000);
}

/** fetch a URL and return { title, text }（用于「网页保存为笔记」） */
async function fetchWebMeta(url) {
  const html = await fetchRawHtml(url);
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? htmlToText(tm[1], 200) : "";
  const text = extractArticleText(html);
  return { title, text };
}

/** fetch a URL and return raw Buffer（用于图片 base64） */
function fetchRawBuffer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error("无效网址")); return; }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search, method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36", "Accept": "image/*,*/*;q=0.8" },
      timeout: timeoutMs || 15000,
    }, res => {
      if (res.statusCode >= 400) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    req.end();
  });
}

function mimeOfUrl(u) {
  const p = String(u).split("?")[0].toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

async function imageToDataUri(url) {
  try {
    const buf = await fetchRawBuffer(url, 15000);
    if (!buf.length) return null;
    return "data:" + mimeOfUrl(url) + ";base64," + buf.toString("base64");
  } catch (e) { return null; }
}

/** 把正文里的 <img src> 替换为 base64 data URI（限制数量）；同时处理 data-src 懒加载 */
async function inlineImagesBase64(html, baseUrl, limit) {
  const max = Math.max(0, Math.floor(Number(limit) || 20));
  // 把 data-src（懒加载）提升为 src：先处理同时有 src+data-src 的标签，再处理仅有 data-src 的
  html = html.replace(/<img([^>]*)\bsrc=["'][^"']*["']([^>]*)\bdata-src=["']([^"']+)["']([^>]*)>/gi, '<img$1$2 src="$3"$4>');
  html = html.replace(/<img([^>]*)\bdata-src=["']([^"']+)["']([^>]*)>/gi, '<img$1src="$2"$3>');
  const re = /<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const tags = [];
  let m;
  while ((m = re.exec(html))) tags.push(m);
  let done = 0;
  for (const tag of tags) {
    if (done >= max) break;
    const src = tag[1];
    if (/^data:/i.test(src)) continue;
    let abs;
    try { abs = new URL(src, baseUrl).href; } catch (e) { continue; }
    const dataUri = await imageToDataUri(abs);
    if (dataUri) { html = html.split(tag[0]).join(tag[0].replace(src, dataUri)); done++; }
  }
  return html;
}

function inlineHtmlToMarkdown(html) {
  return String(html || "")
    .replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, "*$2*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
    .replace(/[ \t]+/g, " ") // 只压缩空格/tab，保留换行（图片 markdown 需独占一行）
    .split("\n").map(x => x.trim()).filter(Boolean).join("\n");
}

/** 提取 HTML 中的纯文本（解码实体），保留换行和空格，用于代码块等需要保留原格式的场景 */
function htmlToCodeText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } });
}

function htmlToMarkdown(html) {
  let s = String(html || "");
  // 先提取图片（避免被段落/内联处理吞掉），确保每个图片独占一行
  // 同时处理 src 和 data-src（懒加载）
  s = s.replace(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (m, src) => "\n![](" + src + ")\n");
  s = s.replace(/<img[^>]*\bdata-src=["']([^"']+)["'][^>]*>/gi, (m, src) => "\n![](" + src + ")\n");
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (m, t) => "\n# " + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (m, t) => "\n## " + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (m, t) => "\n### " + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (m, t) => "\n#### " + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (m, t) => "\n##### " + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (m, t) => "\n###### " + inlineHtmlToMarkdown(t) + "\n");
  // 代码块：保留原始格式，不经过 inlineHtmlToMarkdown（避免把 <code> 转成反引号、压缩空格）
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, t) => "\n```\n" + htmlToCodeText(t).trimEnd() + "\n```\n");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, t) => "\n" + inlineHtmlToMarkdown(t).split("\n").map(x => "> " + x).join("\n") + "\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => inlineHtmlToMarkdown(t).trim() ? "\n- " + inlineHtmlToMarkdown(t) : "");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (m, t) => "\n" + inlineHtmlToMarkdown(t) + "\n");
  s = s.replace(/<[^>]+>/g, "");
  return s.split("\n").map(x => x.replace(/[ \t]+$/, "")).filter(x => { const y = x.trim(); return y !== "" && !/^[-*]\s*$/.test(y); }).join("\n");
}

/** 从 HTML 中提取匹配开放标签的完整标签范围（处理嵌套），返回包含标签本身的 HTML 片段 */
function extractTagRange(html, openRe, fromIdx) {
  const haystack = fromIdx != null ? html.slice(fromIdx) : html;
  const m = openRe.exec(haystack);
  if (!m) return null;
  const start = (fromIdx != null ? fromIdx : 0) + m.index;
  const open = m[0];
  if (/\/>$/.test(open)) return html.slice(start, start + open.length); // 自闭合
  const openName = /^<([a-zA-Z]+)/.exec(open)[1].toLowerCase();
  let i = start + open.length;
  let depth = 1;
  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  tagRe.lastIndex = i;
  let t;
  while ((t = tagRe.exec(html))) {
    const tag = t[0];
    if (tag.startsWith("</")) {
      const name = /^<\/([a-zA-Z]+)/.exec(tag)[1].toLowerCase();
      if (name === openName) depth--;
      if (depth === 0) return html.slice(start, t.index + tag.length);
    } else if (!/\/>$/.test(tag)) {
      const name = /^<([a-zA-Z]+)/.exec(tag)[1].toLowerCase();
      if (name === openName) depth++;
    }
  }
  return null;
}

/** 启发式提取正文主容器 HTML：优先 article/main，其次常见正文 class（取文本最长），最后 body */
function extractMainHtml(html) {
  // 1. <article>
  const art = extractTagRange(html, /<article[^>]*>/i);
  if (art) return art;
  // 2. <main>
  const main = extractTagRange(html, /<main[^>]*>/i);
  if (main) return main;
  // 3. 常见正文容器（取文本最长）
  let best = null, bestLen = 0;
  const candRe = /<div[^>]*class=["'][^"']*(?:article|content|post|entry|viewer)[^"']*["'][^>]*>/gi;
  let m;
  while ((m = candRe.exec(html))) {
    const seg = extractTagRange(html, /<div[^>]*class=["'][^"']*(?:article|content|post|entry|viewer)[^"']*["'][^>]*>/i, m.index);
    if (!seg) continue;
    const text = seg.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
    if (text > bestLen) { bestLen = text; best = seg; }
  }
  if (best && bestLen > 300) return best;
  // 4. body
  const body = extractTagRange(html, /<body[^>]*>/i);
  return body || html;
}

/** 抓取网页并转成 Markdown（标题/加粗/斜体/代码/列表/引用/图片 base64），用于「保存为笔记」 */
async function fetchWebMarkdown(url) {
  const html = await fetchRawHtml(url);
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = tm ? htmlToText(tm[1], 200) : "";
  let body = extractMainHtml(html);
  if (!body) body = html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<gfg-tab[\s\S]*?<\/gfg-tab>/gi, " ")
    .replace(/<gfg-tab[^>]*\/?>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  body = await inlineImagesBase64(body, url, 100);
  return { title, markdown: htmlToMarkdown(body) };
}

/** 从 DuckDuckGo 重定向链接里提取真实 URL */
function extractDdgUrl(href) {
  const m = /uddg=([^&]+)/.exec(String(href || ""));
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  return href;
}

/** DeepSeek Responses API 原生联网搜索：返回 { text, citations:[{title,url}] } */
async function deepseekWebSearch(config, query, count) {
  const base = String(config.openaiBaseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("未配置 OpenAI Base URL");
  if (!config.openaiApiKey) throw new Error("未配置 OpenAI API Key");
  const res = await requestJSON(base + "/responses", {
    method: "POST",
    body: { model: config.openaiModel, input: String(query || ""), tools: [{ type: "web_search" }], stream: false },
    headers: { "Authorization": "Bearer " + config.openaiApiKey },
    timeout: 60000,
    errorLabel: "DeepSeek 联网搜索失败",
  });
  // 提取整合后的答案文本（多种格式兼容）
  let text = "";
  if (typeof res.output_text === "string") text = res.output_text;
  else if (Array.isArray(res.output)) {
    text = res.output
      .filter(o => o && (o.type === "message" || o.role === "assistant"))
      .map(o => {
        if (Array.isArray(o.content)) return o.content.map(c => (c && (c.text || c.output_text)) || "").join("");
        return o.text || o.output_text || "";
      })
      .join("\n");
  } else if (Array.isArray(res.choices)) {
    text = res.choices.map(c => (c.message && c.message.content) || c.text || "").join("\n");
  }
  // 提取引用 URL（annotations / web_search_call）
  const citations = [];
  const pushCitation = (u, t) => { if (u && /^https?:\/\//i.test(u)) citations.push({ title: t || u, url: u }); };
  if (Array.isArray(res.annotations)) {
    res.annotations.forEach(a => { if (a) pushCitation(a.url || a.source_url, a.title || a.source_title); });
  }
  if (Array.isArray(res.output)) {
    res.output.forEach(o => {
      if (!o) return;
      if (o.type === "web_search_call" || o.type === "web_search") {
        (Array.isArray(o.results) ? o.results : []).forEach(r => pushCitation(r.url || r.source_url, r.title || r.name));
      }
    });
  }
  const limit = Math.max(1, Math.floor(Number(count) || 5));
  return { text, citations: citations.slice(0, limit) };
}

/** DuckDuckGo HTML 接口搜索：返回 [{ title, url, content }] */
async function duckduckgoSearch(query, count) {
  const q = encodeURIComponent(String(query || ""));
  const html = await fetchRawHtml("https://html.duckduckgo.com/html/?q=" + q);
  const limit = Math.max(1, Math.floor(Number(count) || 5));
  const links = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html))) links.push({ href: m[1], title: htmlToText(m[2]) });
  const snippets = [];
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html))) snippets.push(htmlToText(m[1]));
  const results = [];
  for (let i = 0; i < Math.min(limit, links.length); i++) {
    const url = extractDdgUrl(links[i].href);
    if (url) results.push({ title: links[i].title || "", url, content: (snippets[i] || "").slice(0, 500) });
  }
  return results;
}

/** SearXNG 搜索（备用）：返回 [{ title, url, content, score }] */
async function searxngSearch(config, query, count) {
  const base = String(config.searxngUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const q = encodeURIComponent(String(query || ""));
  const res = await requestJSON(base + "/search?q=" + q + "&format=json", { method: "GET", timeout: 20000, errorLabel: "SearXNG 搜索失败" });
  const results = Array.isArray(res.results) ? res.results.slice(0, Math.floor(Number(count) || 5)) : [];
  return results.map(r => ({ title: r.title || "", url: r.url || "", content: String(r.content || "").slice(0, 500), score: r.score }));
}

/** embed a batch of texts via Ollama (并行分批，最大 50 条/批) */
async function embedTexts(config, texts) {
  texts = (texts || []).filter(t => typeof t === "string" && t.trim());
  if (!texts.length) return [];
  const base = String(config.ollamaUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("未配置 Ollama 地址");
  const BATCH_SIZE = 50;
  const allVectors = [];

  // 分批并行请求
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const embedBatch = async (batch) => {
    try {
      const res = await requestJSON(base + "/api/embed", {
        method: "POST",
        body: { model: config.embedModel, input: batch },
        timeout: 120000,
        errorLabel: "Ollama embedding 失败",
      });
      if (Array.isArray(res.embeddings)) return res.embeddings;
    } catch (e) {}
    // 逐个回退
    const out = [];
    for (const t of batch) {
      try {
        const r = await requestJSON(base + "/api/embeddings", {
          method: "POST",
          body: { model: config.embedModel, prompt: t },
          timeout: 60000,
          errorLabel: "Ollama embedding 失败",
        });
        out.push(Array.isArray(r.embedding) ? r.embedding : []);
      } catch (e2) { out.push([]); }
    }
    return out;
  };

  // 最多 3 个并行批次
  const CONCURRENCY = 3;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(group.map(embedBatch));
    results.forEach(r => allVectors.push(...r));
  }
  return allVectors;
}

/** stream an OpenAI-compatible chat completion; onDelta(text) per content delta */
function streamChat(config, messages, onDelta) {
  return new Promise((resolve, reject) => {
    const base = String(config.openaiBaseUrl || "").replace(/\/+$/, "");
    if (!base) { reject(new Error("未配置 OpenAI Base URL")); return; }
    let parsed;
    try { parsed = new URL(base + "/chat/completions"); } catch (e) { reject(new Error("无效的 OpenAI Base URL")); return; }
    const mod = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify({ model: config.openaiModel, messages, stream: true, temperature: 0.3 });
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + (config.openaiApiKey || ""),
        "Accept": "text/event-stream",
      },
      timeout: 120000,
    }, res => {
      if (res.statusCode >= 400) {
        let errText = "";
        res.on("data", c => { errText += c; });
        res.on("end", () => reject(new Error("LLM 调用失败 HTTP " + res.statusCode + ": " + errText.slice(0, 300))));
        return;
      }
      let buf = "";
      const sdec = new StringDecoder("utf8");
      res.on("data", chunk => {
        buf += sdec.write(chunk);
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) onDelta(delta);
          } catch (e) { /* skip malformed sse line */ }
        }
      });
      res.on("end", () => { buf += sdec.end(); resolve(); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("LLM 请求超时")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ---------------- Function calling (skills) ---------------- */

const BLOCK_TYPE_ENUM = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "quote", "callout", "table", "equation", "mermaid", "code", "html"];
const QUESTION_TYPE_ENUM = ["single", "multiple", "judge", "fill", "short_answer"];
const EDITABLE_BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "bullet", "numbered", "todo", "toggle", "quote", "callout", "divider", "code", "snippet", "mermaid", "equation", "table", "image", "embed", "pdf", "highlight", "html", "bookmark", "file"];

const AI_TOOLS = [
  { type: "function", function: { name: "create_note", description: "新建一个笔记页面并写入结构化内容（标题 + 块列表）。用户要求写笔记/记笔记/整理知识点时使用。", parameters: { type: "object", properties: {
    title: { type: "string", description: "页面标题" },
    blocks: { type: "array", description: "笔记块列表", items: { type: "object", properties: {
      type: { type: "string", enum: BLOCK_TYPE_ENUM },
      text: { type: "string", description: "块文字；代码/HTML/Mermaid 图表用 attrs.source" },
      attrs: { type: "object", description: "块属性；代码/HTML/Mermaid 图表用 {source}，表格用 {rows, cols, header}" }
    }, required: ["type"] } }
  }, required: ["title", "blocks"] } } },
  { type: "function", function: { name: "append_blocks", description: "向当前打开的页面追加内容块（可指定插到某个块之后）。用户要求补充/完善/扩展当前笔记时使用。", parameters: { type: "object", properties: {
    blocks: { type: "array", items: { type: "object", properties: {
      type: { type: "string", enum: BLOCK_TYPE_ENUM },
      text: { type: "string", description: "块文字；代码/HTML/Mermaid 图表用 attrs.source" },
      attrs: { type: "object", description: "块属性；代码/HTML/Mermaid 图表用 {source}，表格用 {rows, cols, header}" }
    }, required: ["type"] } },
    after: { type: "string", description: "插到某个块之后（块 id，可选；不填则追加到末尾）" }
  }, required: ["blocks"] } } },
  { type: "function", function: { name: "create_questions", description: "写入多道复习题（单选/多选/判断/填空/简答）。用户要求出题/测验/自测时使用。", parameters: { type: "object", properties: {
    questions: { type: "array", items: { type: "object", properties: {
      type: { type: "string", enum: QUESTION_TYPE_ENUM },
      prompt: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      answer: {},
      explanation: { type: "string" }
    }, required: ["type", "prompt"] } }
  }, required: ["questions"] } } },
  { type: "function", function: { name: "create_flashcards", description: "写入多张学习闪卡（正面 + 背面）。用户要求做闪卡/背记卡片时使用。", parameters: { type: "object", properties: {
    flashcards: { type: "array", items: { type: "object", properties: {
      front: { type: "string" }, back: { type: "string" }
    }, required: ["front", "back"] } }
  }, required: ["flashcards"] } } },
  { type: "function", function: { name: "create_block", description: "在当前打开的页面创建一个块（标题/段落/列表/待办/引用/标注/表格/公式/Mermaid图表/代码/交互网页等），可指定插入位置。", parameters: { type: "object", properties: {
    type: { type: "string", enum: EDITABLE_BLOCK_TYPES, description: "块类型；交互网页用 html，Mermaid 图表用 mermaid，公式用 equation，代码用 code" },
    text: { type: "string", description: "块文本。公式填 $$...$$" },
    attrs: { type: "object", description: "块属性。交互网页 html 传 {source:\"完整HTML文档\"}；Mermaid 图表 mermaid 传 {source:\"mermaid代码\"}；代码 code 传 {language,source}；表格 table 传 {cols,header,rows:[[单元格,...],...]}" },
    after: { type: "string", description: "插到某个块之后（块 id，可选）" },
    before: { type: "string", description: "插到某个块之前（块 id，可选）" }
  }, required: ["type"] } } },
  { type: "function", function: { name: "update_block", description: "替换/重写当前页面中已有块的内容或属性（传入 blockId，用新 text 覆盖旧内容）。用户要求修改、替换、改写某个已有块时使用。", parameters: { type: "object", properties: {
    blockId: { type: "string" },
    text: { type: "string" },
    type: { type: "string", enum: EDITABLE_BLOCK_TYPES },
    attrs: { type: "object" },
    checked: { type: "boolean" }
  }, required: ["blockId"] } } },
  { type: "function", function: { name: "delete_block", description: "删除当前页面中已有的块（传入 blockId）。", parameters: { type: "object", properties: {
    blockId: { type: "string" }
  }, required: ["blockId"] } } },
  { type: "function", function: { name: "move_block", description: "移动当前页面中的块到目标块之前或之后。", parameters: { type: "object", properties: {
    blockId: { type: "string" }, targetId: { type: "string" }, position: { type: "string", enum: ["before", "after"] }
  }, required: ["blockId"] } } },
  { type: "function", function: { name: "load_skill", description: "加载某个技能（skill，Claude Code/Codex 风格的 SKILL.md）的完整说明，之后严格按其要求执行或扮演。", parameters: { type: "object", properties: {
    name: { type: "string", description: "技能名称" }
  }, required: ["name"] } } },
  { type: "function", function: { name: "create_web_page", description: "新建一个网页页面（嵌入式浏览器）加入库中，或把网址收藏为页面。", parameters: { type: "object", properties: {
    url: { type: "string", description: "网页地址，如 https://example.com" },
    title: { type: "string", description: "页面标题（可选）" }
  }, required: ["url"] } } },
  { type: "function", function: { name: "create_pdf_page", description: "新建一个 PDF 页面加入库中（用浏览器内置查看器渲染）。", parameters: { type: "object", properties: {
    url: { type: "string", description: "PDF 网址，如 https://example.com/doc.pdf" },
    title: { type: "string", description: "页面标题（可选）" },
    page: { type: "number", description: "默认显示第几页（可选，从 1 开始）" }
  }, required: ["url"] } } },
  { type: "function", function: { name: "list_pages", description: "列出工作区中的所有页面（笔记、网页、PDF、数据库、代码等），返回 id、标题、类型、网址。需要了解工作区里有哪些资料时使用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_pdf", description: "读取工作区中某个 PDF 页面的文字内容（供分析/总结/引用）。", parameters: { type: "object", properties: {
    pageId: { type: "string", description: "PDF 页面的 id（从 list_pages 获取）" },
    url: { type: "string", description: "PDF 网址（未提供 pageId 时使用）" }
  } } } },
  { type: "function", function: { name: "read_web", description: "读取工作区中某个网页页面的正文文字内容（抓取网页）。", parameters: { type: "object", properties: {
    pageId: { type: "string", description: "网页页面的 id（从 list_pages 获取）" },
    url: { type: "string", description: "网页网址（未提供 pageId 时使用）" }
  } } } },
  { type: "function", function: { name: "ask_block_types", description: "在生成长篇内容前，先询问用户希望使用哪些块类型（弹出多选）。调用后等待用户选择，再根据返回的 blockTypes 生成内容。", parameters: { type: "object", properties: {
    purpose: { type: "string", description: "简要说明要生成什么内容，用于提示用户" }
  } } } },
  { type: "function", function: { name: "query_memory", description: "查询长期记忆（L3，RAG 检索）。当需要回忆用户偏好、身份、过往决定、项目背景、约定等历史信息时使用；记忆不会全部注入上下文，按需查询。", parameters: { type: "object", properties: {
    query: { type: "string", description: "要查询的问题或关键词，如「用户喜欢什么写作风格」「上次关于项目 X 的决定」" },
    k: { type: "number", description: "返回条数，默认 5" }
  }, required: ["query"] } } },
  { type: "function", function: { name: "save_memory", description: "保存一条长期记忆。在对话中得知值得长期记住的重要事实、用户偏好、决定、约定、项目背景时调用。", parameters: { type: "object", properties: {
    text: { type: "string", description: "要记住的内容，一句话清晰描述" },
    importance: { type: "number", description: "重要程度 1-5，默认 3（5=极重要，需长期记住）" }
  }, required: ["text"] } } },
  { type: "function", function: { name: "list_knowledge_bases", description: "列出所有知识库（返回 id 和名称）。需要知道有哪些知识库、或要按库检索时使用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "query_knowledge_base", description: "在知识库中检索（RAG）。当用户询问的知识可能存在于上传的资料、网址、代码或笔记中时使用；可指定某个知识库，不指定则检索全部知识库。", parameters: { type: "object", properties: {
    query: { type: "string", description: "要检索的问题或关键词" },
    kbId: { type: "string", description: "知识库 id（可选；不填则检索全部知识库，先 list_knowledge_bases 获取 id）" },
    k: { type: "number", description: "返回条数，默认 5" }
  }, required: ["query"] } } },
  { type: "function", function: { name: "web_search", description: "联网搜索（DeepSeek 原生搜索）。当需要查找最新资料、或工作区/知识库之外的信息时使用；返回整合后的答案文本(text)和引用网址列表(results)。", parameters: { type: "object", properties: {
    query: { type: "string", description: "搜索关键词" },
    count: { type: "number", description: "返回条数，默认 5" }
  }, required: ["query"] } } },
  { type: "function", function: { name: "save_web_to_kb", description: "抓取网页正文并存入知识库。只收集文章/博客/教程/文档/百科/论文类资源，跳过搜索引擎首页或结果页（google.com、baidu.com、bing.com 的首页或 /search /s 页）、门户首页、导航页、登录页。搜索到有用的网页后调用；kbId 不填则存入第一个知识库（先 list_knowledge_bases 获取）。", parameters: { type: "object", properties: {
    url: { type: "string", description: "网页网址" },
    kbId: { type: "string", description: "知识库 id（可选）" },
    name: { type: "string", description: "文档名称（可选，默认用网址）" }
  }, required: ["url"] } } },
  { type: "function", function: { name: "create_exam", description: "根据指定主题从题库中 RAG 检索相关题目，自动生成一份试卷。用户要求出试卷/组卷/生成考试题时使用。", parameters: { type: "object", properties: {
    topic: { type: "string", description: "试卷主题/科目" },
    count: { type: "number", description: "题目数量（默认 5，最多 30）" }
  }, required: ["topic"] } } },
];

/** 从 OpenAI 风格 message 中提取 content / reasoning_content / tool_calls（保留思考内容供多轮回传） */
function extractChatMessage(msg) {
  return {
    content: (msg && msg.content) || "",
    reasoning_content: (msg && msg.reasoning_content) || "",
    tool_calls: ((msg && msg.tool_calls) || []).map(tc => ({
      id: tc.id,
      name: tc.function && tc.function.name,
      arguments: (tc.function && tc.function.arguments) || "{}",
    })),
  };
}

/** non-streaming OpenAI-compatible chat completion with optional tools (1 retry on transient failure) */
async function chatOnce(config, messages, tools) {
  const url = String(config.openaiBaseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  const opts = {
    method: "POST",
    body: { model: config.openaiModel, messages, tools: tools && tools.length ? tools : undefined, temperature: 0.3 },
    headers: { "Authorization": "Bearer " + (config.openaiApiKey || "") },
    timeout: 120000,
    errorLabel: "LLM 调用失败",
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await requestJSON(url, opts);
      return extractChatMessage(json.choices && json.choices[0] && json.choices[0].message);
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastError;
}

/* ---------------- Skills (Claude Code / Codex style SKILL.md) ---------------- */

/** parse name + description from SKILL.md YAML frontmatter (minimal, zero-dep) */
function parseSkillFrontmatter(content) {
  const s = String(content == null ? "" : content);
  const m = s.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: "", description: "" };
  const out = { name: "", description: "" };
  m[1].split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(":");
    if (idx < 0) return;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
  });
  return out;
}

/** recursively discover SKILL.md files and return {name, description, relPath, path}[] */
function scanSkills(dir) {
  const results = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") {
        let content;
        try { content = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
        const fm = parseSkillFrontmatter(content);
        results.push({
          name: fm.name || path.basename(path.dirname(full)),
          description: fm.description || "",
          relPath: path.relative(dir, full),
          path: full,
        });
      }
    }
  };
  walk(dir || SKILLS_DIR);
  return results;
}

/** load the full SKILL.md content by name / relPath / path; null when not found */
function loadSkill(dir, name) {
  const skills = scanSkills(dir);
  const found = skills.find(s => s.name === name || s.relPath === name || s.path === name || path.basename(path.dirname(s.path)) === name);
  if (!found) return null;
  try { return fs.readFileSync(found.path, "utf8"); } catch (e) { return null; }
}

module.exports = { chunkText, cosine, buildChunkId, hashText, buildPrompt, createIndexStore, DEFAULT_MAX_LEN,
  AI_CONFIG_PATH, AI_INDEX_PATH, SKILLS_DIR, loadAIConfig, saveAIConfig, publicConfig, embedTexts, streamChat, requestJSON, chatOnce, extractChatMessage, AI_TOOLS,
  htmlToText, fetchUrlText, fetchWebMeta, fetchWebMarkdown, htmlToMarkdown, extractArticleText, fetchRawHtml, duckduckgoSearch, extractDdgUrl, deepseekWebSearch, searxngSearch, parseSkillFrontmatter, scanSkills, loadSkill };
