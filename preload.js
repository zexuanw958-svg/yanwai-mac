'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel, callback) => {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('yanwai', {
  getState: call('state:get'), setMode: call('panel:mode'), setPlacement: call('panel:placement'),
  setFollowing: call('clipboard:follow'), setSource: call('input:source'),
  fillReply: call('reply:fill'), openPermission: call('permissions:open'), setBackend: call('model:set'),
  readClipboard: call('clipboard:read'), copyReply: call('clipboard:copy'),
  analyze: call('model:analyze'), getLocalHealth: call('model:health'), quit: call('app:quit'),
  getCloud: call('cloud:get'), saveCloud: call('cloud:save'), testCloud: call('cloud:test'), checkDraft: call('draft:check'),
  getPermissions: call('permissions:status'), requestPermission: call('permissions:request'), relaunch: call('app:relaunch'),
  onState: callback => subscribe('state:changed', callback),
  onText: callback => subscribe('input:text', callback),
  onGuide: callback => subscribe('guide:show', callback),
});
