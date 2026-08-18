// Knowledge base pure-logic tests (fake embedder injected)
const fs = require("fs");
const os = require("os");
const path = require("path");
const ai = require("./server-ai.js");
const kb = require("./server-kb.js");

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-test-"));
  const index = ai.createIndexStore({ filePath: path.join(tmpDir, "index.json") });
  const embed = async texts => texts.map((t, i) => [1, (i % 7) + 1, (String(t).length % 5) + 1]);
  const store = kb.createKnowledgeStore({ dataDir: tmpDir, index, embedTexts: embed });

  const k = store.createKb("我的知识库");
  check("createKb creates a kb", !!k && k.id && k.name === "我的知识库" && k.createdAt > 0);
  check("listKbs lists kb", store.listKbs().length === 1);

  const doc = await store.addDoc(k.id, { name: "勾股定理.md", kind: "text", text: "勾股定理：直角三角形两直角边平方和等于斜边平方。" });
  check("addDoc adds and indexes", !!doc && doc.id && doc.indexed === true && doc.size > 0);
  check("listDocs lists doc", store.listDocs(k.id).length === 1);

  const urlDoc = await store.addDoc(k.id, { name: "牛顿定律", kind: "url", text: "牛顿第二定律 F=ma。", url: "https://example.com/newton" });
  check("addDoc url kind keeps url", urlDoc.kind === "url" && urlDoc.url === "https://example.com/newton");

  check("removeDoc removes and keeps others", store.removeDoc(k.id, urlDoc.id).id === urlDoc.id && store.listDocs(k.id).length === 1);

  const hits = await store.query(null, "勾股定理", 3);
  check("query returns hits with kbId", Array.isArray(hits) && hits.length >= 1 && hits[0].kbId === k.id && hits[0].text.includes("勾股"));

  const scoped = await store.query(k.id, "勾股定理", 3);
  check("query scoped to kb", Array.isArray(scoped) && scoped.every(h => h.kbId === k.id));

  const other = await store.query("kb_nonexistent", "勾股定理", 3);
  check("query missing kb returns empty", Array.isArray(other) && other.length === 0);

  const n = await store.reindex(k.id);
  check("reindex re-indexes docs", n === 1);

  check("getDoc returns single doc", store.getDoc(k.id, doc.id).id === doc.id && store.getDoc(k.id, doc.id).text.includes("勾股"));

  store.removeKb(k.id);
  check("removeKb removes kb", store.listKbs().length === 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const fails = results.filter(r => !r.pass);
  console.log(results.map(r => (r.pass ? "PASS" : "FAIL") + "  " + r.name).join("\n"));
  console.log("\n" + results.length + " checks, " + fails.length + " failed");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
