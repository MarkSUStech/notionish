// Server AI RAG pure logic tests (no external services, fake embedder injected)
const fs = require("fs");
const os = require("os");
const path = require("path");
const ai = require("./server-ai.js");

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

// ---- chunking ----
const short = ai.chunkText("只有一句话", 500);
check("chunkText keeps short text as one chunk", short.length === 1 && short[0] === "只有一句话");

const long = "段落一".repeat(200) + "\n" + "段落二".repeat(200) + "\n" + "段落三".repeat(50);
const chunks = ai.chunkText(long, 300);
check("chunkText splits long text into multiple chunks", chunks.length > 1);
check("chunkText chunks stay within max length", chunks.every(c => c.length <= 300));

// ---- cosine ----
check("cosine identical vectors is 1", Math.abs(ai.cosine([1, 0, 2], [1, 0, 2]) - 1) < 1e-9);
check("cosine orthogonal vectors is 0", Math.abs(ai.cosine([1, 0], [0, 1])) < 1e-9);
check("cosine zero vector is 0", ai.cosine([0, 0], [1, 2]) === 0);

// ---- chunk id ----
check("chunk id is deterministic", ai.buildChunkId("pg1", "blk2", 0) === ai.buildChunkId("pg1", "blk2", 0));
check("chunk id differs by index", ai.buildChunkId("pg1", "blk2", 0) !== ai.buildChunkId("pg1", "blk2", 1));

// ---- function calling (skills) ----
check("AI_TOOLS defines 27 skills", Array.isArray(ai.AI_TOOLS) && ai.AI_TOOLS.length === 27 && ai.AI_TOOLS.every(t => t.type === "function" && t.function.name));
check("AI_TOOLS includes block editing skills", ai.AI_TOOLS.some(t => t.function.name === "create_block") && ai.AI_TOOLS.some(t => t.function.name === "update_block") && ai.AI_TOOLS.some(t => t.function.name === "delete_block") && ai.AI_TOOLS.some(t => t.function.name === "move_block") && ai.AI_TOOLS.some(t => t.function.name === "load_skill") && ai.AI_TOOLS.some(t => t.function.name === "create_web_page") && ai.AI_TOOLS.some(t => t.function.name === "create_pdf_page"));
check("AI_TOOLS includes ask_block_types", ai.AI_TOOLS.some(t => t.function.name === "ask_block_types"));
check("AI_TOOLS includes memory tools", ai.AI_TOOLS.some(t => t.function.name === "query_memory") && ai.AI_TOOLS.some(t => t.function.name === "save_memory"));
check("AI_TOOLS includes PDF/web access skills", ai.AI_TOOLS.some(t => t.function.name === "list_pages") && ai.AI_TOOLS.some(t => t.function.name === "read_pdf") && ai.AI_TOOLS.some(t => t.function.name === "read_web"));
check("htmlToText strips tags and decodes entities", ai.htmlToText("<h1>标题</h1><p>a &amp; b</p><script>x()</script>").includes("标题") && ai.htmlToText("<p>a &amp; b</p>").trim() === "a & b" && !ai.htmlToText("<p>x</p><script>secret</script>").includes("secret"));
check("fetchUrlText is exported", typeof ai.fetchUrlText === "function");
check("chatOnce is exported", typeof ai.chatOnce === "function");
check("extractChatMessage is exported", typeof ai.extractChatMessage === "function");
const thinkingMsg = ai.extractChatMessage({ content: null, reasoning_content: "思考过程", tool_calls: [{ id: "c1", function: { name: "create_note", arguments: "{\"title\":\"x\"}" } }] });
check("extractChatMessage preserves reasoning_content", thinkingMsg.reasoning_content === "思考过程" && thinkingMsg.tool_calls.length === 1 && thinkingMsg.tool_calls[0].name === "create_note");

