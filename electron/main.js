/* ============ Notionish Electron Main Process ============ */
const { app, BrowserWindow, dialog, ipcMain, globalShortcut, Menu, Tray, clipboard, shell } = require("electron");
const path = require("path");
const { fork } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 8787;
let mainWindow = null;
let serverProcess = null;

// ---- 启动 server.js（子进程，避免阻塞 Electron） ----
function startServer() {
  return new Promise((resolve, reject) => {
    const dataDir = path.join(app.getPath("userData"), "notionish-data");
    require("fs").mkdirSync(dataDir, { recursive: true });
    serverProcess = fork(path.join(ROOT, "server.js"), [], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(DEFAULT_PORT), NOTIONISH_DATA_DIR: dataDir },
      silent: true,
    });
    serverProcess.stdout.on("data", d => console.log("[server]", d.toString().trim()));
    serverProcess.stderr.on("data", d => console.error("[server:err]", d.toString().trim()));
    serverProcess.on("error", reject);
    // 等待 server 就绪
    const check = () => {
      const http = require("http");
      http.get(`http://127.0.0.1:${DEFAULT_PORT}/`, res => {
        res.resume();
        resolve();
      }).on("error", () => setTimeout(check, 200));
    };
    setTimeout(check, 500);
  });
}

// ---- 创建主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    title: "Notionish",
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${DEFAULT_PORT}/`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 外部链接在默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---- 剪藏 URL 对话框 ----
async function clipFromUrl() {
  if (!mainWindow) return;
  const { response, url } = await dialog.showInputDialog(mainWindow, {
    title: "剪藏网页",
    label: "输入网页 URL：",
    placeholder: "https://example.com/article",
    okLabel: "剪藏",
    cancelLabel: "取消",
    width: 500,
  });
  if (!response || !url) return;

  // 通过 IPC 通知渲染进程剪藏
  mainWindow.webContents.send("clip-url", url.trim());
}

// ---- 从剪贴板剪藏 ----
async function clipFromClipboard() {
  const text = clipboard.readText().trim();
  if (!text) return;
  if (/^https?:\/\//i.test(text)) {
    if (!mainWindow) return;
    mainWindow.webContents.send("clip-url", text);
  }
}

// ---- 菜单 ----
function buildMenu() {
  const template = [
    {
      label: "Notionish",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "剪藏 URL…", accelerator: "CmdOrCtrl+Shift+C", click: clipFromUrl },
        { label: "从剪贴板剪藏", accelerator: "CmdOrCtrl+Shift+V", click: clipFromClipboard },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "close" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  buildMenu();

  // 注册全局快捷键
  globalShortcut.register("CmdOrCtrl+Shift+C", clipFromUrl);
  globalShortcut.register("CmdOrCtrl+Shift+V", clipFromClipboard);

  // 启动 server
  console.log("Starting Notionish server...");
  await startServer();
  console.log("Server ready");

  // 创建窗口
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  if (serverProcess) serverProcess.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProcess) serverProcess.kill();
});

// IPC: 窗口控制
ipcMain.on("win-minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on("win-maximize", () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.on("win-close", () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle("win-is-maximized", () => mainWindow ? mainWindow.isMaximized() : false);

// 监听最大化/还原状态变化，通知渲染进程更新按钮图标
app.on("browser-window-created", (e, win) => {
  win.on("maximize", () => win.webContents.send("win-state", "maximized"));
  win.on("unmaximize", () => win.webContents.send("win-state", "normal"));
});

// IPC: 渲染进程可以请求剪藏 URL
ipcMain.handle("clip-url", async (event, url) => {
  try {
    const http = require("http");
    const body = JSON.stringify({ url });
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: DEFAULT_PORT,
        path: "/api/web/meta",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve({ markdown: data }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    return { error: e.message };
  }
});