/* ============ I18n — 轻量国际化（中文即 key，切换后刷新重渲染） ============ */
(function (global) {
  "use strict";

  const LS_KEY = "notionish_lang";

  const DICT = {
    // ── 顶栏 / 侧栏 ──
    "折叠侧边栏": "Collapse sidebar",
    "新建页面 (Ctrl+N)": "New page (Ctrl+N)",
    "搜索… (Ctrl+K)": "Search… (Ctrl+K)",
    "⭐ 收藏": "⭐ Favorites",
    "🗄 知识库": "🗄 Knowledge Base",
    "新建知识库": "New knowledge base",
    "▼ 私人页面": "▼ Private Pages",
    "🗑 回收站": "🗑 Trash",
    "题库图谱": "Question Bank",
    "🗺 题库": "🗺 Questions",
    "导入 JSON": "Import JSON",
    "导入": "Import",
    "导出全部为 JSON": "Export all as JSON",
    "导出": "Export",
    "切换主题": "Toggle theme",
    "🌙 深色": "🌙 Dark",
    "☀️ 浅色": "☀️ Light",
    "菜单": "Menu",

    // ── 通用按钮 ──
    "确定": "OK",
    "取消": "Cancel",
    "保存": "Save",
    "删除": "Delete",
    "编辑": "Edit",
    "复制": "Copy",
    "关闭": "Close",
    "搜索": "Search",
    "全部": "All",
    "更多": "More",
    "完成": "Done",

    // ── 块操作菜单 ──
    "上方插入块": "Insert block above",
    "下方插入块": "Insert block below",
    "转换为": "Turn into",
    "上移": "Move up",
    "下移": "Move down",
    "复制块链接": "Copy block link",
    "移至其他页面": "Move to page",
    "插入上/下方": "Insert above/below",
    "删除此块": "Delete this block",
    "拖拽移动 (右键更多操作)": "Drag to move (right-click for more)",
    "在下方插入块": "Insert block below",
    "拖拽排序 / 点击选中": "Drag to reorder / click to select",

    // ── 斜杠菜单 / 块类型 ──
    "基础": "Basic",
    "媒体": "Media",
    "高级": "Advanced",
    "数据": "Data",
    "正文": "Text",
    "标题 1": "Heading 1",
    "标题 2": "Heading 2",
    "标题 3": "Heading 3",
    "无序列表": "Bulleted list",
    "有序列表": "Numbered list",
    "待办事项": "To-do",
    "折叠列表": "Toggle list",
    "引用": "Quote",
    "提示框": "Callout",
    "分割线": "Divider",
    "代码": "Code",
    "图片": "Image",
    "公式": "Equation",
    "图表": "Mermaid",
    "交互网页": "Embed",
    "书签": "Bookmark",
    "文件": "File",
    "表格": "Table",
    "子页面": "Sub-page",
    "数据库引用": "DB reference",
    "行内公式": "Inline math",
    "大标题": "Big heading",
    "中标题": "Medium heading",
    "小标题": "Small heading",
    "圆点列表": "Bulleted list",
    "数字列表": "Numbered list",
    "带复选框的任务": "Task with checkbox",
    "可展开/收起的块": "Expandable/collapsible block",
    "引用文字": "Quote text",
    "带图标的强调块": "Emphasis block with icon",
    "水平分割线": "Horizontal divider",
    "代码块（支持语法高亮）": "Code block (syntax highlighted)",
    "输入文字…": "Type…",
    "输入…": "Type…",
    "列表项": "List item",
    "标题": "Heading",
    "待办": "To-do",
    "普通文本": "Plain text",
    "嵌入": "Embed",
    "嵌入网页 (iframe)": "Embed web page (iframe)",
    "嵌入 PDF 文档": "Embed PDF document",
    "引用高亮": "Highlight",
    "PDF 荧光笔引用": "PDF highlighter quote",
    "引用图片": "Quote image",
    "PDF 图片引用": "PDF image quote",
    "网页书签": "Web bookmark",
    "上传文件": "Upload file",
    "简易表格": "Simple table",
    "LaTeX 行间公式": "LaTeX display equation",
    "Mermaid 图表": "Mermaid diagram",
    "可交互 HTML（可视化教学）": "Interactive HTML (visual teaching)",
    "嵌入的子页面": "Embedded sub-page",
    "数据库页面": "Database page",
    "代码片段": "Code snippet",
    "可关联代码文件的笔记片段": "Note snippet linked to code file",
    "独立保存的练习题": "Standalone exercise",
    "正面/背面记忆卡": "Front/back flashcard",
    "自动生成标题目录": "Auto table of contents",
    "模板按钮": "Template button",
    "一键插入模板内容": "One-click insert template",
    "显示当前页面路径": "Show page breadcrumb",
    "分栏": "Columns",
    "多栏布局（2/3/4 栏）": "Multi-column layout (2/3/4)",
    "栏": "Column",
    "任务列表": "Task list",
    "可展开的块": "Expandable block",
    "水平线": "Horizontal line",
    "上传 / 输入 URL": "Upload / enter URL",
    "网页 iframe": "Web iframe",
    "网页链接": "Web link",
    "3 列表格": "3-column table",
    "代码块": "Code block",
    "单选、多选、填空、判断、简答": "Single, multiple, fill, judge, short answer",
    "LaTeX 行内公式": "LaTeX inline math",
    "显示页面路径": "Show page path",
    "多栏布局（2/3/4 栏）": "Multi-column layout (2/3/4)",
    "新建嵌入页面": "New embedded page",
    "新建数据库页面": "New database page",
    "新建可运行代码文件": "New runnable code file",
    "链接到页面": "Link to page",
    "引用已有页面": "Reference existing page",
    "上传或粘贴图片": "Upload or paste image",
    "嵌入网页 (iframe)": "Embed web (iframe)",

    // ── 编辑器提示 ──
    "输入文字…": "Type…",
    "展开/折叠": "Expand / collapse",
    "切换完成状态": "Toggle done",
    "点击更换图标": "Click to change icon",
    "点击上传图片": "Click to upload image",
    "显示答案": "Show answer",
    "隐藏答案": "Hide answer",
    "暂无记忆，AI 会在这里保存重要信息。": "No memories yet. AI will save important info here.",

    // ── 搜索 ──
    "无结果": "No results",
    "输入关键词搜索": "Type to search",

    // ── 回收站 ──
    "恢复": "Restore",
    "彻底删除": "Delete forever",
    "清空回收站": "Empty trash",

    // ── AI 面板 ──
    "✦ AI 助手": "✦ AI Assistant",
    "AI 助手 (Ctrl+Shift+A)": "AI Assistant (Ctrl+Shift+A)",
    "输入问题…": "Ask anything…",
    "输入问题，或选择上方工具…": "Ask anything, or pick a tool above…",
    "发送": "Send",
    "正在思考…": "Thinking…",
    "（无回复）": "(no reply)",
    "工具": "Tools",
    "知识库": "Knowledge Base",
    "风格": "Style",
    "考试": "Exam",
    "笔记": "Note",
    "可视化": "Visualize",
    "研究": "Research",
    "出试卷": "Create exam",
    "新增笔记": "New note",
    "研究（搜索→知识库）": "Research (search → KB)",
    "连接中…": "Connecting…",
    "重建全部索引": "Rebuild all indexes",
    "重建索引": "Rebuild index",
    "已就绪 · 索引": "Ready · index",
    "段": "chunks",
    "未配置 · 点 ⚙ 设置": "Not configured · click ⚙",
    "本地服务未启动": "Local server not running",
    "暂无知识库": "No knowledge bases",
    "加载失败": "Failed to load",
    "标准风格": "Standard style",
    "已应用 ✓": "Applied ✓",
    "已批准，正在执行…": "Approved, executing…",
    "已取消": "Cancelled",
    "未能解析出结构化内容，请重试。": "Could not parse structured content, please retry.",
    "生成笔记": "Generate note",
    "请输入要生成笔记的主题 / 知识点": "Enter a topic / knowledge point to generate",
    "选择块类型": "Choose block type",
    "设置": "Settings",
    "关闭": "Close",
    "生成中…": "Generating…",
    "生成": "Generate",

    // ── 设置页 ──
    "设置": "Settings",
    "长期记忆": "Long-term Memory",
    "查看和维护 AI 助手保存的全部长期记忆。": "View and manage long-term memories saved by the AI assistant.",
    "🧠 打开记忆": "🧠 Open Memory",
    "外观": "Appearance",
    "选择应用主题（快捷键 Ctrl+\\）。": "Choose app theme (shortcut Ctrl+\\)",
    "布局": "Layout",
    "调整页面内容宽度与正文行间距。": "Adjust page width and line spacing.",
    "页宽": "Page width",
    "窄": "Narrow",
    "标准": "Standard",
    "宽": "Wide",
    "全宽": "Full width",
    "行间距": "Line height",
    "紧凑": "Compact",
    "宽松": "Relaxed",
    "极宽": "Extra wide",
    "字体": "Font",
    "默认": "Default",
    "黑体": "Hei",
    "宋体": "Song",
    "楷体": "Kai",
    "衬线": "Serif",
    "等宽": "Mono",
    "字号": "Font size",
    "小": "Small",
    "较小": "Smaller",
    "较大": "Larger",
    "大": "Large",
    "特大": "Extra large",
    "AI 助手": "AI Assistant",
    "检索走 Ollama（可在另一台机器上），生成走 OpenAI 兼容接口。API Key 只保存在本机服务端 ai-config.json，不会进入浏览器。": "Embedding uses Ollama (can run on another machine); generation uses an OpenAI-compatible endpoint. The API key stays in the local server's ai-config.json, never in the browser.",
    "Ollama 地址": "Ollama URL",
    "Embedding 模型": "Embedding model",
    "OpenAI 模型名": "OpenAI model",
    "OpenAI API Key": "OpenAI API Key",
    "已配置（留空则保持不变）": "Configured (leave empty to keep)",
    "索引状态加载中…": "Loading index status…",
    "AI 已就绪 · 索引": "AI ready · index",
    "未配置 API Key": "API key not configured",
    "保存 AI 配置": "Save AI config",
    "保存失败：": "Save failed: ",
    "。请确认已用 node server.js 启动并刷新页面": ". Make sure the local server is running and refresh.",
    "已保存 AI 配置": "AI config saved",
    "保存失败：无法连接本地服务，请用 node server.js 启动后重试": "Save failed: cannot reach local server, start it and retry",
    "🔄 重建索引": "🔄 Rebuild index",
    "数据": "Data",
    "导出全部数据为 JSON，或从备份导入合并恢复。": "Export all data as JSON, or import a backup to merge/restore.",
    "⬇️ 导出数据": "⬇️ Export data",
    "⬆️ 导入数据": "⬆️ Import data",

    // ── 题库图谱 ──
    "题库图谱": "Question Bank Graph",
    "重新布局": "Re-layout",
    "重算关联": "Recompute links",
    "拖拽节点移动 · 滚轮缩放 · 拖拽空白平移": "Drag nodes · scroll to zoom · drag empty space to pan",
    "暂无题目。在页面里用 AI「生成题目」，或插入「题目」块后，这里会显示题目知识图谱。": "No questions yet. Ask AI to generate questions or insert a Question block, and the knowledge graph will appear here.",
    "0 道题目": "0 questions",
    "计算关联中…": "Computing links…",
    "条关联": "links",
    "关联不可用：": "Links unavailable: ",
    "参考答案：": "Answer: ",
    "解析：": "Explanation: ",
    "显示答案": "Show answer",
    "隐藏答案": "Hide answer",
    "对": "True",
    "错": "False",
    "单选": "Single choice",
    "多选": "Multiple choice",
    "判断": "True/False",
    "填空": "Fill blank",
    "简答": "Short answer",

    // ── 知识库 ──
    "新建知识库": "New knowledge base",
    "知识库名称": "Knowledge base name",
    "已创建知识库": "Knowledge base created",
    "创建失败：": "Create failed: ",
    "添加网址": "Add URL",
    "删除记忆": "Delete memory",

    // ── 记忆页 ──
    "请求失败：": "Request failed: ",
    "从未": "Never",
    "未知": "Unknown",
    "正在加载记忆…": "Loading memories…",
    "记忆": "Memory",
    "这里汇总 AI 助手的全部长期记忆。修改后会同步用于近期提示和按需检索。": "All long-term memories saved by the AI assistant. Edits sync into recent prompts and on-demand retrieval.",
    "＋ 添加记忆": "＋ Add memory",
    "条长期记忆": "memories",
    "还没有长期记忆。点击“添加记忆”创建第一条。": "No memories yet. Click “Add memory” to create the first one.",
    "记忆正文": "Memory text",
    "创建于": "Created",
    "最近访问": "Last accessed",
    "重要性": "Importance",
    "记忆重要性": "Memory importance",
    "低": "Low",
    "高": "High",
    "记忆加载失败：": "Failed to load memories: ",
    "重试": "Retry",
    "新记忆": "New memory",
    "已添加记忆": "Memory added",
    "已添加记忆；向量索引暂未同步": "Memory added; vector index not synced yet",
    "添加失败：": "Add failed: ",
    "记忆正文不能为空": "Memory text cannot be empty",
    "记忆已保存": "Memory saved",
    "记忆已保存；向量索引暂未同步": "Memory saved; vector index not synced yet",
    "删除记忆": "Delete memory",
    "确定永久删除这条长期记忆吗？此操作不可撤销。": "Permanently delete this memory? This cannot be undone.",
    "记忆已删除": "Memory deleted",
    "删除失败：": "Delete failed: ",

    // ── 记忆（旧 key 兼容） ──
    "🧠 长期记忆": "🧠 Long-term Memory",
    "暂无记忆": "No memories yet",

    // ── 剪藏 ──
    "输入要剪藏的网页 URL：": "Enter URL to clip:",
    "剪藏失败: ": "Clip failed: ",
    "剪藏": "Clip",

    // ── 数据库 ──
    "添加行": "Add row",
    "新建记录": "New record",
    "名称": "Name",
    "状态": "Status",
    "优先级": "Priority",
    "负责人": "Owner",
    "截止日期": "Due date",
    "进度": "Progress",

    // ── 页面 ──
    "未命名": "Untitled",
    "新建子页面": "New sub-page",
    "移入回收站": "Move to trash",
    "删除页面": "Delete page",
    "重命名": "Rename",
    "复制页面": "Duplicate page",
    "收藏": "Favorite",
    "取消收藏": "Unfavorite",

    // ── 右键菜单/页面菜单 ──
    "打开页面": "Open page",
    "设置提醒": "Set reminder",
    "版本历史": "Version history",
    "导出为 Markdown": "Export as Markdown",
    "导出为 HTML": "Export as HTML",
    "打印 / 导出 PDF": "Print / Export PDF",
    "添加封面": "Add cover",
    "更换图标": "Change icon",
    "评论区": "Comments",

    // ── 通用提示 ──
    "已复制": "Copied",
    "已保存": "Saved",
    "确认": "Confirm",
    "取消操作": "Cancel",
    "加载中…": "Loading…",
    "出错": "Error",
    "已恢复": "Restored",
    "此页面": "this page",
    "此操作不可撤销。": "This cannot be undone.",
    "重命名页面": "Rename page",
    "页面名称": "Page name",
    "设为收藏": "Add to favorites",
    "已复制页面": "Page duplicated",
    "移至…": "Move to…",
    "导出为 JSON": "Export as JSON",
    "页面": "Page",
    "已导出": "Exported",
    "已导出 Markdown": "Exported Markdown",
    "已导出 HTML": "Exported HTML",
    "保存为笔记（抓取正文）": "Save as note (extract text)",
    "转换为 PDF（网页内容）": "Convert to PDF (web content)",
    "设置提醒": "Set reminder",
    "版本历史": "Version history",
    "保存为模板": "Save as template",
    "未命名模板": "Untitled template",
    "已保存为模板": "Template saved",
    "将": "Move ",
    "移到回收站？": " to trash?",
    "移到回收站": "Move to trash",
    "已移入回收站": "Moved to trash",
    "新建数据库": "New database",
    "新建代码文件": "New code file",
    "新建网页": "New web page",
    "新建 PDF": "New PDF",
    "在页面下新建子页面": "New sub-page under this page",
    "更多操作": "More actions",
    "拖拽排序": "Drag to reorder",
    "未命名页面": "Untitled page",
  };

  const I18n = {
    lang: "zh",
    getDict() { return DICT; },
    /** 翻译：中文即 key，找不到返回原文 */
    t(s) {
      if (this.lang === "zh") return s;
      if (typeof s !== "string" || !s) return s;
      return DICT[s] || s;
    },
    /** 批量翻译对象字段（如 attrs） */
    map(o) {
      if (typeof o !== "object" || o === null) return o;
      const r = {};
      for (const k in o) r[k] = this.t(o[k]);
      return r;
    },
    setLang(l) {
      this.lang = l === "en" ? "en" : "zh";
      try { localStorage.setItem(LS_KEY, this.lang); } catch (e) {}
      document.documentElement.setAttribute("lang", this.lang === "zh" ? "zh-CN" : "en");
    },
    init() {
      try {
        const saved = localStorage.getItem(LS_KEY);
        this.lang = saved === "en" ? "en" : "zh";
      } catch (e) {}
      document.documentElement.setAttribute("lang", this.lang === "zh" ? "zh-CN" : "en");
      return this;
    },
    /** 切换语言（刷新重渲染） */
    toggle() {
      this.setLang(this.lang === "zh" ? "en" : "zh");
      location.reload();
    },
    /** 翻译静态 DOM 的 title/placeholder/文本（用于 index.html 等静态标记） */
    applyToDom(root) {
      if (this.lang === "zh") return;
      root = root || document;
      root.querySelectorAll("[title],[placeholder],[data-ph]").forEach(el => {
        if (el.getAttribute("title")) el.setAttribute("title", this.t(el.getAttribute("title")));
        if (el.getAttribute("placeholder")) el.setAttribute("placeholder", this.t(el.getAttribute("placeholder")));
        if (el.getAttribute("data-ph")) el.setAttribute("data-ph", this.t(el.getAttribute("data-ph")));
      });
      root.querySelectorAll(".sb-section-title,.sb-footer-btn,.sb-brand").forEach(el => {
        if (el.childElementCount === 0 && el.textContent.trim()) {
          const tr = this.t(el.textContent.trim());
          if (tr !== el.textContent.trim()) el.textContent = tr;
        }
      });
    },
  };

  global.I18n = I18n;
  if (!global.U) global.U = {};
  global.U.t = function (s) { return I18n.t(s); };
})(window);