// ---- skills (Claude Code / Codex SKILL.md) ----
const fm = ai.parseSkillFrontmatter("---\nname: test-skill\ndescription: 测试技能\n---\n正文");
check("parseSkillFrontmatter extracts name+description", fm.name === "test-skill" && fm.description === "测试技能");
const realSkills = ai.scanSkills(ai.SKILLS_DIR);
check("scanSkills discovers SKILL.md files", Array.isArray(realSkills) && realSkills.length >= 2 && realSkills.every(s => s.name && s.path));
const zhu = realSkills.find(s => s.name === "relationship-zhu");
check("scanSkills finds relationship-zhu", !!zhu && zhu.description.includes("猪"));
const drawioSkill = realSkills.find(s => s.name === "drawio-skill");
check("scanSkills finds drawio-skill", !!drawioSkill && drawioSkill.description.includes("diagram"));
const htmlSkill = realSkills.find(s => s.name === "html");
check("scanSkills finds html skill", !!htmlSkill && htmlSkill.description.toLowerCase().includes("html"));
const toolNames = ai.AI_TOOLS.map(t => t.function.name);
check("AI_TOOLS includes knowledge base tools", toolNames.includes("query_knowledge_base") && toolNames.includes("list_knowledge_bases"));
check("AI_TOOLS includes web search tools", toolNames.includes("web_search") && toolNames.includes("save_web_to_kb"));
check("duckduckgoSearch and extractDdgUrl exported", typeof ai.duckduckgoSearch === "function" && typeof ai.extractDdgUrl === "function" && typeof ai.fetchRawHtml === "function");
check("deepseekWebSearch exported", typeof ai.deepseekWebSearch === "function");
check("extractDdgUrl decodes uddg param", ai.extractDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc") === "https://example.com/page");
check("extractArticleText extracts article body and drops nav/footer", (() => {
  const html = "<html><body><nav>导航</nav><article><p>第一段正文</p><p>第二段内容较长</p><script>var x=1</script></article><footer>页脚</footer></body></html>";
  const t = ai.extractArticleText(html);
  return t.includes("第一段正文") && t.includes("第二段内容较长") && !t.includes("导航") && !t.includes("页脚") && !t.includes("var x");
})());
check("htmlToMarkdown converts headings/bold/lists/image", (() => {
  const md = ai.htmlToMarkdown('<h1>标题</h1><p>这是<strong>加粗</strong>内容</p><ul><li>项目一</li></ul><img src="data:image/png;base64,AAA">');
  return md.includes("# 标题") && md.includes("**加粗**") && md.includes("- 项目一") && md.includes("![](data:image/png;base64,AAA)");
})());
check("htmlToMarkdown keeps image inside paragraph", (() => {
  const md = ai.htmlToMarkdown('<p>文字内容<img src="data:image/png;base64,AAA"></p>');
  return md.includes("文字内容") && md.includes("![](data:image/png;base64,AAA)");
})());
const skillContent = ai.loadSkill(ai.SKILLS_DIR, "relationship-zhu");
check("loadSkill returns SKILL.md content", typeof skillContent === "string" && skillContent.includes("南方科技大学"));

// ---- AI configuration ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notionish-ai-cfg-"));
const cfgPath = path.join(tmpDir, "ai-config.json");
const defaults = ai.loadAIConfig(cfgPath);
check("loadAIConfig returns defaults when missing", defaults.ollamaUrl && defaults.embedModel && defaults.openaiModel && defaults.openaiApiKey === "");
const saved = ai.saveAIConfig({ openaiApiKey: "sk-secret-123", embedModel: "nomic-embed-text" }, cfgPath);
check("saveAIConfig persists key", fs.existsSync(cfgPath) && saved.openaiApiKey === "sk-secret-123");
const pub = ai.publicConfig(ai.loadAIConfig(cfgPath));
check("publicConfig never exposes API key", pub.openaiApiKey === undefined && pub.configured === true && pub.embedModel === "nomic-embed-text");

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "notionish-ai2-"));
const filePath2 = path.join(tmpDir2, "ai-index.json");
const store = ai.createIndexStore({ filePath: filePath2, maxLen: 300 });

const embed = async (texts) => texts.map((t, i) => [1, i % 5]);

(async () => {
  const r1 = await store.upsert([
    { pageId: "pg1", blockId: "b1", pageTitle: "数学", text: "勾股定理" },
    { pageId: "pg1", blockId: "b2", pageTitle: "数学", text: "质能方程" },
  ], embed);
  check("index upsert adds chunks", r1.added === 2 && store.size() === 2);

  const top = store.retrieve([1, 1], 2);
  check("index retrieve returns top-k with scores", top.length === 2 && top[0].score >= top[1].score && top[0].chunk.pageId === "pg1");

  const r2 = await store.upsert([{ pageId: "pg1", blockId: "b1", pageTitle: "数学", text: "勾股定理" }], embed);
  check("index upsert skips unchanged content", r2.skipped === 1 && r2.updated === 0 && r2.added === 0 && store.size() === 2);

  const r3 = await store.upsert([{ pageId: "pg1", blockId: "b1", pageTitle: "数学", text: "勾股定理的推广" }], embed);
  check("index upsert updates changed content", r3.updated === 1 && store.size() === 2);

  const removed = store.deleteBlock("b2");
  check("index deleteBlock removes its chunks", removed === 1 && store.size() === 1);

  await store.upsert([{ pageId: "pg2", blockId: "b3", pageTitle: "物理", text: "牛顿定律" }], embed);
  const removedPage = store.deletePage("pg1");
  check("index deletePage removes all chunks of a page", removedPage === 1 && store.size() === 1);

  store.persist();
  check("index persists to file", fs.existsSync(filePath2));

  const store2 = ai.createIndexStore({ filePath: filePath2, maxLen: 300 });
  store2.load();
  check("index loads from file", store2.size() === 1);
  const top2 = store2.retrieve([1, 1], 1);
  check("loaded index still retrieves", top2.length === 1 && top2[0].chunk.pageId === "pg2");

  const prompt = ai.buildPrompt("什么是勾股定理", top2.map(t => t.chunk));
  check("buildPrompt embeds context and query", prompt.includes("什么是勾股定理") && prompt.includes("牛顿定律"));

  const aiSrc = fs.readFileSync(path.join(__dirname, "server-ai.js"), "utf8");
  check("streamChat uses UTF-8 safe StringDecoder", aiSrc.includes("StringDecoder") && aiSrc.includes("sdec.write(chunk)") && aiSrc.includes("sdec.end()"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpDir2, { recursive: true, force: true });

  const fails = results.filter(r => !r.pass);
  console.log(results.map(r => (r.pass ? "PASS" : "FAIL") + "  " + r.name).join("\n"));
  console.log("\n" + results.length + " checks, " + fails.length + " failed");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
