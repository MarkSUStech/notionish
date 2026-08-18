// Long-term memory domain and UI contract tests
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createMemoryStore } = require("./server-memory.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notionish-memory-"));
const dataPath = path.join(tmpDir, "memory.json");
const indexOps = [];
const index = {
  load() {},
  persist() { indexOps.push(["persist"]); },
  async upsert(items) { indexOps.push(["upsert", items]); },
  deleteBlock(id) { indexOps.push(["delete", id]); return 1; },
};
const store = createMemoryStore({ dataPath, index, embedTexts: async texts => texts.map(() => [1]) });

(async () => {
  assert.deepStrictEqual(store.list(), []);

  const created = await store.create({ text: "  用户喜欢简洁回答  ", importance: 9 });
  assert.strictEqual(created.entry.text, "用户喜欢简洁回答");
  assert.strictEqual(created.entry.importance, 5);
  assert.strictEqual(created.indexed, true);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(dataPath, "utf8")).length, 1);
  assert.strictEqual(indexOps.at(-2)[0], "upsert");
  assert.strictEqual(indexOps.at(-2)[1][0].text, "用户喜欢简洁回答");

  const updated = await store.update(created.entry.id, { text: "用户偏好直接给结论", importance: 1 });
  assert.strictEqual(updated.entry.id, created.entry.id);
  assert.strictEqual(updated.entry.text, "用户偏好直接给结论");
  assert.strictEqual(updated.entry.importance, 1);
  assert.strictEqual(updated.entry.createdAt, created.entry.createdAt);

  await assert.rejects(() => store.create({ text: "  " }), /缺少 text/);
  await assert.rejects(() => store.update("missing", { text: "x" }), /记忆不存在/);

  const removed = store.remove(created.entry.id);
  assert.strictEqual(removed.id, created.entry.id);
  assert.deepStrictEqual(store.list(), []);
  assert(indexOps.some(op => op[0] === "delete" && op[1] === created.entry.id));
  assert.throws(() => store.remove("missing"), /记忆不存在/);

  const root = __dirname;
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
  const memorySource = fs.readFileSync(path.join(root, "js", "memory.js"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "js", "settings.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert(serverSource.includes('url.startsWith("/api/memory/")'));
  assert(serverSource.includes('req.method === "PUT"'));
  assert(serverSource.includes('req.method === "DELETE"'));
  assert(appSource.includes('hash === "memory"') && appSource.includes("MemoryPage.render()"));
  assert(memorySource.includes("/api/memory/list"));
  assert(memorySource.includes('method: "PUT"'));
  assert(memorySource.includes('method: "DELETE"'));
  assert(memorySource.includes("memory-text") && memorySource.includes("memory-importance"));
  assert(settingsSource.includes('openPage("memory")'));
  assert(htmlSource.includes('src="js/memory.js"'));

  console.log("PASS  memory CRUD, persistence, index synchronization, and UI contracts");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
