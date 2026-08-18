/* ============ Notionish MCP protocol and browser bridge primitives ============ */
"use strict";

const BRIDGE_TIMEOUT_MS = 30000;

function schema(properties, required) {
  return { type: "object", properties: properties || {}, required: required || [] };
}

const ID = { type: "string", description: "资源 ID" };
const QUESTION_TYPES = ["single", "multiple", "judge", "fill", "short_answer"];

const TOOLS = {
  "workspace.get": {
    description: "获取本地工作区概览，包括主题、页面、题目、闪卡、模板和提醒数量。",
    inputSchema: schema(),
  },
  "workspace.update_theme": {
    description: "切换本地工作区主题。",
    inputSchema: schema({ theme: { type: "string", enum: ["light", "dark"], description: "目标主题" } }, ["theme"]),
  },
  "page.list": {
    description: "列出工作区页面；默认不包含已删除页面。",
    inputSchema: schema({ includeTrash: { type: "boolean", description: "是否包含回收站页面" } }),
  },
  "page.get": {
    description: "获取单个页面详情及其完整块树。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "page.create": {
    description: "创建普通页面、数据库页面或代码文件页面。",
    inputSchema: schema({
      parentId: { type: "string", description: "父页面 ID，缺省为 root" },
      title: { type: "string", description: "页面标题" },
      icon: { type: "string", description: "页面图标" },
      database: { type: "boolean", description: "是否创建数据库页面" },
      code: { type: "boolean", description: "是否创建代码文件页面" },
      language: { type: "string", enum: ["python", "c", "cpp", "java"], description: "代码语言" },
    }),
  },
  "page.update": {
    description: "更新页面标题、图标、封面、收藏状态或回收站状态。",
    inputSchema: schema({
      id: ID,
      title: { type: "string" },
      icon: { type: "string" },
      cover: { type: "string" },
      favorite: { type: "boolean" },
      deleted: { type: "boolean" },
      source: { type: "string", description: "代码文件的完整源代码" },
    }, ["id"]),
  },
  "page.delete": {
    description: "删除页面；默认移动到回收站，permanent=true 时彻底删除。",
    inputSchema: schema({ id: ID, permanent: { type: "boolean" } }, ["id"]),
  },
  "page.move": {
    description: "移动页面到新的父页面，并可指定同级排序值。",
    inputSchema: schema({ id: ID, parentId: { type: "string", description: "新父页面 ID 或 root" }, order: { type: "number" } }, ["id", "parentId"]),
  },
  "block.list": {
    description: "列出页面中的完整块树。",
    inputSchema: schema({ pageId: ID }, ["pageId"]),
  },
  "block.create": {
    description: "创建块。创建 question 或 flashcard 块时会同时创建独立本地实体。",
    inputSchema: schema({
      pageId: ID,
      type: { type: "string", description: "块类型" },
      text: { type: "string", description: "块的纯文本内容" },
      index: { type: "number", description: "顶层插入位置，缺省追加" },
      attrs: { type: "object", description: "块属性，如代码语言和源码" },
    }, ["pageId", "type"]),
  },
  "block.update": {
    description: "更新块的文本、类型或属性。",
    inputSchema: schema({ pageId: ID, blockId: ID, text: { type: "string" }, type: { type: "string" }, attrs: { type: "object" } }, ["pageId", "blockId"]),
  },
  "block.move": {
    description: "移动块到目标块之前、之后或内部；省略 targetId 时移动到顶层末尾。",
    inputSchema: schema({ pageId: ID, blockId: ID, targetId: ID, position: { type: "string", enum: ["before", "after", "inside"] } }, ["pageId", "blockId"]),
  },
  "block.delete": {
    description: "删除一个块。题目和闪卡的独立实体会保留。",
    inputSchema: schema({ pageId: ID, blockId: ID }, ["pageId", "blockId"]),
  },
  "block_comment.list": {
    description: "列出指定块的所有本地评论。",
    inputSchema: schema({ pageId: ID, blockId: ID }, ["pageId", "blockId"]),
  },
  "block_comment.create": {
    description: "向指定块添加本地评论。",
    inputSchema: schema({ pageId: ID, blockId: ID, text: { type: "string" } }, ["pageId", "blockId", "text"]),
  },
  "block_comment.delete": {
    description: "删除指定块的一条本地评论。",
    inputSchema: schema({ pageId: ID, blockId: ID, commentId: ID }, ["pageId", "blockId", "commentId"]),
  },
  "database_schema.get": {
    description: "获取数据库的属性 schema 和视图配置。",
    inputSchema: schema({ databaseId: ID }, ["databaseId"]),
  },
  "database_schema.update": {
    description: "整体更新数据库属性 schema 或视图配置。必须至少保留一个属性。",
    inputSchema: schema({ databaseId: ID, props: { type: "array", items: { type: "object" } }, viewState: { type: "object" } }, ["databaseId"]),
  },
  "database_row.create": {
    description: "在数据库页面中创建记录行。",
    inputSchema: schema({ databaseId: ID, title: { type: "string" } }, ["databaseId"]),
  },
  "database_row.update": {
    description: "按属性 ID 批量更新数据库记录行。",
    inputSchema: schema({ databaseId: ID, rowId: ID, props: { type: "object", description: "属性 ID 到值的映射" } }, ["databaseId", "rowId", "props"]),
  },
  "database_row.delete": {
    description: "彻底删除指定数据库中的记录行。",
    inputSchema: schema({ databaseId: ID, rowId: ID }, ["databaseId", "rowId"]),
  },
  "question.list": {
    description: "列出本地题库中的所有独立题目。",
    inputSchema: schema(),
  },
  "question.get": {
    description: "获取独立题目详情。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "question.create": {
    description: "创建独立题目，支持单选、多选、判断、填空和简答。",
    inputSchema: schema({
      type: { type: "string", enum: QUESTION_TYPES },
      prompt: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      answer: { description: "按题型提供答案：索引、数组、布尔值或文本" },
      explanation: { type: "string" },
    }, ["prompt"]),
  },
  "question.update": {
    description: "更新独立题目的任意字段。",
    inputSchema: schema({
      id: ID,
      type: { type: "string", enum: QUESTION_TYPES },
      prompt: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      answer: {},
      explanation: { type: "string" },
    }, ["id"]),
  },
  "question.delete": {
    description: "删除独立题目。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "flashcard.list": {
    description: "列出本地工作区中所有独立闪卡。",
    inputSchema: schema(),
  },
  "flashcard.get": {
    description: "获取独立闪卡详情。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "flashcard.create": {
    description: "创建独立闪卡，包含正面问题和背面答案。",
    inputSchema: schema({ front: { type: "string" }, back: { type: "string" } }, ["front", "back"]),
  },
  "flashcard.update": {
    description: "更新独立闪卡的正面或背面。",
    inputSchema: schema({ id: ID, front: { type: "string" }, back: { type: "string" } }, ["id"]),
  },
  "flashcard.delete": {
    description: "删除独立闪卡。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "template.list": {
    description: "列出本地页面模板。",
    inputSchema: schema(),
  },
  "template.create": {
    description: "创建本地页面模板。",
    inputSchema: schema({ name: { type: "string" }, data: { type: "object", description: "模板页面数据" } }, ["name"]),
  },
  "template.delete": {
    description: "删除本地页面模板。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
  "reminder.list": {
    description: "列出本地提醒。",
    inputSchema: schema(),
  },
  "reminder.create": {
    description: "创建本地提醒。",
    inputSchema: schema({ at: { type: "number", description: "Unix 毫秒时间戳" }, title: { type: "string" }, pageId: ID }, ["at"]),
  },
  "reminder.complete": {
    description: "设置提醒的完成状态。",
    inputSchema: schema({ id: ID, done: { type: "boolean" } }, ["id"]),
  },
  "reminder.delete": {
    description: "删除本地提醒。",
    inputSchema: schema({ id: ID }, ["id"]),
  },
};

function listTools() {
  return Object.entries(TOOLS).map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
}

function matchesSchema(value, spec) {
  if (!spec || !spec.type || value == null) return true;
  if (spec.type === "array") return Array.isArray(value);
  if (spec.type === "object") return typeof value === "object" && !Array.isArray(value);
  return typeof value === spec.type;
}

function validateTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: "未知 MCP 工具: " + String(name) };
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  const input = tool.inputSchema || schema();
  for (const key of input.required || []) {
    if (args[key] === undefined || args[key] === null) return { ok: false, error: "缺少必填参数: " + key };
  }
  for (const [key, spec] of Object.entries(input.properties || {})) {
    if (args[key] === undefined || args[key] === null) continue;
    if (!matchesSchema(args[key], spec)) return { ok: false, error: "参数 " + key + " 类型无效" };
    if (spec.enum && !spec.enum.includes(args[key])) return { ok: false, error: "参数 " + key + " 不在允许范围内" };
  }
  return { ok: true, tool: name, args };
}

