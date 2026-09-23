import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  root: rendererRoot,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    {
      name: 'remove-electron-csp',
      transformIndexHtml(html) {
        // Tauri's configured CSP includes its authenticated local service and
        // is injected into the bundled page. Electron keeps its own narrower
        // meta policy from the shared index.html.
        return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/?>/i, '')
      }
    }
  ],
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': resolve(rendererRoot, 'src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    host: 'localhost',
    port: 1420,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'dist/tauri'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(rendererRoot, 'index.html') }
  }
})
