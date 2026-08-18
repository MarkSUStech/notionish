// Headless smoke test for Notionish core logic
const fs = require("fs");
const path = require("path");
const base = __dirname;

const noop = () => { throw new Error("DOM not available in headless test"); };
const stubDoc = {
  createElement: noop, getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], addEventListener: () => {}, body: {},
  documentElement: { setAttribute() {} },
};
const fakeLS = (() => { let m = {}; return {
  getItem: (k) => (k in m ? m[k] : null),
  setItem: (k, v) => { m[k] = String(v); },
  removeItem: (k) => { delete m[k]; },
  clear: () => { m = {}; },
}; })();

global.window = global; // modules assign to window.X; make it the global object
global.document = stubDoc;
global.localStorage = fakeLS;
global.location = { hash: "", origin: "http://localhost", pathname: "/" };
global.navigator = { clipboard: null };
global.confirm = () => true;
global.prompt = () => null;
global.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} });

function load(file) { eval(fs.readFileSync(path.join(base, "js", file), "utf8")); }
load("util.js"); load("math.js"); load("mermaid.js"); load("theme.js"); load("store.js"); load("blocks.js"); load("editor.js"); load("sidebar.js"); load("ide.js"); load("bridge.js"); load("pdf.js"); load("ai.js"); load("settings.js"); load("question-bank.js");

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

