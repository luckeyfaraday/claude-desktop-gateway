const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  getLogs: () => ipcRenderer.invoke("get-logs"),
  saveSettings: (patch) => ipcRenderer.invoke("save-settings", patch),
  signIn: () => ipcRenderer.invoke("sign-in"),
  configure: () => ipcRenderer.invoke("configure"),
  restore: () => ipcRenderer.invoke("restore"),
  startGateway: () => ipcRenderer.invoke("start-gateway"),
  stopGateway: () => ipcRenderer.invoke("stop-gateway"),
  onLog: (cb) => ipcRenderer.on("log", (_event, line) => cb(line)),
  onState: (cb) => ipcRenderer.on("state", (_event, state) => cb(state)),
});
