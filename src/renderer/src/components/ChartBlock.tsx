import { Component, useState, type ReactNode } from 'react'
import { Code2, Eye } from 'lucide-react'
import type { ParsedChart } from '@shared/charts'
import { ICON } from '../icons'
import { CodeBlock } from './CodeBlock'
import { ChartFigure } from './ChartFigures'

/**
 * One chart in a reply: the chrome around it, the switch back to its source,
 * and the guarantee that it cannot take the transcript down with it.
 *
 * A chart is drawn from data the parser has already validated, but a component
 * can still be handed a shape it did not expect — an empty series, a scale of
 * zero — and a reply that renders as a blank page because one chart divided by
 * nothing would be the worst outcome here. The boundary below turns any such
 * failure back into the code the model actually wrote.
 */

interface Props {
  parsed: ParsedChart
  /** The JSON as it arrived, for the source view and the fallback. */
  source: string
  codeTheme: string
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function ChartBlock({ parsed, source, codeTheme }: Props): React.JSX.Element {
  const [showSource, setShowSource] = useState(false)
  const fallback = <CodeBlock code={source} lang="json" theme={codeTheme} />

  return (
    <div className="chartblock">
      <div className="chartblock__head">
        {parsed.spec.title && <div className="chartblock__title">{parsed.spec.title}</div>}
        <div className="chartblock__spacer" />
        {/* What the model actually wrote is always one click away: a picture
            drawn from someone else's numbers should be inspectable. */}
        <button
          className="chartblock__source"
          onClick={() => setShowSource((on) => !on)}
          title={showSource ? 'Show the chart' : 'Show the numbers behind it'}
          aria-pressed={showSource}
          type="button"
        >
          {showSource ? <Eye {...ICON} /> : <Code2 {...ICON} />}
        </button>
      </div>

      {showSource ? (
        fallback
      ) : (
        <>
          <Boundary fallback={fallback}>
            <ChartFigure spec={parsed.spec} />
          </Boundary>

          {parsed.spec.caption && <div className="chartblock__caption">{parsed.spec.caption}</div>}

          {parsed.notes.map((line) => (
            <div className="chartblock__note" key={line}>
              {line}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
