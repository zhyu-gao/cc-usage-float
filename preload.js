'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getInitialState: () => ipcRenderer.invoke('state:get'),
  getUsage: (preset) => ipcRenderer.invoke('usage:get', preset),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  toggle: () => ipcRenderer.send('window:toggle'),
  setRange: (preset) => ipcRenderer.send('range:set', preset),
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  setOpacity: (v) => ipcRenderer.send('opacity:set', v),
  setAlwaysOnTop: (v) => ipcRenderer.send('ontop:set', v),
  setRefreshSeconds: (s) => ipcRenderer.send('refresh-interval:set', s),
  dragStart: (payload) => ipcRenderer.send('drag:start', payload),
  dragEnd: () => ipcRenderer.send('drag:end'),
  showMenu: () => ipcRenderer.send('menu:show'),
  onState: (cb) => on('state', cb),
});
