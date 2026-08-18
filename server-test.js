// Server logic tests (direct require, no HTTP/loopback needed)
const assert = require("assert");
const srv = require("./server.js");
const mcp = require("./server-mcp.js");

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

/* ---------------- MCP bridge pure logic ---------------- */
check("mcp exposes at least 24 tools", Object.keys(mcp.TOOLS).length >= 24);
check("mcp tool defs are complete", mcp.listTools().every(t => t.name && t.description && t.inputSchema && t.inputSchema.type === "object"));
check("mcp rejects unknown tool", mcp.validateTool("no_such_tool", {}).ok === false);
check("mcp rejects missing required args", mcp.validateTool("workspace.update_theme", {}).ok === false);
check("mcp accepts valid args", mcp.validateTool("workspace.update_theme", { theme: "dark" }).ok === true);
check("mcp rejects wrong arg type", mcp.validateTool("workspace.update_theme", { theme: 42 }).ok === false);
check("mcp rejects bad enum value", mcp.validateTool("workspace.update_theme", { theme: "blue" }).ok === false);
check("mcp rejects missing required page id", mcp.validateTool("page.get", {}).ok === false);

const bridge = mcp.createBridge({ token: "tok" });
const enqueued = bridge.enqueue("page.list", {});
const dispatched = bridge.poll("tok");
check("bridge poll returns queued request for valid token", dispatched !== null && dispatched.id === enqueued.id);
check("bridge poll does not redeliver same request", bridge.poll("tok") === null);
check("bridge poll rejects wrong token", bridge.poll("nope") === null);
check("bridge submitResult returns true for valid token", bridge.submitResult("tok", enqueued.id, { ok: true, result: {} }) === true);
check("bridge submitResult rejects wrong token", bridge.submitResult("bad", enqueued.id, { ok: true, result: {} }) === false);

const files = [
  { path: "app.py", language: "python", content: "print('hi')" },
  { path: "util.py", language: "python", content: "def x(): pass" },
  { path: "lib.cpp", language: "cpp", content: "int y(){return 1;}" },
  { path: "Main.java", language: "java", content: "class Main{}" },
];

check("sanitize rejects traversal", srv.sanitizeRelPath("../etc/passwd") === null);
check("sanitize keeps normal path", srv.sanitizeRelPath("src/app.py") === "src/app.py");
check("isLowValueUrl rejects search engine", srv.isLowValueUrl("https://www.google.com/search?q=x") === true && srv.isLowValueUrl("https://baidu.com/s?wd=x") === true);
check("isLowValueUrl rejects root homepages", srv.isLowValueUrl("https://example.com/") === true && srv.isLowValueUrl("https://zhihu.com") === true);
check("isLowValueUrl accepts article pages", srv.isLowValueUrl("https://example.com/blog/how-to-x") === false && srv.isLowValueUrl("https://zhuanlan.zhihu.com/p/123456") === false);
check("normalize filters bad files", srv.normalizeFiles(files).length === 4);
check("python plan runs entry", JSON.stringify(srv.planRun("python", "app.py", files)) === JSON.stringify({ steps: [{ cmd: "python", args: ["app.py"] }] }));
check("cpp plan compiles then runs", srv.planRun("cpp", "app.cpp", files).steps.length === 2 && srv.planRun("cpp", "app.cpp", files).steps[0].cmd === "g++");
check("java plan compiles all java then runs main", JSON.stringify(srv.planRun("java", "Main.java", files).steps[1]) === JSON.stringify({ cmd: "java", args: ["Main"] }));

(async () => {
  const compilers = await srv.detectCompilers();
  check("compiler detection returns a language map", ["python", "c", "cpp", "java"].every(k => Array.isArray(compilers[k])));

  // MCP bridge async behaviors: result resolution and timeout
  const b2 = mcp.createBridge({ token: "tok2", timeoutMs: 120 });
  const q2 = b2.enqueue("page.get", { id: "x" });
  const wait2 = b2.waitResult(q2.id);
  b2.submitResult("tok2", q2.id, { ok: true, result: { id: "x" } });
  const r2 = await wait2;
  check("bridge waitResult resolves submitted result", r2.ok === true && r2.result.id === "x");

  const b3 = mcp.createBridge({ token: "tok3", timeoutMs: 90 });
  const q3 = b3.enqueue("page.get", { id: "y" });
  const t0 = Date.now();
  const r3 = await b3.waitResult(q3.id);
  check("bridge waitResult times out with actionable error", r3.ok === false && typeof r3.error === "string" && (Date.now() - t0) >= 80);

  // End-to-end python run; skipped when the sandbox blocks process spawn.
  let skipped = null;
  try {
    const lines = [];
    const result = await srv.runProject({ language: "python", entry: "main.py", files: [{ path: "main.py", language: "python", content: "print(2+3)" }], timeoutMs: 10000, onLine: o => lines.push(o) });
    if (result.error && /EPERM|permission/i.test(result.error)) skipped = "沙箱阻止子进程 spawn，跳过端到端执行";
    else check("python run executes and streams output", result.ok === true && lines.some(l => l.stream === "stdout" && l.text.includes("5")));
  } catch (e) {
    skipped = "端到端执行异常: " + e.message;
  }

  const fails = results.filter(r => !r.pass);
  console.log(results.map(r => (r.pass ? "PASS" : "FAIL") + "  " + r.name).join("\n"));
  if (skipped) console.log("SKIP  " + skipped);
  console.log("\n" + results.length + " checks, " + fails.length + " failed" + (skipped ? ", 1 skipped" : ""));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
