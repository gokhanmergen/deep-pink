import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installTauriBridge } from './tauriBridge'
import './styles/theme.css'

const root = createRoot(document.getElementById('root') as HTMLElement)

async function start(): Promise<void> {
  if (!('deepPink' in window) && '__TAURI_INTERNALS__' in window) {
    await installTauriBridge()
  }

  // App's store captures `window.deepPink` at module evaluation time. Import
  // it only after the Tauri bridge has installed that API on the window.
  const { App } = await import('./App')

  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  root.render(
    <main style={{ padding: 32, color: '#e7e5e4', background: '#0a0a0a', minHeight: '100vh' }}>
      <h1>Deep Pink could not start</h1>
      <p>{message}</p>
      <p>The local service stopped or could not be reached. Close the app and open it again.</p>
    </main>
  )
})