function createBridge(options) {
  const opts = options || {};
  const token = String(opts.token || "bridge-token");
  const timeoutMs = Math.max(10, Number(opts.timeoutMs) || BRIDGE_TIMEOUT_MS);
  const pending = new Map();
  let sequence = 0;

  function enqueue(tool, args) {
    const id = "mcp_" + Date.now().toString(36) + "_" + (++sequence).toString(36);
    pending.set(id, { id, tool, args: args || {}, dispatched: false, waiters: [] });
    return { id };
  }

  function poll(candidateToken) {
    if (candidateToken !== token) return null;
    for (const request of pending.values()) {
      if (!request.dispatched) {
        request.dispatched = true;
        return { id: request.id, tool: request.tool, args: request.args };
      }
    }
    return null;
  }

  function submitResult(candidateToken, id, payload) {
    if (candidateToken !== token) return false;
    const request = pending.get(id);
    if (!request) return false;
    pending.delete(id);
    request.waiters.forEach(resolve => resolve(payload || { ok: false, error: "浏览器返回空结果" }));
    return true;
  }

  function waitResult(id) {
    return new Promise(resolve => {
      const request = pending.get(id);
      if (!request) {
        resolve({ ok: false, error: "桥接请求不存在" });
        return;
      }
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve({ ok: false, error: "浏览器桥接响应超时；请确认 Notionish 页面已通过本地服务打开且保持连接" });
      }, timeoutMs);
      request.waiters.push(result => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  return {
    token,
    enqueue,
    poll,
    submitResult,
    waitResult,
    pendingCount: () => pending.size,
  };
}

module.exports = { TOOLS, listTools, validateTool, createBridge, BRIDGE_TIMEOUT_MS };
