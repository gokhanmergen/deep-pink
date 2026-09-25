import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickQuestion } from './QuickQuestion'
import './styles/theme.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QuickQuestion />
  </StrictMode>
)
