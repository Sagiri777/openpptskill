import { contextBridge } from "electron";

// Deliberately exposes no filesystem or process primitive. Project access is
// granted by the user through Chromium's File System Access API.
contextBridge.exposeInMainWorld("neoDeckDesktop", Object.freeze({
  platform: process.platform,
  desktop: true,
}));
