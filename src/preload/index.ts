import { contextBridge, ipcRenderer } from 'electron'
import { createDeepPinkApi } from './api'

const api = createDeepPinkApi(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => ipcRenderer.on(channel, listener),
    removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener)
  },
  process.platform,
  Boolean(process.env.DEEP_PINK_NO_WIZARD)
)

contextBridge.exposeInMainWorld('deepPink', api)
