const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piscreen', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  appVersion: () => ipcRenderer.invoke('app:version'),
  computerName: () => ipcRenderer.invoke('app:computer-name'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (id, audio) => ipcRenderer.invoke('sources:choose', id, audio),
  setServer: (url) => ipcRenderer.invoke('server:set', url),
  setTokens: (patch) => ipcRenderer.invoke('tokens:set', patch),
  scan: () => ipcRenderer.invoke('network:scan'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateStatus: (fn) => ipcRenderer.on('update:status', (_e, text) => fn(text)),
  minimize: () => ipcRenderer.send('window:minimize'),

  // Floating toolbar shown while sharing
  showToolbar: (show) => ipcRenderer.send('toolbar:show', show),
  sendToolbarState: (state) => ipcRenderer.send('toolbar:state', state),
  onToolbarState: (fn) => ipcRenderer.on('toolbar:state', (_e, state) => fn(state)),
  toolbarAction: (action) => ipcRenderer.send('toolbar:action', action),
  onToolbarAction: (fn) => ipcRenderer.on('toolbar:action', (_e, action) => fn(action)),
});
