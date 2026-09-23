import type { DeepPinkApi } from './api'

declare global {
  interface Window {
    deepPink: DeepPinkApi
  }
}

export {}
