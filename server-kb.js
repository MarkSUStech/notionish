/* ============ Knowledge base: multiple KBs, documents, embedding index, RAG ============ */
"use strict";

const fs = require("fs");
const path = require("path");

const normalizeName = value => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("名称不能为空");
  return name.slice(0, 120);
};

const normalizeText = value => {
  const text = typeof value === "string" ? value : "";
  return text.slice(0, 50000);
};

const createKnowledgeStore = options => {
  const opts = options || {};
  const dataDir = opts.dataDir; // data 目录（其下 kb/ 子目录存各库文档）
  const index = opts.index;     // 统一向量索引（createIndexStore）
  const embedTexts = opts.embedTexts;

  let kbs = []; // [{ id, name, createdAt }]

  const kbFile = () => path.join(dataDir, "knowledge-bases.json");
  const docFile = kbId => path.join(dataDir, "kb", kbId + ".json");
  const pageId = kbId => "kb:" + kbId;
  const blockId = (kbId, docId) => "kb:" + kbId + ":" + docId;

  const load = () => {
    if (fs.existsSync(kbFile())) {
      try {
        const parsed = JSON.parse(fs.readFileSync(kbFile(), "utf8"));
        kbs = Array.isArray(parsed) ? parsed.filter(k => k && typeof k.id === "string" && typeof k.name === "string") : [];
      } catch (e) { kbs = []; }
    }
    index.load();
  };

  const persistKbs = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(kbFile(), JSON.stringify(kbs));
  };

  const loadDocs = kbId => {
    const file = docFile(kbId);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(d => d && typeof d.id === "string") : [];
    } catch (e) { return []; }
  };

  const persistDocs = (kbId, docs) => {
    fs.mkdirSync(path.dirname(docFile(kbId)), { recursive: true });
    fs.writeFileSync(docFile(kbId), JSON.stringify(docs));
  };

  const findKb = kbId => kbs.find(k => k.id === kbId);

  const listKbs = () => kbs.slice().sort((a, b) => a.createdAt - b.createdAt).map(k => Object.assign({}, k));

  const createKb = name => {
    const kb = {
      id: "kb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      name: normalizeName(name),
      createdAt: Date.now(),
    };
    kbs.push(kb);
    persistKbs();
    return Object.assign({}, kb);
  };

  const renameKb = (kbId, name) => {
    const kb = findKb(kbId);
    if (!kb) throw new Error("知识库不存在");
    kb.name = normalizeName(name);
    persistKbs();
    return Object.assign({}, kb);
  };

  const removeKb = kbId => {
    const kb = findKb(kbId);
    if (!kb) throw new Error("知识库不存在");
    kbs = kbs.filter(k => k.id !== kbId);
    persistKbs();
    try { fs.rmSync(docFile(kbId), { force: true }); } catch (e) { /* ignore */ }
    index.deletePage(pageId(kbId));
    index.persist();
    return true;
  };

  const listDocs = kbId => {
    if (!findKb(kbId)) throw new Error("知识库不存在");
    return loadDocs(kbId).map(d => Object.assign({}, d));
  };

  const getDoc = (kbId, docId) => {
    const doc = loadDocs(kbId).find(d => d.id === docId);
    if (!doc) throw new Error("文档不存在");
    return Object.assign({}, doc);
  };

  const addDoc = async (kbId, input) => {
    const kb = findKb(kbId);
    if (!kb) throw new Error("知识库不存在");
    const kind = ["text", "url", "note"].includes(input && input.kind) ? input.kind : "text";
    const doc = {
      id: "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      name: normalizeName(input && input.name || (kind === "url" ? "网页" : "文档")),
      kind,
      text: normalizeText(input && input.text),
      url: kind === "url" && typeof (input && input.url) === "string" ? input.url.slice(0, 2000) : null,
      createdAt: Date.now(),
      size: String(input && input.text || "").length,
      indexed: false,
    };
    if (!doc.text.trim()) throw new Error("内容为空");
    const docs = loadDocs(kbId);
    docs.push(doc);
    persistDocs(kbId, docs);
    try {
      await index.upsert([{ pageId: pageId(kbId), blockId: blockId(kbId, doc.id), pageTitle: kb.name, text: doc.text }], embedTexts);
      doc.indexed = true;
      persistDocs(kbId, docs);
    } catch (e) { /* 嵌入失败，保留 doc 但 indexed=false */ }
    index.persist();
    return Object.assign({}, doc);
  };

  const removeDoc = (kbId, docId) => {
    const docs = loadDocs(kbId);
    const idx = docs.findIndex(d => d.id === docId);
    if (idx < 0) throw new Error("文档不存在");
    const removed = docs.splice(idx, 1)[0];
    persistDocs(kbId, docs);
    index.deleteBlock(blockId(kbId, docId));
    index.persist();
    return Object.assign({}, removed);
  };

  const reindex = async kbId => {
    const kb = findKb(kbId);
    if (!kb) throw new Error("知识库不存在");
    const docs = loadDocs(kbId);
    const items = docs.filter(d => d.text && d.text.trim()).map(d => ({ pageId: pageId(kbId), blockId: blockId(kbId, d.id), pageTitle: kb.name, text: d.text }));
    index.deletePage(pageId(kbId));
    await index.upsert(items, embedTexts);
    index.persist();
    return items.length;
  };

  /** RAG 检索：kbId 为空时检索全部知识库 */
  const query = async (kbId, queryText, k) => {
    const text = (queryText || "").trim();
    if (!text) return [];
    const qv = (await embedTexts([text]))[0] || [];
    const all = index.retrieve(qv, Math.max(10, Math.floor(Number(k) || 5) * 3));
    const hits = kbId
      ? all.filter(h => h.chunk.pageId === pageId(kbId))
      : all.filter(h => String(h.chunk.pageId).startsWith("kb:"));
    return hits.slice(0, Math.floor(Number(k) || 5)).map(h => ({
      kbId: String(h.chunk.pageId).slice(3),
      docId: String(h.chunk.blockId).replace(h.chunk.pageId + ":", ""),
      text: h.chunk.text,
      score: Math.round(h.score * 100) / 100,
    }));
  };

  load();
  return { listKbs, createKb, renameKb, removeKb, listDocs, getDoc, addDoc, removeDoc, reindex, query };
};

module.exports = { createKnowledgeStore, normalizeName, normalizeText };
