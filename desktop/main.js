import { app, BrowserWindow, shell } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startEditorServer } from "../lib/editor-server.js";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
let editorServer;

async function createWindow() {
  const started = await startEditorServer({ port: 0 });
  editorServer = started.server;
  const allowedOrigin = new URL(started.url).origin;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: "#eef0f3",
    title: "NeoDeck Local",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(desktopRoot, "preload.js"),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  await window.loadURL(started.url);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  editorServer?.close();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
