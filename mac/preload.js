// Fenêtre du Mac : un petit pont vers le processus principal (octets du partage d'écran, presse-papiers).
// La fenêtre ne choisit pas où elle se connecte : c'est le Mac choisi dans Brume.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let handler = null;
ipcRenderer.on('mac:evt', (_e, type, data) => { if (handler) handler(type, data); });
contextBridge.exposeInMainWorld('brumeMac', {
  init: () => ipcRenderer.invoke('mac:init'),
  connect: () => ipcRenderer.invoke('mac:connect'),
  send: (bytes) => { if (bytes instanceof Uint8Array) ipcRenderer.send('mac:send', bytes); },
  disconnect: () => ipcRenderer.send('mac:disconnect'),
  on: (fn) => { handler = typeof fn === 'function' ? fn : null; },
  action: (a) => ipcRenderer.send('mac:action', String(a)),
  pref: (p) => ipcRenderer.send('mac:pref', { ctrlCmd: !!(p && p.ctrlCmd) }),
  clipRead: () => ipcRenderer.invoke('mac:clip-read'),
  clipWrite: (t) => ipcRenderer.send('mac:clip-write', String(t || ''))
});