(async () => {
  await Store.boot();
  const pages = Store.state.pages;
  check("boot seeds 12 pages (6 + 6 rows)", Object.keys(pages).length === 12);
const welcome = Store.getRootPages().find(p => p.children.length > 0);
check("welcome page has blocks", welcome && welcome.children.length >= 5);
const tasks = Store.getRootPages().find(p => p.database);
check("tasks db exists", !!tasks);
const rows = Store.getChildren(tasks.id);
check("tasks has 6 rows", rows.length === 6);
const statusProp = tasks.schema.props.find(p => p.name === "状态");
check("row props keyed by schema id", rows[0].props[statusProp.id] === "已完成");
const numProp = tasks.schema.props.find(p => p.type === "number");
check("row number prop", rows[2].props[numProp.id] === 65);

const segs = [{ t: "hello ", b: 1 }, { t: "world", i: 1, c: 1 }, { t: " end", color: "#d9730d" }];
const html = Blocks.segsToHTML(segs);
check("segsToHTML bold", html.includes("<b>hello </b>"));
check("segsToHTML italic+code", html.includes("<i><code>world</code></i>"));
check("segsToHTML color", html.includes('style="color:#d9730d"'));

const sliced = Blocks.sliceSegments([{ t: "abcdef", b: 1 }], 2, 4);
check("sliceSegments", sliced.length === 1 && sliced[0].t === "cd" && sliced[0].b === 1);
const multi = Blocks.sliceSegments([{ t: "ab" }, { t: "cde", i: 1 }], 1, 4);
check("sliceSegments multi", multi.map(s => s.t).join("") === "bcd" && multi[1].i === 1);

const pg = welcome;
const first = pg.children[0];
const pos = Store.findBlockPos(pg, first.id);
check("findBlockPos top-level", pos && pos.parent === null && pos.index === 0);
const nb = Store.newBlock("heading2", "测试标题");
Store.insertBlock(pg, nb, 1);
check("insertBlock", pg.children[1].id === nb.id);
Store.removeBlock(pg, nb.id);
check("removeBlock", !pg.children.some(b => b.id === nb.id));

const toggle = Store.newBlock("toggle", "折叠");
Store.insertBlock(pg, toggle);
const childA = Store.newBlock("bullet", "子项 A");
const childB = Store.newBlock("bullet", "子项 B");
toggle.children.push(childA, childB);
check("findBlock nested", Store.findBlock(pg, childB.id) === childB);
const cpos = Store.findBlockPos(pg, childB.id);
check("findBlockPos nested", cpos && cpos.parent === toggle && cpos.index === 1);
check("prevBlock nested", Store.prevBlock(pg, childB.id) === childA);
check("nextBlock after nested", Store.nextBlock(pg, childB.id) === null);

const t2 = Store.newBlock("toggle", "目标折叠");
Store.insertBlock(pg, t2);
const para = Store.newBlock("paragraph", "要移动的段落");
Store.insertBlock(pg, para);
Store.moveBlock(pg, para.id, t2.id, "inside");
check("moveBlock inside toggle", t2.children.some(b => b.id === para.id));

const pa = Store.createPage("root", { title: "AA" });
const pb = Store.createPage("root", { title: "BB" });
Store.reorderPage(pa.id, pb.id, "before", false);
const rootOrder = Store.getChildren("root").map(p => p.id);
check("reorder before", rootOrder.indexOf(pa.id) < rootOrder.indexOf(pb.id));

const copy = Store.duplicatePage(pg.id);
check("duplicate page", !!copy && copy.id !== pg.id);
check("duplicate children deep-copied", copy.children.length === pg.children.length);
check("duplicate page remaps block ids", copy.children.length && copy.children.every((b, i) => b.id !== pg.children[i].id));

Store.deletePage(pg.id, false);
check("page trashed", Store.getPage(pg.id).deleted === true);
check("trash list", Store.getTrashPages().some(p => p.id === pg.id));
Store.setPageDeleted(pg.id, false);
check("page restored", Store.getPage(pg.id).deleted === false);

const hits = Store.search("编辑器");
check("search finds block text (table cell)", hits.some(h => h.type === "block" && h.loc.includes("块编辑器")));
const hits2 = Store.search("看板");
check("search finds db row title", hits2.some(h => h.page.database || h.title.includes("看板")));

const row = Store.createRow(tasks, "测试记录");
Store.setPropValue(tasks, row, statusProp, "进行中");
check("createRow + setProp", Store.propValue(tasks, row, statusProp) === "进行中");

const json = Store.exportJSON();
const parsed = JSON.parse(json);
check("export parses", parsed.pages && Object.keys(parsed.pages).length > 0);
try {
  const imp = Store.importJSON(json);
  check("import merges", imp.added >= 0);
} catch (e) {
  check("import merges", false);
}

// breadcrumb for a nested page
const nested = Store.createPage(welcome.id, { title: "子页面" });
const chain = Store.breadcrumb(nested.id);
check("breadcrumb chain", chain.length === 2 && chain[chain.length - 1].id === nested.id);

// --- regressions: history, hierarchy, purge, import, sidebar state ---
Store.commitHistory();
const undoBefore = Object.keys(Store.state.pages).length;
Store.createPage("root", { title: "撤销测试" });
check("first undo restores previous state", Store.undo() && Object.keys(Store.state.pages).length === undoBefore);

const cycleParent = Store.createPage("root", { title: "循环父页" });
const cycleChild = Store.createPage(cycleParent.id, { title: "循环子页" });
check("movePage rejects descendant target", Store.movePage(cycleParent.id, cycleChild.id) === false && cycleParent.parentId === "root");
check("reorderPage rejects descendant target", Store.reorderPage(cycleParent.id, cycleChild.id, "after", false) === false && cycleParent.parentId === "root");

const purgeParent = Store.createPage("root", { title: "彻删父页" });
const purgeChild = Store.createPage(purgeParent.id, { title: "彻删子页" });
Store.deletePage(purgeParent.id, false);
Store.deletePage(purgeParent.id, true);
check("permanent delete removes trashed descendants", !Store.getPage(purgeParent.id) && !Store.getPage(purgeChild.id));

const importPayload = JSON.stringify({ pages: {
  imported: {
    id: "imported", parentId: "root", title: [{ t: "导入页" }],
    icon: '<img src=x onerror=alert(1)>', cover: "javascript:alert(1)",
    database: false, children: [{ id: "bad", type: "paragraph", text: [{ t: "安全", link: "javascript:alert(1)", color: "red;position:fixed" }], attrs: {} }],
    props: {}, createdAt: 1, updatedAt: 1, deleted: false,
  }
} });
Store.importJSON(importPayload);
const imported = Store.getPage("imported");
check("import strips unsafe icon and cover", imported.icon === null && imported.cover === null);
check("import strips unsafe rich text fields", imported.children[0].text[0].link == null && imported.children[0].text[0].color == null);

Sidebar.expanded = new Set();
check("sidebar empty expansion set means collapsed", Sidebar.isExpanded("missing") === false);
Sidebar.expanded.add("page");
check("sidebar explicit expansion works", Sidebar.isExpanded("page") === true);

// --- drag blocks into columns ---
const colPage = Store.createPage("root", { title: "分栏测试" });
const colA = Store.newBlock("paragraph", "A");
const colB = Store.newBlock("paragraph", "B");
colPage.children.push(colA, colB);
check("side drop creates two columns", Store.moveBlockToSide(colPage, colB.id, colA.id, "right") === true && colPage.children.length === 1 && colPage.children[0].type === "columns");
const columns = colPage.children[0];
check("new columns preserve left-right order", columns.children.length === 2 && columns.children[0].children[0].id === colA.id && columns.children[1].children[0].id === colB.id);
const colC = Store.newBlock("paragraph", "C");
colPage.children.push(colC);
check("side drop adds a third column", Store.moveBlockToSide(colPage, colC.id, colB.id, "right") === true && columns.children.length === 3 && columns.children[2].children[0].id === colC.id);
const colD = Store.newBlock("paragraph", "D");
colPage.children.push(colD);
Store.moveBlockToSide(colPage, colD.id, colC.id, "right");
const colE = Store.newBlock("paragraph", "E");
colPage.children.push(colE);
check("four-column cap appends to edge column", Store.moveBlockToSide(colPage, colE.id, colD.id, "right") === true && columns.children.length === 4 && columns.children[3].children.map(b => b.id).includes(colE.id));
check("side drop rejects self target", Store.moveBlockToSide(colPage, colA.id, colA.id, "left") === false);
const hitRect = { left: 100, right: 300, width: 200 };
check("column hit testing detects left edge", Editor.columnDropSide(hitRect, 120) === "left");
check("column hit testing detects right edge", Editor.columnDropSide(hitRect, 280) === "right");
check("column hit testing preserves center sorting", Editor.columnDropSide(hitRect, 200) === null);

// --- empty columns collapse after dragging blocks out ---
const collapsePage = Store.createPage("root", { title: "收缩分栏测试" });
const collapseA = Store.newBlock("paragraph", "左栏");
const collapseB = Store.newBlock("paragraph", "右栏");
collapsePage.children.push(collapseA, collapseB);
Store.moveBlockToSide(collapsePage, collapseB.id, collapseA.id, "right");
const collapseColumns = collapsePage.children[0];
Store.moveBlock(collapsePage, collapseB.id, null, "after");
check("two columns unwrap after last block leaves a column", collapsePage.children.length === 2 && collapsePage.children[0].id === collapseA.id && collapsePage.children[1].id === collapseB.id);

const shrinkPage = Store.createPage("root", { title: "三栏收缩测试" });
const shrinkA = Store.newBlock("paragraph", "A");
const shrinkB = Store.newBlock("paragraph", "B");
const shrinkC = Store.newBlock("paragraph", "C");
shrinkPage.children.push(shrinkA, shrinkB, shrinkC);
Store.moveBlockToSide(shrinkPage, shrinkB.id, shrinkA.id, "right");
Store.moveBlockToSide(shrinkPage, shrinkC.id, shrinkB.id, "right");
const shrinkColumns = shrinkPage.children[0];
Store.moveBlock(shrinkPage, shrinkC.id, null, "after");
check("three columns shrink to two when one becomes empty", shrinkPage.children[0] === shrinkColumns && shrinkColumns.children.length === 2 && shrinkPage.children[1].id === shrinkC.id);

// --- inline selection toolbar eligibility ---
const editorRoot = { contains: () => true };
const sameEditor = { closest: (selector) => selector === ".ed" ? sameEditor : null };
const otherEditor = { closest: (selector) => selector === ".ed" ? otherEditor : null };
const sameTextNode = { nodeType: 3, parentElement: sameEditor };
const otherTextNode = { nodeType: 3, parentElement: otherEditor };
const sameRange = { commonAncestorContainer: sameTextNode, startContainer: sameTextNode, endContainer: sameTextNode };
const otherRange = { commonAncestorContainer: sameTextNode, startContainer: sameTextNode, endContainer: otherTextNode };
check("inline toolbar accepts nonempty text in one editor", Editor.inlineSelectionEditor({ rangeCount: 1, isCollapsed: false, getRangeAt: () => sameRange }, editorRoot) === sameEditor);
check("inline toolbar rejects collapsed selection", Editor.inlineSelectionEditor({ rangeCount: 1, isCollapsed: true, getRangeAt: () => sameRange }, editorRoot) === null);
check("inline toolbar rejects cross-block selection", Editor.inlineSelectionEditor({ rangeCount: 1, isCollapsed: false, getRangeAt: () => otherRange }, editorRoot) === null);

// --- code file model + project collection ---
const codePage = Store.createPage("root", { code: true, language: "python", title: "app" });
Store.setCodeSource(codePage.id, "print('hi')");
check("code page created with language and source", codePage.code === true && codePage.codeData.language === "python" && codePage.codeData.source === "print('hi')");
const codeChildPy = Store.createPage(codePage.id, { code: true, language: "python", title: "util" });
const codeChildCpp = Store.createPage(codePage.id, { code: true, language: "cpp", title: "helper" });
const project = Store.collectCodeProject(codePage.id);
check("project collection includes entry and children", project && project.language === "python" && project.files.length === 3);
check("project collection derives extensions", project.files.some(f => f.path === "app.py" && f.isEntry) && project.files.some(f => f.path === "util.py") && project.files.some(f => f.path === "helper.cpp"));
check("project collection returns null for non-code page", Store.collectCodeProject("root") === null);

// --- IDE: syntax highlight + file tree ---
const pyHighlight = IDE.highlight('def f():\n    return 1', "python");
check("highlight python keywords and numbers", pyHighlight.includes('class="tok-keyword">def') && pyHighlight.includes('class="tok-keyword">return') && pyHighlight.includes('class="tok-number">1'));
const cppHighlight = IDE.highlight('int main(){ return 0; }', "cpp");
check("highlight cpp keywords and numbers", cppHighlight.includes('class="tok-keyword">int') && cppHighlight.includes('class="tok-number">0'));
const strHighlight = IDE.highlight('print("hi") # c', "python");
check("highlight string and comment", strHighlight.includes('class="tok-string">&quot;hi&quot;') === false && strHighlight.includes('class="tok-string">') && strHighlight.includes('class="tok-comment"># c'));
check("highlight escapes HTML", IDE.highlight("<x>", "python").includes("&lt;x&gt;") && !IDE.highlight("<x>", "python").includes("<x>"));
const ideTree = IDE.fileTree(codePage);
check("ide file tree nests code files", ideTree.length === 1 && ideTree[0].children.length === 2 && ideTree[0].children.some(c => c.pageId === codeChildPy.id));

// --- IDE automatic pairing and indentation ---
const paired = IDE.applyCodeEdit("foo", 3, 3, "(", "python");
check("code editor auto-pairs opening delimiters", paired.value === "foo()" && paired.start === 4 && paired.end === 4);
const wrapped = IDE.applyCodeEdit("abc", 1, 2, "[", "python");
check("code editor wraps selected text", wrapped.value === "a[b]c" && wrapped.start === 2 && wrapped.end === 3);
const skipped = IDE.applyCodeEdit("()", 1, 1, ")", "python");
check("code editor skips existing closing delimiter", skipped.value === "()" && skipped.start === 2 && skipped.end === 2);
const deletedPair = IDE.applyCodeEdit("()", 1, 1, "Backspace", "python");
check("code editor deletes empty paired delimiters", deletedPair.value === "" && deletedPair.start === 0 && deletedPair.end === 0);
const braceIndent = IDE.applyCodeEdit("{}", 1, 1, "Enter", "cpp");
check("code editor expands braces with indentation", braceIndent.value === "{\n    \n}" && braceIndent.start === 6 && braceIndent.end === 6);
const pythonIndent = IDE.applyCodeEdit("if x:", 5, 5, "Enter", "python");
check("code editor indents Python colon lines", pythonIndent.value === "if x:\n    " && pythonIndent.start === 10 && pythonIndent.end === 10);

// --- snippet block linked to a code file ---
const snippetPage = Store.createPage("root", { title: "片段笔记" });
const snip = Store.newBlock("snippet");
snip.attrs = { source: "print(1)", language: "python", pageId: codePage.id };
snippetPage.children.push(snip);
const snippetJson = Store.exportJSON();
Store.importJSON(snippetJson);
const importedSnip = Store.getPage(snippetPage.id).children[0];
check("snippet block survives import with link", importedSnip.type === "snippet" && importedSnip.attrs.source === "print(1)" && importedSnip.attrs.language === "python" && importedSnip.attrs.pageId === codePage.id);

// --- mermaid block + table mutations ---
const mmPage = Store.createPage("root", { title: "图表笔记" });
const mm = Store.newBlock("mermaid");
mm.attrs = { source: "graph TD; A-->B" };
mmPage.children.push(mm);
const mmJson = Store.exportJSON();
Store.importJSON(mmJson);
const importedMm = Store.getPage(mmPage.id).children[0];
check("mermaid block survives import with source", importedMm.type === "mermaid" && importedMm.attrs.source === "graph TD; A-->B");

const rowA = [[{ t: "a" }]], rowB = [[{ t: "b" }]];
const tmAddRow = Store.tableMutate([rowA, rowB], 1, "addRow");
check("table addRow appends a row", tmAddRow.rows.length === 3 && tmAddRow.rows[2][0][0].t === "");
const tmAddCol = Store.tableMutate([rowA], 1, "addCol");
check("table addCol appends a column", tmAddCol.cols === 2 && tmAddCol.rows[0].length === 2 && tmAddCol.rows[0][1][0].t === "");
const tmDelRow = Store.tableMutate([rowA, rowB], 1, "delRow", 0);
check("table delRow removes index", tmDelRow.rows.length === 1 && tmDelRow.rows[0][0][0].t === "b");
const tmDelCol = Store.tableMutate([[[{ t: "a" }], [{ t: "b" }]]], 2, "delCol", 0);
check("table delCol removes index", tmDelCol.cols === 1 && tmDelCol.rows[0][0][0].t === "b");
const tmKeep = Store.tableMutate([rowA], 1, "delRow");
check("table delRow keeps at least one row", tmKeep.rows.length === 1);

// --- theme merge ---
check("theme deepMerge overrides scalars", JSON.stringify(Theme.deepMerge({ a: 1, b: 2 }, { a: 9 })) === JSON.stringify({ a: 9, b: 2 }));
check("theme deepMerge merges nested modes", JSON.stringify(Theme.deepMerge({ light: { bg: "#fff" }, dark: {} }, { light: { accent: "#f00" } })) === JSON.stringify({ light: { bg: "#fff", accent: "#f00" }, dark: {} }));
check("theme deepMerge keeps base without override", Theme.deepMerge({ x: 1 }, null).x === 1);

// --- question & flashcard central storage ---
const quizPage = Store.createPage("root", { title: "题库" });
const qBlock = Store.newBlock("question");
quizPage.children.push(qBlock);
const q1 = Store.createQuestion(quizPage.id, qBlock.id, { type: "single", prompt: "1+1=?", options: ["1", "2", "3"], answer: 1, explanation: "等于2" });
check("question stored centrally and referenced by block", q1.id === qBlock.attrs.qid && Store.getQuestion(q1.id) && Store.getQuestion(q1.id).prompt === "1+1=?");
check("getQuestions lists stored questions", Store.getQuestions().length === 1);
Store.updateQuestion(q1.id, { prompt: "2+2=?", answer: 2 });
check("updateQuestion merges fields", Store.getQuestion(q1.id).prompt === "2+2=?" && Store.getQuestion(q1.id).answer === 2 && Store.getQuestion(q1.id).explanation === "等于2");
const fBlock = Store.newBlock("flashcard");
quizPage.children.push(fBlock);
const f1 = Store.createFlashcard(quizPage.id, fBlock.id, { front: "单词", back: "word" });
check("flashcard stored centrally and referenced by block", f1.id === fBlock.attrs.fid && Store.getFlashcard(f1.id).front === "单词");
const quizJson = Store.exportJSON();
Store.importJSON(quizJson);
check("questions survive export/import", Store.getQuestion(q1.id) && Store.getQuestion(q1.id).prompt === "2+2=?");
check("flashcards survive export/import", Store.getFlashcard(f1.id) && Store.getFlashcard(f1.id).front === "单词");
Store.removeBlock(quizPage, qBlock.id);
check("removing question block preserves central entry", !!Store.getQuestion(q1.id));

const answerQuestionBlock = Store.newBlock("question");
quizPage.children.push(answerQuestionBlock);
const answerQuestion = Store.createQuestion(quizPage.id, answerQuestionBlock.id, { type: "short_answer", prompt: "说明 localStorage 的用途", answer: "本地持久化" });
check("short answer questions are stored as a supported type", Store.getQuestion(answerQuestion.id).type === "short_answer");
const entityJson = Store.exportJSON();
Store.importJSON(entityJson);
check("question entity data remains after import", Store.getQuestion(answerQuestion.id).answer === "本地持久化");

// AI 生成题目/闪卡时应把块插入当前页面（不能只写中央存储）
const aiqPage = Store.createPage("root", { title: "AI 出题页" });
const aiq = typeof Store.createQuestionBlock === "function" ? Store.createQuestionBlock(aiqPage.id, { type: "single", prompt: "1+1=?", options: ["1", "2"], answer: 1 }) : null;
check("createQuestionBlock inserts question block linked by qid", !!aiq && aiq.block.type === "question" && aiq.block.attrs.qid === aiq.question.id && aiqPage.children.some(b => b.id === aiq.block.id));
const aif = typeof Store.createFlashcardBlock === "function" ? Store.createFlashcardBlock(aiqPage.id, { front: "正", back: "背" }) : null;
check("createFlashcardBlock inserts flashcard block linked by fid", !!aif && aif.block.type === "flashcard" && aif.block.attrs.fid === aif.flashcard.id && aiqPage.children.some(b => b.id === aif.block.id));
check("createQuestionBlock returns null for missing page", typeof Store.createQuestionBlock === "function" && Store.createQuestionBlock("no-such-page", {}) === null);

// 题目 LaTeX 渲染 + 答案默认隐藏
const qBlocksSrc = fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8");
check("question renders LaTeX in prompt and options", qBlocksSrc.includes("qTextHTML") && qBlocksSrc.includes('"q-prompt"') && qBlocksSrc.includes('"q-opt"'));
check("question hides answer until user reveals", qBlocksSrc.includes("q-reveal") && qBlocksSrc.includes('"revealed"'));
const qCss = fs.readFileSync(path.join(base, "css", "styles.css"), "utf8");
check("question answer hidden by default via CSS", qCss.includes(".b-question:not(.revealed)"));

const pq = Editor.parseQuestionForm("single", "A\nB\nC", "2");
check("parse single question form", pq.options.length === 3 && pq.answer === 1);
const pm = Editor.parseQuestionForm("multiple", "A\nB\nC", "1,3");
check("parse multiple question form", Array.isArray(pm.answer) && pm.answer.length === 2 && pm.answer[0] === 0 && pm.answer[1] === 2);
const pj = Editor.parseQuestionForm("judge", "", "对");
check("parse judge question form", pj.answer === true);
const pf = Editor.parseQuestionForm("fill", "", "42 | 四十二");
check("parse fill question form", Array.isArray(pf.answer) && pf.answer.length === 2);

// --- LaTeX / math ---
const mathHtml = Blocks.segsToHTML([{ t: "", math: "E=mc^2" }]);
check("segsToHTML math span", mathHtml.includes('class="nt-math"') && mathHtml.includes('data-math="E=mc^2"'));
const fallback = MathR.renderInline("\\frac{1}{2}");
check("fallback renderer fraction", fallback.includes("eq-frac") && fallback.includes("eq-num"));
const fb2 = MathR.renderInline("\\sum_{i=1}^{n} i^2");
check("fallback sum + sup", fb2.includes("∑") && fb2.includes("<sup>2</sup>"));
const m1 = Blocks.sliceSegments([{ t: "", math: "x" }, { t: "abc" }], 0);
check("slice math at boundary stays", m1.length === 2 && m1[0].math === "x");
const m2 = Blocks.sliceSegments([{ t: "", math: "x" }, { t: "abc" }], 0, 0);
check("slice empty left keeps no math", m2.length === 0);
const m3 = Blocks.sliceSegments([{ t: "ab" }, { t: "", math: "x" }, { t: "cd" }], 0, 3);
check("slice keeps math mid", m3.some(s => s.math === "x"));
const m3b = Blocks.sliceSegments([{ t: "ab" }, { t: "", math: "x" }, { t: "cd" }], 0, 2);
check("slice boundary math goes right", !m3b.some(s => s.math === "x"));
const m4 = Blocks.sliceSegments([{ t: "ab" }, { t: "", math: "x" }, { t: "cd" }], 2);
check("slice right of math keeps it", m4.some(s => s.math === "x") && m4.map(s => s.t).join("") === "cd");

// --- AI MCP browser bridge execution layer ---
check("bridge rejects unknown tool", Bridge.run({ tool: "no_such_tool", args: {} }).ok === false);

const bridgePage = Store.createPage("root", { title: "AI 桥接页" });
const bridgePageList = Bridge.execute("page.list", {});
check("bridge lists pages", bridgePageList.ok && bridgePageList.result.some(p => p.id === bridgePage.id));
const bridgePageGet = Bridge.execute("page.get", { id: bridgePage.id });
check("bridge gets page details", bridgePageGet.ok && bridgePageGet.result.id === bridgePage.id);
const bridgeBlock = Bridge.execute("block.create", { pageId: bridgePage.id, type: "paragraph", text: "AI 写入内容" });
check("bridge creates a page block", bridgeBlock.ok && Store.findBlock(bridgePage, bridgeBlock.result.id) !== null);
const bridgeBlockUpdate = Bridge.execute("block.update", { pageId: bridgePage.id, blockId: bridgeBlock.result.id, text: "AI 已更新" });
check("bridge updates a page block", bridgeBlockUpdate.ok && U.segsText(Store.findBlock(bridgePage, bridgeBlock.result.id).text) === "AI 已更新");
const bridgeBlocks = Bridge.execute("block.list", { pageId: bridgePage.id });
check("bridge lists page blocks", bridgeBlocks.ok && bridgeBlocks.result.some(b => b.id === bridgeBlock.result.id));
const bridgeComment = Bridge.execute("block_comment.create", { pageId: bridgePage.id, blockId: bridgeBlock.result.id, text: "AI 评论" });
check("bridge creates block comment", bridgeComment.ok && Store.findBlock(bridgePage, bridgeBlock.result.id).comments.length === 1);
const bridgeCommentList = Bridge.execute("block_comment.list", { pageId: bridgePage.id, blockId: bridgeBlock.result.id });
check("bridge lists block comments", bridgeCommentList.ok && bridgeCommentList.result[0].id === bridgeComment.result.id);
const bridgeCommentDelete = Bridge.execute("block_comment.delete", { pageId: bridgePage.id, blockId: bridgeBlock.result.id, commentId: bridgeComment.result.id });
check("bridge deletes block comment", bridgeCommentDelete.ok && Store.findBlock(bridgePage, bridgeBlock.result.id).comments.length === 0);
const bridgeBlockDelete = Bridge.execute("block.delete", { pageId: bridgePage.id, blockId: bridgeBlock.result.id });
check("bridge deletes a page block", bridgeBlockDelete.ok && Store.findBlock(bridgePage, bridgeBlock.result.id) === null);

const bridgeNewPage = Bridge.execute("page.create", { title: "AI 新建页面", icon: "🤖" });
check("bridge creates page", bridgeNewPage.ok && Store.getPage(bridgeNewPage.result.id) !== null);
const bridgePageUpdate = Bridge.execute("page.update", { id: bridgeNewPage.result.id, favorite: true, title: "AI 已改名" });
check("bridge updates page", bridgePageUpdate.ok && Store.getPage(bridgeNewPage.result.id).favorite === true && U.segsText(Store.getPage(bridgeNewPage.result.id).title) === "AI 已改名");
const bridgePageMove = Bridge.execute("page.move", { id: bridgeNewPage.result.id, parentId: bridgePage.id });
check("bridge moves page", bridgePageMove.ok && Store.getPage(bridgeNewPage.result.id).parentId === bridgePage.id);

const bridgeQuestion = Bridge.execute("question.create", { type: "short_answer", prompt: "桥接题目", answer: "桥接答案" });
check("bridge creates question entity", bridgeQuestion.ok && Store.getQuestion(bridgeQuestion.result.id).type === "short_answer");
const bridgeQuestionUpdate = Bridge.execute("question.update", { id: bridgeQuestion.result.id, prompt: "桥接题目已更新" });
check("bridge updates question entity", bridgeQuestionUpdate.ok && Store.getQuestion(bridgeQuestion.result.id).prompt === "桥接题目已更新");
const bridgeQuestionDelete = Bridge.execute("question.delete", { id: bridgeQuestion.result.id });
check("bridge deletes question entity", bridgeQuestionDelete.ok && Store.getQuestion(bridgeQuestion.result.id) === null);

const bridgeFlashcard = Bridge.execute("flashcard.create", { front: "桥接正面", back: "桥接背面" });
check("bridge creates flashcard entity", bridgeFlashcard.ok && Store.getFlashcard(bridgeFlashcard.result.id).front === "桥接正面");
const bridgeFlashcardUpdate = Bridge.execute("flashcard.update", { id: bridgeFlashcard.result.id, back: "桥接新背面" });
check("bridge updates flashcard entity", bridgeFlashcardUpdate.ok && Store.getFlashcard(bridgeFlashcard.result.id).back === "桥接新背面");
const bridgeFlashcardDelete = Bridge.execute("flashcard.delete", { id: bridgeFlashcard.result.id });
check("bridge deletes flashcard entity", bridgeFlashcardDelete.ok && Store.getFlashcard(bridgeFlashcard.result.id) === null);

const bridgeDb = Store.getRootPages().find(p => p.database);
const bridgeSchema = Bridge.execute("database_schema.get", { databaseId: bridgeDb.id });
check("bridge gets database schema", bridgeSchema.ok && bridgeSchema.result.props.length === bridgeDb.schema.props.length);
const bridgeSchemaUpdate = Bridge.execute("database_schema.update", { databaseId: bridgeDb.id, viewState: { view: "list", filter: { rules: [] }, sort: { rules: [] } } });
check("bridge updates database view state", bridgeSchemaUpdate.ok && bridgeDb.viewState.view === "list");
const bridgeRow = Bridge.execute("database_row.create", { databaseId: bridgeDb.id, title: "AI 数据库行" });
check("bridge creates database row", bridgeRow.ok && Store.getPage(bridgeRow.result.id) !== null);
const bridgeStatusProp = bridgeDb.schema.props.find(p => p.name === "状态");
const bridgeRowUpdate = Bridge.execute("database_row.update", { databaseId: bridgeDb.id, rowId: bridgeRow.result.id, props: { [bridgeStatusProp.id]: "进行中" } });
check("bridge updates database row", bridgeRowUpdate.ok && Store.getPage(bridgeRow.result.id).props[bridgeStatusProp.id] === "进行中");
const bridgeRowDelete = Bridge.execute("database_row.delete", { databaseId: bridgeDb.id, rowId: bridgeRow.result.id });
check("bridge deletes database row", bridgeRowDelete.ok && Store.getPage(bridgeRow.result.id) === null);

const bridgeTemplate = Bridge.execute("template.create", { name: "AI 模板", data: { icon: "🤖", children: [] } });
check("bridge creates template", bridgeTemplate.ok && Store.getTemplates().some(t => t.id === bridgeTemplate.result.id));
const bridgeTemplateDelete = Bridge.execute("template.delete", { id: bridgeTemplate.result.id });
check("bridge deletes template", bridgeTemplateDelete.ok && !Store.getTemplates().some(t => t.id === bridgeTemplate.result.id));

const bridgeReminder = Bridge.execute("reminder.create", { at: Date.now() + 60000, title: "AI 提醒", pageId: bridgePage.id });
check("bridge creates reminder", bridgeReminder.ok && Store.getReminders().some(r => r.id === bridgeReminder.result.id));
const bridgeReminderComplete = Bridge.execute("reminder.complete", { id: bridgeReminder.result.id, done: true });
check("bridge completes reminder", bridgeReminderComplete.ok && Store.getReminders().find(r => r.id === bridgeReminder.result.id).done === true);
const bridgeReminderDelete = Bridge.execute("reminder.delete", { id: bridgeReminder.result.id });
check("bridge deletes reminder", bridgeReminderDelete.ok && !Store.getReminders().some(r => r.id === bridgeReminder.result.id));

const bridgeTheme = Bridge.execute("workspace.update_theme", { theme: "dark" });
check("bridge updates workspace theme", bridgeTheme.ok && Store.state.settings.theme === "dark");
Bridge.execute("workspace.update_theme", { theme: "light" });

const stylesheet = fs.readFileSync(path.join(base, "css", "styles.css"), "utf8");
check("topbar breadcrumb can shrink beside AI status", /#breadcrumbs\{[^}]*min-width:\s*0/.test(stylesheet));
check("topbar controls keep stable flex sizing", /#topbar-actions\{[^}]*flex:\s*0\s+0\s+auto/.test(stylesheet) && /\.ai-bridge-status\{[^}]*flex:\s*0\s+0\s+auto/.test(stylesheet));
check("base CSS section comment closes before global rules", stylesheet.includes("/* ============ Reset / Base ============ */\n*, *::before"));

// --- AI assistant pure helpers ---
check("AI djb2 is deterministic", AI.djb2("hello") === AI.djb2("hello") && AI.djb2("hello") !== AI.djb2("hellp"));
check("AI buildSignature differs by text", AI.buildSignature("p1", "a") !== AI.buildSignature("p1", "b"));
const aiState = {
  pages: { p1: { id: "p1", title: [{ t: "页" }], deleted: false, children: [{ id: "b1", text: [{ t: "块" }], children: [] }] } },
  questions: { q1: { id: "q1", prompt: "题", options: ["A"], answer: 0 } },
  flashcards: { f1: { id: "f1", front: "正", back: "背" } },
};
const aiItems = AI.collectIndexItems(aiState);
check("AI collect includes question entity", aiItems.items.some(i => i.blockId === "question:q1"));
check("AI collect includes flashcard entity", aiItems.items.some(i => i.blockId === "flashcard:f1"));
check("AI collect includes page blocks", aiItems.items.some(i => i.blockId === "b1" && i.pageId === "p1"));
check("AI collect signatures map matches items", aiItems.signatures.size === aiItems.items.length && aiItems.items.length === 3);
const sse = AI.parseSSEChunk('data: {"type":"meta","citations":[]}\n\ndata: {"type":"delta","text":"hi"}\n\ndata: {"type":"done"}\n\n');
check("AI parseSSEChunk parses complete frames", sse.events.length === 3 && sse.events[1].text === "hi" && sse.rest === "");
const sseRest = AI.parseSSEChunk('data: {"type":"delta","text":"par');
check("AI parseSSEChunk leaves partial frame as rest", sseRest.events.length === 0 && sseRest.rest.includes("par"));

// --- AI structured generation helpers ---
const jsonArr = AI.extractJSON('好的，题目如下：\n```json\n[{"type":"single","prompt":"Q","answer":0}]');
check("AI extractJSON parses array from fenced text", Array.isArray(jsonArr) && jsonArr[0].type === "single");
const jsonObj = AI.extractJSON('结果: {"a":[1,2],"b":{"c":3}} 尾部说明');
check("AI extractJSON parses nested object", jsonObj && jsonObj.a.length === 2 && jsonObj.b.c === 3);
check("AI extractJSON returns null on non-json", AI.extractJSON("这里没有 json") === null);
const qPrompt = AI.buildQuestionsPrompt("勾股定理内容", 3);
check("AI buildQuestionsPrompt embeds content and count", qPrompt.includes("勾股定理内容") && qPrompt.includes("3"));
const fPrompt = AI.buildFlashcardsPrompt("牛顿定律内容", 5);
check("AI buildFlashcardsPrompt embeds content and count", fPrompt.includes("牛顿定律内容") && fPrompt.includes("5"));
check("settings module registers global", typeof Settings === "object" && typeof Settings.render === "function");

// --- AI note generation helpers ---
const notePrompt = AI.buildNotePrompt("量子计算", "");
check("AI buildNotePrompt embeds topic and JSON shape", notePrompt.includes("量子计算") && notePrompt.includes('"title"') && notePrompt.includes('"blocks"'));
check("AI buildNotePrompt forbids display math inside text blocks", notePrompt.includes("equation") && notePrompt.includes("不要在段落正文中使用 $$"));
const suppPrompt = AI.buildSupplementPrompt("机器学习", "已有内容：监督学习");
check("AI buildSupplementPrompt embeds title and content", suppPrompt.includes("机器学习") && suppPrompt.includes("监督学习") && suppPrompt.includes('"blocks"'));
check("AI buildSupplementPrompt forbids display math inside text blocks", suppPrompt.includes("equation") && suppPrompt.includes("不要在段落正文中使用 $$"));

// --- AI chat skill (tool calling) ---
check("AI describeToolCall labels create_note", AI.describeToolCall("create_note", { title: "量子计算", blocks: [{}, {}] }).includes("量子计算") && AI.describeToolCall("create_note", { title: "x", blocks: [{}, {}] }).includes("2 个块"));
check("AI describeToolCall labels create_questions", AI.describeToolCall("create_questions", { questions: [{}, {}] }).includes("2 道题目"));
const noteRes = await AI.executeTool("create_note", { title: "AI 技能笔记", blocks: [{ type: "paragraph", text: "段落一" }, { type: "heading2", text: "小标题" }] });
check("AI executeTool create_note builds page with blocks", noteRes.ok && noteRes.pageId && Store.getPage(noteRes.pageId).children.length === 2);
const appendPage = Store.createPage("root", { title: "追加测试页" });
Store.currentPageId = appendPage.id;
const appendRes = await AI.executeTool("append_blocks", { blocks: [{ type: "paragraph", text: "补充段落" }] });
check("AI executeTool append_blocks appends to current page", appendRes.ok && appendRes.blockCount === 1 && Store.getPage(appendPage.id).children.length === 1);
const batchPage = Store.createPage("root", { title: "批量页" });
const batchCount = AI.createBlocksBatch(batchPage.id, [{ type: "paragraph", text: "a" }, { type: "paragraph", text: "b" }, { type: "heading2", text: "标题" }]);
check("AI createBlocksBatch creates all blocks", batchCount === 3 && batchPage.children.length === 3);
// 位置插入：after / before
const posPage = Store.createPage("root", { title: "位置测试" });
Store.currentPageId = posPage.id;
const blkA = await AI.executeTool("create_block", { type: "paragraph", text: "A" });
const blkB = await AI.executeTool("create_block", { type: "paragraph", text: "B" });
const blkC = await AI.executeTool("create_block", { type: "paragraph", text: "C", after: blkA.blockId });
check("AI create_block after inserts after target", posPage.children[0].id === blkA.blockId && posPage.children[1].id === blkC.blockId);
const blkD = await AI.executeTool("create_block", { type: "paragraph", text: "D", before: blkB.blockId });
check("AI create_block before inserts before target", posPage.children.map(c => c.id).indexOf(blkD.blockId) < posPage.children.map(c => c.id).indexOf(blkB.blockId));
const posPage2 = Store.createPage("root", { title: "批量位置" });
AI.createBlocksBatch(posPage2.id, [{ type: "paragraph", text: "1" }]);
AI.createBlocksBatch(posPage2.id, [{ type: "paragraph", text: "2" }, { type: "paragraph", text: "3" }], posPage2.children[0].id);
check("AI createBlocksBatch after inserts in order", posPage2.children.map(c => U.segsText(c.text)).join(",") === "1,2,3");
const qRes = await AI.executeTool("create_questions", { questions: [{ type: "short_answer", prompt: "技能题", answer: "答案" }] });
check("AI executeTool create_questions writes question block", qRes.ok && qRes.count === 1 && posPage.children.some(b => b.type === "question" && b.attrs.qid));
const fRes = await AI.executeTool("create_flashcards", { flashcards: [{ front: "正", back: "背" }] });
check("AI executeTool create_flashcards writes card block", fRes.ok && fRes.count === 1 && posPage.children.some(b => b.type === "flashcard" && b.attrs.fid));
check("AI executeTool rejects unknown skill", (await AI.executeTool("nope", {})).ok === false);
check("AI describeToolCall labels load_skill", AI.describeToolCall("load_skill", { name: "relationship-zhu" }).includes("relationship-zhu"));

// --- AI markdown handling ---
const mdBlocks = AI.markdownToBlocks("# 标题\n\n- 项目1\n- 项目2\n\n正文 **加粗** 和 `代码`");
check("AI markdownToBlocks maps headings and lists", mdBlocks[0].type === "heading1" && mdBlocks[1].type === "bullet" && mdBlocks[2].type === "bullet" && mdBlocks[3].type === "paragraph");
check("AI markdownToBlocks keeps inline bold/code", mdBlocks[3].segments.some(s => s.t === "加粗" && s.b === 1) && mdBlocks[3].segments.some(s => s.t === "代码" && s.c === 1));
const mdHtml = AI.renderMarkdown("**加粗** `code` 和 *斜体*");
check("AI renderMarkdown produces bold/code/italic HTML", mdHtml.includes("<b>加粗</b>") && mdHtml.includes("<code>code</code>") && mdHtml.includes("<i>斜体</i>"));
const mdDivider = AI.markdownToBlocks("上\n---\n下");
check("AI markdownToBlocks maps divider", mdDivider.some(b => b.type === "divider"));
const aiMathHtml = AI.inlineMarkdown("质能方程 $E=mc^2$ 和 **加粗**");
check("AI inlineMarkdown renders inline math", aiMathHtml.includes("ai-math") && aiMathHtml.includes("<b>加粗</b>"));
const mixedMathHtml = AI.inlineMarkdown("正文 $$E=mc^2$$ 和 $c$");
check("AI inlineMarkdown normalizes display delimiters in prose", (mixedMathHtml.match(/class=\"ai-math\"/g) || []).length === 2 && !mixedMathHtml.includes("$$"));
const fourStarSegs = AI.inlineToSegments("****加粗**** 和 ***也粗***");
check("AI inlineToSegments normalizes **** and *** to bold", fourStarSegs.some(s => s.t === "加粗" && s.b === 1) && fourStarSegs.some(s => s.t === "也粗" && s.b === 1));
check("AI inlineMarkdown normalizes **** to bold", AI.inlineMarkdown("****加粗****").includes("<b>加粗</b>"));
const displayMd = AI.markdownToBlocks("前文\n\n$$\nE = mc^2\n$$\n\n后文");
check("AI markdownToBlocks keeps multiline display math as equation", displayMd.length === 3 && displayMd[1].type === "equation" && displayMd[1].segments[0].t === "$$E = mc^2$$");
const mixedMathMd = AI.markdownToBlocks("结论：$$E=mc^2$$，其中 $c$ 是光速。");
check("AI markdownToBlocks does not treat display math as inline", mixedMathMd[0].segments.filter(s => s.math != null).map(s => s.math).join(",") === "E=mc^2,c" && !mixedMathMd[0].segments.some(s => (s.t || "").includes("$$")));
const longMathMd = AI.markdownToBlocks("说明\n\n$$\\begin{aligned}\na & = b + c \\\\\n d & = e + f\n\\end{aligned}$$\n\n结论");
check("AI markdownToBlocks preserves multiline LaTeX payload", longMathMd.some(b => b.type === "equation" && b.segments[0].t.includes("aligned")));
const splitBlocks = AI.markdownToBlocks("第一段\n\n第二段\n\n1. 甲\n2. 乙");
check("AI markdownToBlocks splits multiline into multiple blocks", splitBlocks.length === 4 && splitBlocks[2].type === "numbered");

// --- AI block editing skills (table / equation / any block) ---
const editPage = Store.createPage("root", { title: "块编辑测试页" });
Store.currentPageId = editPage.id;
const tblRes = await AI.executeTool("create_block", { type: "table", attrs: { cols: 2, header: true, rows: [["姓名", "年龄"], ["张三", "20"]] } });
check("AI create_block builds a table with cells", tblRes.ok && Store.findBlock(editPage, tblRes.blockId).attrs.rows[0][0][0].t === "姓名" && Store.findBlock(editPage, tblRes.blockId).attrs.rows[1][1][0].t === "20");
const eqRes = await AI.executeTool("create_block", { type: "equation", text: "$$E=mc^2$$" });
check("AI create_block builds an equation", eqRes.ok && U.segsText(Store.findBlock(editPage, eqRes.blockId).text) === "$$E=mc^2$$");
const eqSan = AI.sanitizeBlock({ type: "equation", text: "$$\\frac{a}{b}$$" });
check("AI sanitizeBlock preserves equation type", eqSan && eqSan.type === "equation" && eqSan.text === "$$\\frac{a}{b}$$");
const eqSan2 = AI.sanitizeBlock({ type: "equation", text: "$$E=mc^2$$", attrs: { source: "x" } });
check("AI sanitizeBlock passes attrs through", eqSan2 && eqSan2.attrs && eqSan2.attrs.source === "x");
const promotedEq = AI.sanitizeBlock({ type: "paragraph", text: "$$\\sum_{i=1}^n i$$" });
check("AI sanitizeBlock promotes standalone display math", promotedEq && promotedEq.type === "equation" && promotedEq.text === "$$\\sum_{i=1}^n i$$");
const normalizedInlineEq = AI.sanitizeBlock({ type: "paragraph", text: "总和为 $$S_n$$，其中 **n 为项数**" });
check("AI sanitizeBlock normalizes display delimiters inside text", normalizedInlineEq && normalizedInlineEq.type === "paragraph" && normalizedInlineEq.text.includes("$S_n$") && !normalizedInlineEq.text.includes("$$"));
const listRes = await AI.executeTool("list_pages", {});
check("AI list_pages returns workspace pages", listRes.ok && Array.isArray(listRes.pages) && listRes.pages.length > 0 && listRes.pages.every(p => p.id && p.title != null && p.type));
const bigPdf = Store.createPage("root", { title: "大PDF", pdf: true, url: "data:application/pdf;base64," + "B".repeat(2000) });
const listRes2 = await AI.executeTool("list_pages", {});
const bigEntry = listRes2.pages.find(p => p.id === bigPdf.id);
check("AI list_pages omits huge data URLs", bigEntry && bigEntry.url === "");
const prevStyle = AI.style;
AI.style = "standard";
check("AI styleHint empty for standard", AI.styleHint() === "");
AI.style = "concise";
check("AI styleHint returns concise hint", AI.styleHint().includes("简洁"));
AI.style = "feynman";
check("AI styleHint returns feynman hint", AI.styleHint().includes("费曼"));
AI.style = prevStyle;
const mediaRes = await AI.collectMediaItems({ pages: {} });
check("AI collectMediaItems returns array", Array.isArray(mediaRes));
const cpInfo = AI.currentPageInfo();
check("AI currentPageInfo returns page metadata", cpInfo && cpInfo.id === editPage.id && cpInfo.type === "note" && cpInfo.title != null);
const pdfInfoPage = Store.createPage("root", { title: "PDF信息", pdf: true, url: "data:application/pdf;base64," + "A".repeat(1000) });
const webInfoPage = Store.createPage("root", { title: "网页信息", web: true, url: "https://example.com/article" });
Store.currentPageId = pdfInfoPage.id;
check("AI currentPageInfo omits huge data URL", AI.currentPageInfo().url === "");
Store.currentPageId = webInfoPage.id;
check("AI currentPageInfo keeps http URL", AI.currentPageInfo().url === "https://example.com/article");
Store.currentPageId = editPage.id;
const updRes = await AI.executeTool("update_block", { blockId: eqRes.blockId, text: "$$F=ma$$" });
check("AI update_block edits text", updRes.ok && U.segsText(Store.findBlock(editPage, eqRes.blockId).text) === "$$F=ma$$");
const tblSum = AI.summarizeBlock(Store.findBlock(editPage, tblRes.blockId));
check("AI summarizeBlock exposes table rows as text", tblSum.rows[0][0] === "姓名" && tblSum.rows[1][1] === "20");
const norm = AI.normalizeBlockAttrs({ rows: [["a", "b"]], cols: 2, header: true });
check("AI normalizeBlockAttrs converts cells to segments", norm.rows[0][0][0].t === "a" && norm.cols === 2 && norm.header === true);
const paraRes = await AI.executeTool("create_block", { type: "paragraph", text: "移动目标" });
const moved = await AI.executeTool("move_block", { blockId: eqRes.blockId, targetId: paraRes.blockId, position: "before" });
check("AI move_block moves block", moved.ok);
const delRes = await AI.executeTool("delete_block", { blockId: paraRes.blockId });
check("AI delete_block removes block", delRes.ok && !Store.findBlock(editPage, paraRes.blockId));

// --- AI web page / embed ---
const webRes = await AI.executeTool("create_web_page", { url: "https://example.com", title: "示例网页" });
check("AI create_web_page creates a web page", webRes.ok && Store.getPage(webRes.pageId).web === true && Store.getPage(webRes.pageId).url === "https://example.com");
const webBridge = Bridge.execute("page.create", { web: true, url: "https://openai.com" });
check("bridge page.create supports web/url", webBridge.ok && Store.getPage(webBridge.result.id).web === true && Store.getPage(webBridge.result.id).url === "https://openai.com");
Store.currentPageId = editPage.id;
const embedRes = await AI.executeTool("create_block", { type: "embed", attrs: { url: "https://example.org" } });
check("AI create_block embed sets url", embedRes.ok && Store.findBlock(editPage, embedRes.blockId).attrs.url === "https://example.org");

// --- PDF page / block ---
const pdfRes = await AI.executeTool("create_pdf_page", { url: "https://example.com/doc.pdf", page: 3 });
check("AI create_pdf_page creates a PDF page", pdfRes.ok && Store.getPage(pdfRes.pageId).pdf === true && Store.getPage(pdfRes.pageId).url === "https://example.com/doc.pdf" && Store.getPage(pdfRes.pageId).page === 3);
const pdfBridge = Bridge.execute("page.create", { pdf: true, url: "https://example.com/a.pdf" });
check("bridge page.create supports pdf/page", pdfBridge.ok && Store.getPage(pdfBridge.result.id).pdf === true && Store.getPage(pdfBridge.result.id).url === "https://example.com/a.pdf");
Store.currentPageId = editPage.id;
const pdfBlock = await AI.executeTool("create_block", { type: "pdf", attrs: { url: "https://example.com/x.pdf", page: 2 } });
check("AI create_block pdf sets url and page", pdfBlock.ok && Store.findBlock(editPage, pdfBlock.blockId).attrs.url === "https://example.com/x.pdf" && Store.findBlock(editPage, pdfBlock.blockId).attrs.page === 2);

// --- persistence: save writes the workspace (IndexedDB primary + localStorage mirror) ---
Store.save(true);
const persistedState = JSON.parse(localStorage.getItem(Store.LS_KEY));
check("save persists pdf page to storage", persistedState && persistedState.pages[pdfRes.pageId] && persistedState.pages[pdfRes.pageId].pdf === true && persistedState.pages[pdfRes.pageId].url === "https://example.com/doc.pdf");

// --- web iframe stays fully interactive (no sandbox, grants allow) ---
const webSrc = fs.readFileSync(path.join(base, "js", "web.js"), "utf8");
check("web iframe grants allow and is not sandboxed", webSrc.includes("frame.allow") && !webSrc.includes("sandbox"));
const pdfSrc = fs.readFileSync(path.join(base, "js", "pdf.js"), "utf8");
check("pdf viewer uses PDF.js canvas rendering", pdfSrc.includes("pdfjsLib") && pdfSrc.includes("getDocument") && pdfSrc.includes("vendor/pdfjs"));
check("pdf.js library files exist locally", fs.existsSync(path.join(base, "vendor", "pdfjs", "pdf.min.js")) && fs.existsSync(path.join(base, "vendor", "pdfjs", "pdf.worker.min.js")));
check("mermaid library exists locally", fs.existsSync(path.join(base, "vendor", "mermaid", "mermaid.min.js")) && fs.readFileSync(path.join(base, "js", "mermaid.js"), "utf8").includes("vendor/mermaid/mermaid.min.js"));
check("pdf viewer supports pan/zoom/auto-upload", pdfSrc.includes("wheel") && pdfSrc.includes("autoUpload") && pdfSrc.includes("renderTextLayer") && pdfSrc.includes("pdf-hl"));
check("pdf viewer smooth transform zoom", pdfSrc.includes("_zoomBase") && pdfSrc.includes("commitZoom") && pdfSrc.includes("_applyZoomTransformTo") && pdfSrc.includes("_renderScale"));
check("pdf viewer extracts and links images", pdfSrc.includes("extractPageImages") && pdfSrc.includes("imageDataToDataUrl") && pdfSrc.includes("drawPageImages") && pdfSrc.includes("showImageMenu") && pdfSrc.includes("paintImageXObject"));

// --- PDF zoom behavior regressions ---
const originalPdfState = {
  page: PDFViewer.page, doc: PDFViewer.doc, scale: PDFViewer.scale, pagesEl: PDFViewer.pagesEl,
  rendered: PDFViewer.rendered, pageSizes: PDFViewer._pageSizes, observer: PDFViewer._observer,
  zoomTimer: PDFViewer._zoomTimer, zoomBase: PDFViewer._zoomBase, generation: PDFViewer._generation,
};
const zoomPages = {
  scrollTop: 424, clientHeight: 500,
  getBoundingClientRect: () => ({ top: 0 }),
};
const makeZoomChild = (pageNum, contentTop, height) => ({
  dataset: { page: String(pageNum) }, offsetHeight: height, style: {},
  getBoundingClientRect: () => ({ top: contentTop - zoomPages.scrollTop, height }),
});
const zoomKids = [makeZoomChild(1, 16, 400), makeZoomChild(2, 432, 800), makeZoomChild(3, 1248, 600)];
Object.assign(zoomPages, {
  querySelectorAll: () => zoomKids,
  querySelector: selector => {
    const m = selector.match(/data-page="(\d+)"/);
    return m ? zoomKids.find(k => k.dataset.page === m[1]) || null : null;
  },
});
PDFViewer.pagesEl = zoomPages;
PDFViewer.page = { page: 2 };
PDFViewer.doc = { numPages: 3 };
PDFViewer.scale = 1.5;
PDFViewer._pageSizes = [{ width: 600, height: 800 }, { width: 700, height: 1200 }, { width: 500, height: 600 }];
const gapAnchor = PDFViewer._captureAnchor();
check("pdf zoom gap anchors to nearest page", gapAnchor.page === 1 && gapAnchor.frac === 1);
check("pdf mixed page sizes use individual dimensions", PDFViewer._pageBoxSize(1).height === 1225 && PDFViewer._pageBoxSize(2).height === 1825 && PDFViewer._pageBoxSize(3).height === 925);
PDFViewer._restoreAnchor({ page: 2, frac: 0.25 });
check("pdf zoom restores page fraction", zoomPages.scrollTop === 432 + 0.25 * 800);
PDFViewer._observer = { disconnected: false, disconnect() { this.disconnected = true; } };
const disposedObserver = PDFViewer._observer;
PDFViewer._zoomTimer = setTimeout(() => {}, 10000);
PDFViewer._zoomBase = 1.3;
const generationBeforeDispose = PDFViewer._generation;
PDFViewer._dispose();
check("pdf dispose cancels zoom lifecycle", disposedObserver.disconnected && PDFViewer._observer === null && PDFViewer._zoomTimer === null && PDFViewer._zoomBase === null && PDFViewer._generation === generationBeforeDispose + 1);
Object.assign(PDFViewer, {
  page: originalPdfState.page, doc: originalPdfState.doc, scale: originalPdfState.scale, pagesEl: originalPdfState.pagesEl,
  rendered: originalPdfState.rendered, _pageSizes: originalPdfState.pageSizes, _observer: originalPdfState.observer,
  _zoomTimer: originalPdfState.zoomTimer, _zoomBase: originalPdfState.zoomBase, _generation: originalPdfState.generation,
});

// --- PDF highlight / annotation ---
const pdfHlPage = Store.createPage("root", { title: "标注测试", pdf: true, url: "https://x.com/a.pdf" });
pdfHlPage.highlights.push({ id: "hl1", page: 2, text: "测试句子", color: "#ffe58f", rects: [[0, 0, 100, 10]] });
const hlRefPage = Store.createPage("root", { title: "引用页" });
const hlBlk = Store.newBlock("highlight");
hlBlk.attrs = { highlightId: "hl1", sourcePageId: pdfHlPage.id, hlText: "测试句子", hlPage: 2 };
Store.insertBlock(hlRefPage, hlBlk);
const hlRefs = Store.findHighlightRefs("hl1");
check("findHighlightRefs locates referencing blocks", hlRefs.length === 1 && hlRefs[0].pageId === hlRefPage.id && hlRefs[0].blockId === hlBlk.id);
check("highlight block persists attrs", Store.findBlock(hlRefPage, hlBlk.id).attrs.highlightId === "hl1" && Store.findBlock(hlRefPage, hlBlk.id).attrs.hlText === "测试句子");

// --- PDF image extraction / linking ---
const pdfImgPage = Store.createPage("root", { title: "图片测试", pdf: true, url: "https://x.com/a.pdf" });
pdfImgPage.images.push({ id: "img1", page: 1, x: 10, y: 20, w: 100, h: 80, dataUrl: "data:image/png;base64,AAAA" });
const imgRefPage = Store.createPage("root", { title: "图片引用页" });
const imgBlk = Store.newBlock("pdfimage");
imgBlk.attrs = { imageId: "img1", sourcePageId: pdfImgPage.id, imgPage: 1, imgThumb: "data:image/png;base64,AAAA" };
Store.insertBlock(imgRefPage, imgBlk);
const imgRefs = Store.findImageRefs("img1");
check("findImageRefs locates referencing blocks", imgRefs.length === 1 && imgRefs[0].pageId === imgRefPage.id && imgRefs[0].blockId === imgBlk.id);
check("pdfimage block persists attrs", Store.findBlock(imgRefPage, imgBlk.id).attrs.imageId === "img1" && Store.findBlock(imgRefPage, imgBlk.id).attrs.imgPage === 1);
check("pdf pages cursor is not grab", !/\.pdf-pages\{[^}]*cursor:\s*grab/.test(stylesheet));
const editorSrc = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8");
check("editor preserves PDF text selection on pointerdown", editorSrc.includes('closest(".pdf-page")'));
check("editor auto-renders mermaid", editorSrc.includes("autoRenderMermaids") && editorSrc.includes("mm-edit"));
const appSrc = fs.readFileSync(path.join(base, "js", "app.js"), "utf8");
check("app supports split view", appSrc.includes("splitView") && appSrc.includes("renderSplit") && appSrc.includes("toggleSplit") && appSrc.includes("_renderTarget"));
check("app has shortcut help panel", appSrc.includes("openShortcuts") && appSrc.includes("kbd-list"));
const utilSrc = fs.readFileSync(path.join(base, "js", "util.js"), "utf8");
check("util has unified prompt/confirm modals", utilSrc.includes("promptModal") && utilSrc.includes("confirmModal"));
const allSrc = [utilSrc, appSrc, editorSrc, fs.readFileSync(path.join(base, "js", "sidebar.js"), "utf8"), fs.readFileSync(path.join(base, "js", "database.js"), "utf8"), fs.readFileSync(path.join(base, "js", "ai.js"), "utf8")].join("\n");
check("no native prompt/confirm remain", !/\bprompt\(|\bconfirm\(/.test(allSrc));
check("sidebar inline rename + block cut/paste", fs.readFileSync(path.join(base, "js", "sidebar.js"), "utf8").includes("startRename") && editorSrc.includes("pasteClipboard") && editorSrc.includes("_clipboard"));
check("block AI actions with preview + rewrite requirement", editorSrc.includes("block-ai-btn") && editorSrc.includes("positionAIButton") && editorSrc.includes("openBlockAI") && editorSrc.includes("aiBlockAction") && editorSrc.includes("proposeDraft") && editorSrc.includes("重写要求"));
check("block AI offers list conversion options", editorSrc.includes("aiBlockToList") && editorSrc.includes("转为有序列表") && editorSrc.includes("转为无序列表"));
check("block AI can split one block into many", editorSrc.includes("splitBlockResult") && editorSrc.includes("replaceBlockWithMany"));
check("AI panel has draft preview element", fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes('class="ai-draft"') && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("ai-messages"));
check("AI results render markdown + inline math", editorSrc.includes("inlineToSegments") && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("renderMarkdown(text)"));
check("AI block prompt instructs markdown + inline math", editorSrc.includes("styleHint") && editorSrc.includes("**加粗**") && editorSrc.includes("$...$"));
check("AI generates interactive HTML block", editorSrc.includes("aiGenerateHTML") && editorSrc.includes("editHTML") && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("generateHTML") && fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8").includes("b-html-frame") && fs.readFileSync(path.join(base, "js", "store.js"), "utf8").includes('"html"'));
check("AI asks block types before long-form generation", fs.readFileSync(path.join(base, "server.js"), "utf8").includes("生成长篇内容") && fs.readFileSync(path.join(base, "server.js"), "utf8").includes("ask_block_types"));
check("AI block type enum expanded for rich blocks", fs.readFileSync(path.join(base, "server-ai.js"), "utf8").includes('BLOCK_TYPE_ENUM = ["paragraph"') && fs.readFileSync(path.join(base, "server-ai.js"), "utf8").includes('"html"') && fs.readFileSync(path.join(base, "server-ai.js"), "utf8").includes('"mermaid"'));
check("AI rejects empty note/block generation", fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("AI 未生成任何内容") && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("iter < 12"));
check("AI notes parse markdown into rich segments", fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes("inlineToSegments(nb.text)"));
check("AI fix button for mermaid/html blocks", editorSrc.includes("aiFixBlock") && fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8").includes("mm-fix") && fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8").includes("b-html-btn"));
check("L1/L2/L3 long-term memory + RAG query", fs.readFileSync(path.join(base, "server.js"), "utf8").includes("api/memory/query") && fs.readFileSync(path.join(base, "server.js"), "utf8").includes("recentMemorySummary") && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes('case "query_memory"') && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes('case "save_memory"') && fs.readFileSync(path.join(base, "js", "ai.js"), "utf8").includes('"query_memory"'));
check("render modules target U.renderRoot", editorSrc.includes("U.renderRoot()") && fs.readFileSync(path.join(base, "js", "web.js"), "utf8").includes("U.renderRoot()") && fs.readFileSync(path.join(base, "js", "pdf.js"), "utf8").includes("U.renderRoot()") && fs.readFileSync(path.join(base, "js", "database.js"), "utf8").includes("U.renderRoot()"));
const blocksSrc = fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8");
check("equation block uses inline contenteditable source", blocksSrc.includes("eq-source") && blocksSrc.includes('contentEditable = "true"'));
check("editor has equation Enter + trailing empty block", editorSrc.includes("equationEnter") && editorSrc.includes("ensureTrailingBlock"));
check("todo checkbox aligned with text", /\.b-checkbox\{[^}]*margin-top:/.test(stylesheet));
const aiSrc = fs.readFileSync(path.join(base, "js", "ai.js"), "utf8");
check("AI toggle focuses without scrolling", aiSrc.includes("preventScroll"));
check("AI indexes PDF/web for auto-retrieval", aiSrc.includes("collectMediaItems") && aiSrc.includes("pdf:") && aiSrc.includes("web:"));
check("AI confirm shows applied feedback", aiSrc.includes("已应用"));
check("AI auto-approves read-only tools", aiSrc.includes("READ_TOOLS") && aiSrc.includes("showToolCallsNote") && aiSrc.includes("writeCalls") && aiSrc.includes("AbortError"));
check("AI supports writing styles", aiSrc.includes("WRITING_STYLES") && aiSrc.includes("styleHint") && aiSrc.includes("ai-style"));
check("AI has evidence-based learning styles", aiSrc.includes("feynman") && aiSrc.includes("elaboration") && aiSrc.includes("cornell") && aiSrc.includes("dual-coding"));
const serverSrc = fs.readFileSync(path.join(base, "server.js"), "utf8");
check("server has crash guardrails", serverSrc.includes("uncaughtException") && serverSrc.includes("unhandledRejection") && serverSrc.includes("writableEnded"));
check("AI panel pushes content (no overlay)", /\.ai-panel\{[^}]*margin-right:/.test(stylesheet) && !/\.ai-panel\{[^}]*position:\s*absolute/.test(stylesheet));
check("pdf mergeRects merges same-line fragments", PDFViewer.mergeRects([{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 }]).length === 1);
check("pdf mergeRects keeps separate lines", PDFViewer.mergeRects([{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 0, top: 20, right: 10, bottom: 30 }]).length === 2);

  // --- 图标 / Emoji / 封面优化 ---
  check("lucide is vendored and loaded", fs.existsSync(path.join(base, "vendor", "lucide", "lucide.min.js")) && fs.readFileSync(path.join(base, "index.html"), "utf8").includes("vendor/lucide/lucide.min.js"));
  check("U.iconName maps kebab-case to PascalCase", typeof U.iconName === "function" && U.iconName("trash-2") === "Trash2" && U.iconName("more-horizontal") === "MoreHorizontal" && U.iconName("chevron-left") === "ChevronLeft");
  const realLucide = global.lucide;
  global.lucide = { icons: { TestIcon: [["path", { d: "M0 0 L2 2" }], ["circle", { cx: "1", cy: "1", r: "1" }]] } };
  const iconSvg = typeof U.icon === "function" ? U.icon("test-icon", { size: 20, strokeWidth: 1.5 }) : "";
  global.lucide = realLucide;
  check("U.icon renders svg string with attrs", iconSvg.includes("<svg") && iconSvg.includes('width="20"') && iconSvg.includes('stroke-width="1.5"') && iconSvg.includes('viewBox="0 0 24 24"') && iconSvg.includes('<path d="M0 0 L2 2"/>') && iconSvg.includes('<circle cx="1" cy="1" r="1"/>'));
  check("U.icon falls back safely without lucide", typeof U.icon === "function" && U.icon("trash-2") === "");
  check("emoji groups categorized with labels", typeof U.EMOJI_GROUPS === "object" && Array.isArray(U.EMOJI_GROUPS) && U.EMOJI_GROUPS.length >= 5 && U.EMOJI_GROUPS.every(g => g.id && g.label && Array.isArray(g.emojis) && g.emojis.length > 0));
  check("emoji keywords enable Chinese search", typeof U.EMOJI_KEYWORDS === "object" && typeof U.EMOJI_KEYWORDS["😀"] === "string" && typeof U.EMOJI_KEYWORDS["📚"] === "string" && typeof U.EMOJI_KEYWORDS["🔥"] === "string");
  const recentAdd = typeof U.recentEmojisAdd === "function";
  if (recentAdd) U.recentEmojisAdd("🚀");
  const recents = typeof U.recentEmojisGet === "function" ? U.recentEmojisGet() : [];
  check("emoji recents persist and round-trip", recentAdd && Array.isArray(recents) && recents.includes("🚀"));
  check("cover catalog categorized with credits", typeof U.COVER_CATALOG === "object" && Array.isArray(U.COVER_CATALOG) && U.COVER_CATALOG.length >= 3 && U.COVER_CATALOG.every(cat => cat.id && cat.label && Array.isArray(cat.items) && cat.items.length > 0 && cat.items.every(it => it.src && it.thumb && it.alt && it.credit && it.creditUrl)));
  check("cover catalog includes oil paintings from Wikimedia", (() => { const p = (U.COVER_CATALOG || []).find(c => c.id === "painting"); return !!p && p.items.length >= 6 && p.items.every(it => it.src.includes("commons.wikimedia.org") && it.credit && it.creditUrl.includes("commons.wikimedia.org")); })());
  check("tool icons use U.icon in topbar", fs.readFileSync(path.join(base, "js", "app.js"), "utf8").includes("U.icon("));
  check("cover picker lazy-loads thumbnails", fs.readFileSync(path.join(base, "js", "app.js"), "utf8").includes("loading") && fs.readFileSync(path.join(base, "js", "app.js"), "utf8").includes("lazy"));

  // --- 题库图谱 ---
  check("QB cosine identical is 1", typeof QuestionBank !== "undefined" && Math.abs(QuestionBank.cosine([1, 0, 2], [1, 0, 2]) - 1) < 1e-9);
  check("QB cosine orthogonal is 0", typeof QuestionBank !== "undefined" && QuestionBank.cosine([1, 0], [0, 1]) === 0);
  check("QB buildEdges links similar vectors", typeof QuestionBank !== "undefined" && (() => { const e = QuestionBank.buildEdges([[1, 0], [1, 0], [0, 1]], 0.5); return e.length === 1 && e[0].a === 0 && e[0].b === 1; })());
  check("QB initPositions forms a circle", typeof QuestionBank !== "undefined" && (() => { const p = QuestionBank.initPositions(4, 400, 400); return p.length === 4 && p.every(x => x.x > 0 && x.y > 0); })());
  check("QB layoutStep keeps nodes finite", typeof QuestionBank !== "undefined" && (() => { const nodes = QuestionBank.initPositions(3, 400, 400); QuestionBank.layoutStep(nodes, [{ a: 0, b: 1, score: 0.9 }], { width: 400, height: 400 }); return nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)); })());
  check("QB layoutStep pins dragged node and pulls neighbor", typeof QuestionBank !== "undefined" && (() => { const nodes = [{ x: 100, y: 100, vx: 0, vy: 0, pinned: true }, { x: 300, y: 100, vx: 0, vy: 0 }]; QuestionBank.layoutStep(nodes, [{ a: 0, b: 1, score: 0.9 }], { width: 400, height: 400 }); return nodes[0].x === 100 && nodes[0].y === 100 && nodes[1].x < 300; })());
  check("QB drag runs sim and snaps back on release", (() => { const src = fs.readFileSync(path.join(base, "js", "question-bank.js"), "utf8"); return src.includes("runLoop(200)") && src.includes("this._dragNode >= 0"); })());
  check("QB screenToWorld converts coords", typeof QuestionBank !== "undefined" && typeof QuestionBank.screenToWorld === "function" && (() => { const p = QuestionBank.screenToWorld(200, 100, 2, 100, 50); return p.x === 50 && p.y === 25; })());
  check("QB zoomAt keeps anchor fixed", typeof QuestionBank !== "undefined" && typeof QuestionBank.zoomAt === "function" && (() => { const z = QuestionBank.zoomAt(200, 100, 1, 0, 0, 2); return Math.abs(z.scale - 2) < 1e-9 && Math.abs((200 - z.offsetX) / z.scale - 200) < 1e-9 && Math.abs((100 - z.offsetY) / z.scale - 100) < 1e-9; })());
  check("QB zoomAt clamps scale", typeof QuestionBank !== "undefined" && typeof QuestionBank.zoomAt === "function" && (() => { const z = QuestionBank.zoomAt(0, 0, 1, 0, 0, 100); return z.scale === 3; })());
  check("question bank route wired", fs.readFileSync(path.join(base, "js", "app.js"), "utf8").includes("QuestionBank.render"));
  check("question bank module loaded", fs.readFileSync(path.join(base, "index.html"), "utf8").includes("question-bank.js"));
  check("question bank embed endpoint exists", fs.readFileSync(path.join(base, "server.js"), "utf8").includes("/api/questions/embed"));
  check("questions route dispatched to handler", fs.readFileSync(path.join(base, "server.js"), "utf8").includes('url.startsWith("/api/questions/")'));

  // --- 布局设置（页宽 / 行间距） ---
  check("layout store supports page width and line height", fs.readFileSync(path.join(base, "js", "store.js"), "utf8").includes("applyLayout") && fs.readFileSync(path.join(base, "js", "store.js"), "utf8").includes("pageWidth") && fs.readFileSync(path.join(base, "js", "store.js"), "utf8").includes("lineHeight"));
  check("layout CSS uses variables", fs.readFileSync(path.join(base, "css", "styles.css"), "utf8").includes("--page-width") && fs.readFileSync(path.join(base, "css", "styles.css"), "utf8").includes("--line-height"));
  check("layout settings UI exposes page width and line height", fs.readFileSync(path.join(base, "js", "settings.js"), "utf8").includes("页宽") && fs.readFileSync(path.join(base, "js", "settings.js"), "utf8").includes("行间距"));

  // --- 配色：跟随鼠标、方块、主题适配 ---
  check("color palette has theme variants", (() => { const s = fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8"); return s.includes("TEXT_DARK_MAP") && s.includes("BG_DARK_MAP") && s.includes("TEXT_LIGHT_MAP") && s.includes("BG_LIGHT_MAP"); })());
  check("color menu captures rect before closing popovers", (() => { const s = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8"); const a = s.indexOf("const rect = anchor.getBoundingClientRect()"); const c = s.indexOf("U.closePopovers()", a); return a >= 0 && c > a; })());
  check("color swatch is a filled square (no circle dot)", (() => { const e = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8"); return !e.includes('"●"') && e.includes("style.background"); })());
  check("color swatch keeps text selection on click", (() => { const s = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8"); const i = s.indexOf("openColorMenu(anchor"); const seg = s.slice(i, i + 900); return seg.includes('s.addEventListener("mousedown", (e) => e.preventDefault())'); })());
  check("color swatch click does not clear selection on pointerdown", (() => { const s = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8"); const i = s.indexOf("onPointerDown"); const seg = s.slice(i, i + 600); return seg.includes('closest(".swatch")'); })());

  // --- 多块框选 AI 改写 ---
  check("multi-block AI rewrite is wired", (() => { const s = fs.readFileSync(path.join(base, "js", "editor.js"), "utf8"); return s.includes("aiRewriteSelected") && s.includes("replaceSelectedBlocks") && s.includes("AI 改写所选块"); })());

  // --- 代码块自动展开 + 语言选择器暗色适配 ---
  check("code block auto-expands by content height", fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8").includes("ta.rows") && fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8").includes("split(\"\\n\")"));
  check("code language select styled for dark theme", (() => { const c = fs.readFileSync(path.join(base, "css", "styles.css"), "utf8"); return c.includes("select option") && c.includes(".sn-lang"); })());

  // --- mermaid 输入防抖自动渲染 ---
  check("mermaid auto-renders on input debounce", fs.readFileSync(path.join(base, "js", "editor.js"), "utf8").includes("_mmRenderTimer"));
  check("mermaid re-renders after async library load", fs.readFileSync(path.join(base, "js", "editor.js"), "utf8").includes("_mmReadyHooked"));

  // --- PDF 导出优化 ---
  check("print resets dark theme colors to readable text", fs.readFileSync(path.join(base, "css", "styles.css"), "utf8").includes('--text: #37352f !important'));
  check("print expands code blocks and renders mermaid", (() => { const a = fs.readFileSync(path.join(base, "js", "app.js"), "utf8"); return a.includes("printPage") && a.includes("renderAllMermaidsForPrint"); })());
  check("print paginates long code blocks", (() => { const a = fs.readFileSync(path.join(base, "js", "app.js"), "utf8"); const c = fs.readFileSync(path.join(base, "css", "styles.css"), "utf8"); return a.includes("print-code") && a.includes("replaceChild") && c.includes("break-inside: auto"); })());

  // --- 技能集成（drawio + html） ---
  check("drawio-skill and html skill installed locally", fs.existsSync(path.join(base, "skills", "drawio-skill", "SKILL.md")) && fs.existsSync(path.join(base, "skills", "html", "SKILL.md")));
  check("server routes diagrams to drawio-skill and web to html skill", (() => { const s = fs.readFileSync(path.join(base, "server.js"), "utf8"); return s.includes("drawio-skill") && s.includes("load_skill 加载 html 技能"); })());

  // --- 知识库 ---
  check("knowledge base module loaded", fs.readFileSync(path.join(base, "index.html"), "utf8").includes("knowledge-base.js"));
  check("knowledge base route wired", fs.readFileSync(path.join(base, "js", "app.js"), "utf8").includes("KnowledgeBase.render"));
  check("knowledge base AI tools present", (() => { const a = fs.readFileSync(path.join(base, "server-ai.js"), "utf8"); return a.includes("query_knowledge_base") && a.includes("list_knowledge_bases"); })());
  check("knowledge base endpoints exist", (() => { const s = fs.readFileSync(path.join(base, "server.js"), "utf8"); return s.includes("/api/kb/list") && s.includes("/api/kb/query") && s.includes("kbStore"); })());
  check("kb preview renders webpage iframe", fs.readFileSync(path.join(base, "js", "knowledge-base.js"), "utf8").includes("kb-preview-frame"));
  check("web collection filters low-value urls", fs.readFileSync(path.join(base, "server.js"), "utf8").includes("isLowValueUrl"));

  // --- 网页保存为笔记 + AI 引用标注 ---
  check("web save as note wired", (() => { const k = fs.readFileSync(path.join(base, "js", "knowledge-base.js"), "utf8"); const s = fs.readFileSync(path.join(base, "server.js"), "utf8"); return k.includes("saveWebAsNote") && s.includes("/api/web/meta"); })());
  check("image block accepts svg data uri", fs.readFileSync(path.join(base, "js", "store.js"), "utf8").includes('data:image\\/[\\w.+-]+;base64'));
  check("citation refs wired", (() => { const b = fs.readFileSync(path.join(base, "js", "blocks.js"), "utf8"); const a = fs.readFileSync(path.join(base, "js", "app.js"), "utf8"); return b.includes("cite-ref") && a.includes("openCitePanel"); })());
  check("web page convert to pdf option", (() => { const a = fs.readFileSync(path.join(base, "js", "app.js"), "utf8"); return a.includes("convertWebPageToPdf") && a.includes("markdownToPrintHtml") && a.includes("转换为 PDF（网页内容）"); })());
  check("web clipper bookmarklet wired", (() => { const a = fs.readFileSync(path.join(base, "js", "app.js"), "utf8"); return a.includes("createClippedNote") && a.includes("notionish-clip") && fs.existsSync(path.join(base, "clip.html")) && fs.existsSync(path.join(base, "vendor", "readability", "Readability.js")) && fs.existsSync(path.join(base, "vendor", "turndown", "turndown.js")); })());

  // --- 联网搜索 + 网页入库 ---
  check("web search endpoints exist", (() => { const s = fs.readFileSync(path.join(base, "server.js"), "utf8"); return s.includes("/api/search") && s.includes("deepseekWebSearch") && s.includes("/api/kb/") && s.includes("/web"); })());
  check("web search AI tools wired", (() => { const a = fs.readFileSync(path.join(base, "js", "ai.js"), "utf8"); return a.includes('case "web_search"') && a.includes('case "save_web_to_kb"'); })());

  const fails = results.filter(r => !r.pass);
  console.log(results.map(r => (r.pass ? "PASS" : "FAIL") + "  " + r.name).join("\n"));
  console.log("\n" + results.length + " checks, " + fails.length + " failed");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
