/* ============ Notionish Electron Preload ============ */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 剪藏
  onClipUrl: (callback) => {
    ipcRenderer.on("clip-url", (event, url) => callback(url));
  },
  clipUrl: (url) => ipcRenderer.invoke("clip-url", url),
  // 窗口控制
  winMinimize: () => ipcRenderer.send("win-minimize"),
  winMaximize: () => ipcRenderer.send("win-maximize"),
  winClose: () => ipcRenderer.send("win-close"),
  winIsMaximized: () => ipcRenderer.invoke("win-is-maximized"),
  onWinState: (callback) => {
    ipcRenderer.on("win-state", (event, state) => callback(state));
  },
  // 平台信息
  platform: process.platform,
});