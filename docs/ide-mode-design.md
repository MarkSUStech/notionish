# IDE Mode Design

## Understanding

- Add a third page kind, "代码文件", alongside "页面" and "数据库".
- A code file opens as a full-page IDE: language selector, code editor, run/stop buttons, output panel.
- Supported languages: Java, Python, C++, C.
- Code runs through a new local Node.js service that detects and invokes native compilers and interpreters.
- Multi-file projects reuse the sidebar page tree; running the top-level file includes its descendant code files.
- The browser remains the source of truth; the service materializes files into a temporary directory only at run time.

## Design

### Data model

- `newPage` gains `code: boolean` and `codeData: { language, source }`.
- `Store.collectCodeProject(pageId)` walks the subtree of a code file page and returns a flat file list. Each file gets a name of `{title}.{ext}` with the extension derived from its language; collisions are disambiguated. The entry file is the page being run.

### Runner service

- A zero-dependency Node script (`server.js`) serves the static app and exposes:
  - `GET /api/compilers` — detect compilers per language.
  - `POST /api/run` — materialize files, compile and run, stream output; returns a run id header.
  - `POST /api/run/:id/cancel` — terminate the run's process tree.
- Compiler detection scans `PATH` and common install roots, validating candidates with `--version`. Absent compilers yield empty lists.
- Execution defaults to a 30 second timeout and an output cap. It binds only to `127.0.0.1`.

### Frontend

- New `js/ide.js` renders the IDE, persists the source on input, and talks to `/api/run`.
- Creation entry points: sidebar "+" opens a three-way chooser, home adds a "代码文件" button, and the slash menu gains a "代码文件" item.
- Without the runner service the editor still works; running shows a hint to start `node server.js`.

## Decision Log

- Use a local zero-dependency runner instead of a browser-only runtime so native Java/Python/C/C++ toolchains work.
- Reuse the page tree as the project structure instead of a second file system.
- Flatten descendant files into the temporary project root for compilation; directory layout stays a future enhancement.
- Keep run output in memory and out of persisted storage.
- Enforce timeouts, output limits, and process-tree termination on the server.

## Testing

- Store logic: code page creation and project file collection.
- Server: pure command and file-list construction helpers, plus compiler detection and Python execution when the environment allows.
- Browser: IDE rendering, source persistence, and the graceful no-service state.
