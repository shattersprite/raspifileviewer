const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piscreen', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  appVersion: () => ipcRenderer.invoke('app:version'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (id, audio) => ipcRenderer.invoke('sources:choose', id, audio),
  setServer: (url) => ipcRenderer.invoke('server:set', url),
  scan: () => ipcRenderer.invoke('network:scan'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateStatus: (fn) => ipcRenderer.on('update:status', (_e, text) => fn(text)),
});
