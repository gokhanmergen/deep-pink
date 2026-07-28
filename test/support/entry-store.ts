/**
 * The renderer store, bundled separately. It reads `window.deepPink` at module
 * scope, so its test installs a stub bridge before requiring this.
 */
export { useStore, disposeStore } from '@renderer/store'
