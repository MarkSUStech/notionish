/* ============ Long-term memory persistence and index synchronization ============ */
"use strict";

const fs = require("fs");
const path = require("path");

const normalizeImportance = value => Math.max(1, Math.min(5, Number(value) || 3));

const normalizeText = value => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("缺少 text");
  return text.slice(0, 2000);
};

const createMemoryStore = options => {
  const opts = options || {};
  const dataPath = opts.dataPath;
  const index = opts.index;
  const embedTexts = opts.embedTexts;
  let entries = [];

  const persist = () => {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(entries));
    index.persist();
  };

  const load = () => {
    if (fs.existsSync(dataPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        entries = Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry.id === "string" && typeof entry.text === "string") : [];
      } catch (error) {
        entries = [];
      }
    }
    index.load();
  };

  const syncIndex = async entry => {
    try {
      await index.upsert([{ pageId: "memory", blockId: entry.id, pageTitle: "", text: entry.text }], embedTexts);
      return true;
    } catch (error) {
      return false;
    }
  };

  const list = () => entries
    .map(entry => Object.assign({}, entry))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const create = async input => {
    const now = Date.now();
    const entry = {
      id: "mem_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      text: normalizeText(input && input.text),
      importance: normalizeImportance(input && input.importance),
      createdAt: now,
      lastAccess: now,
    };
    entries.push(entry);
    const indexed = await syncIndex(entry);
    persist();
    return { entry: Object.assign({}, entry), indexed };
  };

  const update = async (id, input) => {
    const entry = entries.find(item => item.id === id);
    if (!entry) throw new Error("记忆不存在");
    entry.text = normalizeText(input && input.text);
    entry.importance = normalizeImportance(input && input.importance);
    entry.lastAccess = Date.now();
    const indexed = await syncIndex(entry);
    persist();
    return { entry: Object.assign({}, entry), indexed };
  };

  const remove = id => {
    const position = entries.findIndex(item => item.id === id);
    if (position < 0) throw new Error("记忆不存在");
    const removed = entries.splice(position, 1)[0];
    index.deleteBlock(id);
    persist();
    return Object.assign({}, removed);
  };

  const touch = ids => {
    const idSet = new Set(ids);
    const now = Date.now();
    entries.forEach(entry => { if (idSet.has(entry.id)) entry.lastAccess = now; });
    if (idSet.size) persist();
  };

  const summary = limit => {
    const count = Math.max(1, Math.min(20, Number(limit) || 8));
    return entries
      .filter(entry => entry.text)
      .slice()
      .sort((a, b) => ((b.importance || 0) * 100000 + (b.lastAccess || 0)) - ((a.importance || 0) * 100000 + (a.lastAccess || 0)))
      .slice(0, count)
      .map(entry => "- " + entry.text.slice(0, 120))
      .join("\n");
  };

  load();
  return { list, create, update, remove, touch, summary };
};

module.exports = { createMemoryStore, normalizeImportance, normalizeText };
