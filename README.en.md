# 📝 Notionish — A Notion-Style Local-First Notes App

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/MarkSUStech/notionish)](https://github.com/MarkSUStech/notionish/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/MarkSUStech/notionish)](https://github.com/MarkSUStech/notionish/issues)
[![JavaScript](https://img.shields.io/badge/language-JavaScript-f7df1e.svg)](js/)
[![Zero dependency](https://img.shields.io/badge/zero--dependency-Yes-brightgreen.svg)](#)
[![中文 README](https://img.shields.io/badge/中文-README-blue.svg)](README.md)

A Notion-style note-taking app that runs **100% in your browser**, with **zero frontend dependencies and no backend required**. Your data lives on your own device — offline-first, exportable, and truly yours.

> **Local-first by design**: works offline, data stays with you, full export/import backup.

![Notionish screenshot](docs/screenshot.png)

## 🚀 Quick Start

**Option 1 (simplest)** — open `index.html` directly in a browser (double-click works, supports `file://`). All core features are available; only AI, code compilation/running, and MCP bridging need the local server.

**Option 2 (recommended, local server)**:
```bash
cd notionish
npx serve .
# or: python -m http.server 8080
# then visit http://localhost:3000 or http://localhost:8080
```

**Option 3 (full features)** — start the built-in zero-dependency server:
```bash
cd notionish
node server.js
# then visit http://127.0.0.1:8787
```
The server auto-detects `python`, `gcc/g++`, `javac/java` compilers for the IDE mode. Without it, options 1/2 still give you full editing.

### 🌐 Live Demo (GitHub Pages)

The frontend is zero-dependency, so it deploys directly to GitHub Pages: **https://marksustech.github.io/notionish/**

> The online demo stores data in your own browser (IndexedDB) with no backend needed. AI, code compilation/running, and MCP bridging require the local `node server.js`.

## ✨ Feature Highlights

### 1. Block Editor
| Feature | Description |
| --- | --- |
| 20+ block types | Text, H1–H3 headings, bullet/numbered lists, to-do, toggle, quote, callout, divider, code, image, embed, bookmark, file, table, sub-page, database reference |
| Slash menu | Type `/` for the block menu; keyboard navigation + filter |
| Markdown shortcuts | `# ` `## ` `- ` `1. ` `[] ` `> ` ` ` ` ` `--- ` auto-convert on space |
| Rich text formatting | Bold / italic / underline / strikethrough / inline code / links / 10 text colors / 10 background colors |
| Floating toolbar | Auto-appears when selecting text |
| Keyboard navigation | Enter splits blocks, Backspace merges, Tab/Shift+Tab indents, arrow keys move across blocks |
| Drag & drop | `⋮⋮` handle on hover → reorder, nest, multi-select delete |
| Block menu | Right-click or `⋯`: insert above/below, convert type, move up/down, duplicate, delete, move to page, copy link |
| Images/files | Upload, paste (Ctrl+V screenshot), drag-in; captions supported |

### 2. Pages
- **Unlimited nesting** with breadcrumbs
- **Sidebar tree**: expand/collapse, drag-sort, quick sub-page creation
- **Favorites** ⭐ with dedicated sidebar group
- **Trash**: restore or permanently delete (recursive)
- **Page icons**: 2000+ emoji picker
- **Covers**: 12 gradient covers or custom image

### 3. Databases (six views + advanced properties)
- **Views**: Table, Board (Kanban), List, Gallery, Calendar, Timeline (Gantt)
- **10 property types**: text, number, select, multi-select, date, checkbox, URL, **Relation**, **Rollup**, **Formula**
- **Formula engine** (no `eval`): `if / concat / round / floor / ceil / abs / max / min / length / empty / contains / lower / upper / trim / replace / toNumber / now` + `prop("name")`
- **Relations & Rollups**: cross-database links with sum/avg/count/min/max/etc.
- **Filtering & sorting**: multi-condition AND filters + multi-field sort on all views

### 4. LaTeX Math (Obsidian-style, source-as-text)
- Inline `$...$` and display `$$...$$`; click a formula to edit its source
- KaTeX rendering with an offline fallback renderer (fractions, roots, matrices, accents, Greek letters, `\text`)

### 5. Search & Data
- **Full-text search** (Ctrl+K): titles, blocks, table cells, with highlights and breadcrumbs
- **Export/Import**: whole workspace as JSON, merge-restore anytime
- **Multi-tab sync** via storage events; **auto-save** to IndexedDB + localStorage

### 6. Code IDE Mode
- VS Code-style layout: activity bar, file explorer, tabs, line-numbered editor, output panel, status bar
- Syntax highlighting for Python / C / C++ / Java
- Run code via the local server's compiler detection
- Smart input helpers: auto-pair brackets, selection wrapping, auto-indent

### 7. AI Assistant (optional, local server)
- Chat panel (Ctrl+Shift+A); AI writes notes, edits blocks, generates quizzes/flashcards, loads local skills, answers with RAG over your workspace
- **RAG retrieval** via Ollama; **LLM generation** via any OpenAI-compatible endpoint

### 8. Web Clipper
- Bookmarklet + **Chrome extension** (Obsidian-Clipper-style content extraction) → clip web pages into 待整理 as sub-pages

### 9. More
- Dark/light theme (Ctrl+\\)
- Block deep links (`#pageID-blockID`)
- Mermaid diagrams, smart tables, comments, @mentions, reminders, templates, TOC & breadcrumb blocks
- Version history + undo/redo (Ctrl+Z/Y)
- Markdown / HTML / PDF export
- Electron desktop packaging (`electron/`)

## ⌨️ Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + K` | Search |
| `Ctrl/⌘ + N` | New page |
| `Ctrl/⌘ + B / I / U` | Bold / Italic / Underline |
| `Ctrl/⌘ + S` | Save now |
| `Ctrl/⌘ + Z` / `Y` | Undo / Redo |
| `Ctrl/⌘ + \` | Toggle dark/light |
| `/` | Block menu |
| `Tab` / `Shift+Tab` | Indent / Outdent |
| `Enter` / `Shift+Enter` | New line / soft line break |

## 🔐 AI Configuration & Security

AI config lives in `ai-config.json` at the project root (read only by the local server, never exposed to the browser):

```json
{
  "ollamaUrl": "http://127.0.0.1:11434",
  "embedModel": "nomic-embed-text",
  "openaiBaseUrl": "https://api.deepseek.com",
  "openaiApiKey": "sk-xxxxxxxxxxxxxxxx",
  "openaiModel": "deepseek-chat"
}
```

> ⚠️ **Security note**: `ai-config.json` contains your real API key and **is excluded by `.gitignore` — never commit it to a public repo**. After cloning, copy `ai-config.json.example` and fill in your own key.

## 📁 Project Structure

```
├── index.html          Entry point
├── server.js           Local server (compile/run code + MCP + AI proxy, zero-dep)
├── server-mcp.js       MCP protocol & browser bridge queue
├── server-ai.js        AI RAG logic (chunking / vector index / retrieval) + config
├── css/styles.css      Design system (light/dark themes)
└── js/
    ├── util.js         Utilities (DOM, modals, emoji)
    ├── math.js         LaTeX rendering (KaTeX + offline fallback)
    ├── store.js        Data model + IndexedDB/localStorage + search
    ├── blocks.js       Block registry + rendering + rich-text serialization
    ├── editor.js       Block editor (keyboard / menus / drag / toolbar)
    ├── database.js     Database views
    ├── ide.js          Code-file IDE (edit + run)
    ├── sidebar.js      Sidebar page tree / favorites / trash
    ├── bridge.js       Browser-side MCP execution layer
    ├── ai.js           AI assistant panel (chat / index / quizzes / flashcards)
    ├── settings.js     Settings page (theme / AI config / index / data)
    └── app.js          Routing, top bar, shortcuts, import/export
```

## 🧪 Tests

```bash
node smoke-test.js      # Headless smoke: core data logic + bridge + AI logic
node server-test.js     # Server logic + MCP queue + e2e (when environment allows)
node server-ai-test.js  # AI RAG logic (chunking / cosine / index / config)
```

## 🧰 Tech Stack

- **Frontend**: vanilla JavaScript (IIFE modules + globals), no build, no bundling, no framework
- **Backend**: Node.js built-in `http` module (zero npm deps), forked sub-modules
- **Storage**: IndexedDB (primary) + localStorage (mirror), multi-tab sync
- **Vendored libs** (`vendor/`, licenses retained): KaTeX, Mermaid, Mozilla Readability, Turndown, PDF.js, lucide

## ⚠️ Honest Differences from Notion

- No real-time multi-user collaboration (data is single-device local)
- Formula engine is a curated subset (no full Notion formula language)
- Comments are single-user local records
- Version history keeps the last ~10 snapshots; undo/redo is session-scoped
- Images/PDFs/files stored as base64 in IndexedDB (larger quota than localStorage); export backups recommended

## 💾 Backup

Bottom-left **「导出」** exports everything to JSON anytime; **「导入」** merges/restores.

## 📄 License

[MIT](LICENSE) © 2025 Notionish contributors

Notion is a trademark of Notion Labs, Inc. This project is an independent creation with no affiliation to Notion.
