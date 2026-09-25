import { useEffect, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, X, Zap } from 'lucide-react'
import type { Settings } from '@shared/types'

export function QuickQuestion(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [question, setQuestion] = useState('')
  const [sentQuestion, setSentQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const requestId = useRef(0)
  const isOpen = useRef(true)

  useEffect(() => {
    let mounted = true
    const focus = (): void => requestAnimationFrame(() => input.current?.focus())
    const removeContent = window.deepPink.quickQuestion.onContent((content) => {
      if (isOpen.current) setAnswer(content)
    })
    const removeOpened = window.deepPink.quickQuestion.onOpened(() => {
      isOpen.current = true
      requestId.current++
      window.deepPink.quickQuestion.cancel()
      setQuestion('')
      setSentQuestion('')
      setAnswer('')
      setError('')
      setLoading(false)
      focus()
    })
    const removeHidden = window.deepPink.quickQuestion.onHidden(() => {
      isOpen.current = false
      requestId.current++
      window.deepPink.quickQuestion.cancel()
      setLoading(false)
    })
    void window.deepPink.settings.get().then((next) => {
      if (!mounted) return
      setSettings(next)
      document.documentElement.style.setProperty('--accent', next.ui.accent)
      focus()
    })
    return () => {
      mounted = false
      removeContent()
      removeOpened()
      removeHidden()
    }
  }, [])

  const ask = async (): Promise<void> => {
    const text = question.trim()
    if (!text || loading) return
    const currentRequest = ++requestId.current
    setSentQuestion(text)
    setAnswer('')
    setError('')
    setLoading(true)
    try {
      const result = await window.deepPink.quickQuestion.ask(text)
      if (requestId.current === currentRequest) setAnswer(result)
    } catch (cause) {
      if (requestId.current === currentRequest) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestId.current === currentRequest) setLoading(false)
    }
  }

  const startAgain = (): void => {
    setQuestion('')
    setSentQuestion('')
    setAnswer('')
    setError('')
    input.current?.focus()
  }

  return (
    <div
      className="quick-question"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          window.close()
        }
      }}
    >
      <header className="quick-question__head">
        <div className="quick-question__brand"><Zap size={17} /><span>Quick Question</span></div>
        <button
          className="btn btn--ghost quick-question__close"
          onClick={() => window.close()}
          type="button"
          aria-label="Close Quick Question"
          title="Close · Escape"
        >
          <X size={17} />
        </button>
      </header>

      <main className="quick-question__body">
        <label className="quick-question__label" htmlFor="quick-question-input">
          {sentQuestion ? 'Question' : 'What do you need to know?'}
        </label>
        <textarea
          id="quick-question-input"
          ref={input}
          className="textarea quick-question__input"
          rows={2}
          value={question}
          placeholder="Ask something…"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void ask()
            }
          }}
        />

        <div className="quick-question__actions">
          {loading ? (
            <button
              className="btn"
              onClick={() => window.deepPink.quickQuestion.cancel()}
              type="button"
            >
              Stop
            </button>
          ) : answer || error ? (
            <button className="btn" onClick={startAgain} type="button">Ask another</button>
          ) : null}
          {!loading && !answer && !error && (
            <button
              className="btn btn--primary"
              onClick={() => void ask()}
              disabled={!question.trim()}
              type="button"
            >
              Ask <ArrowUp size={15} />
            </button>
          )}
        </div>

        {(loading || answer || error) && (
          <section className="quick-question__result" aria-live="polite">
            {sentQuestion && <div className="quick-question__asked">{sentQuestion}</div>}
            {loading && !answer && (
              <div className="quick-question__thinking"><LoaderCircle size={15} /> Thinking…</div>
            )}
            {answer && <p className="quick-question__answer">{answer}</p>}
            {error && <p className="quick-question__error">{error}</p>}
          </section>
        )}
      </main>

      <footer className="quick-question__foot">
        <span>Enter to ask · Shift+Enter for a new line</span>
        {settings && <span className="quick-question__model">{settings.quickQuestion.model}</span>}
      </footer>
    </div>
  )
}
