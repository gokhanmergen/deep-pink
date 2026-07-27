import type { DeepPinkApi } from './index'

declare global {
  interface Window {
    deepPink: DeepPinkApi
  }
}

export {}
