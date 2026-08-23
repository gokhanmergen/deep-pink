import { Component, useState, type ReactNode } from 'react'
import { Code2, Eye } from 'lucide-react'
import type { ParsedRichBlock } from '@shared/richBlocks'
import { ICON } from '../../icons'
import { CodeBlock } from '../CodeBlock'
import { RichChart, RichShare } from './RichCharts'
import {
  RichAccordion,
  RichCallout,
  RichCards,
  RichMeter,
  RichStats,
  RichSteps,
  RichTable,
  RichTabs,
  RichTree
} from './RichPanels'

/**
 * One rich block: the chrome around it, the switch back to its source, and the
 * guarantee that it cannot take the transcript down with it.
 *
 * A block is drawn from data the parser has already validated, but a component
 * can still be handed a shape it did not expect — an empty series, a max of
 * zero — and a reply that renders as a blank page because one chart divided by
 * nothing would be the worst outcome here. The boundary below turns any such
 * failure back into the code the model actually wrote.
 */

interface Props {
  parsed: ParsedRichBlock
  /** The JSON as it arrived, for the source view and the fallback. */
  source: string
  language: string
  codeTheme: string
  /** Renders Markdown inside a block, one level further down. */
  body: (markdown: string) => ReactNode
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

function title(parsed: ParsedRichBlock): string | null {
  const spec = parsed.block.spec as { title?: string | null }
  return spec.title ?? null
}

function caption(parsed: ParsedRichBlock): string | null {
  const spec = parsed.block.spec as { caption?: string | null }
  return spec.caption ?? null
}

function draw(parsed: ParsedRichBlock, body: (markdown: string) => ReactNode): ReactNode {
  const { block } = parsed
  switch (block.kind) {
    case 'chart':
      return <RichChart spec={block.spec} />
    case 'share':
      return <RichShare spec={block.spec} />
    case 'stats':
      return <RichStats spec={block.spec} />
    case 'meter':
      return <RichMeter spec={block.spec} />
    case 'table':
      return <RichTable spec={block.spec} />
    case 'tabs':
      return <RichTabs spec={block.spec} body={body} />
    case 'accordion':
      return <RichAccordion spec={block.spec} body={body} />
    case 'steps':
      return <RichSteps spec={block.spec} body={body} />
    case 'callout':
      return <RichCallout spec={block.spec} body={body} />
    case 'cards':
      return <RichCards spec={block.spec} body={body} />
    case 'tree':
      return <RichTree spec={block.spec} />
  }
}

export function RichBlock({ parsed, source, language, codeTheme, body }: Props): React.JSX.Element {
  const [showSource, setShowSource] = useState(false)
  const fallback = <CodeBlock code={source} lang="json" theme={codeTheme} />

  const heading = title(parsed)
  const note = caption(parsed)

  // A callout is chrome already; wrapping it in more would be a box in a box.
  const bare = parsed.block.kind === 'callout'

  return (
    <div className="rb" data-kind={parsed.block.kind} data-bare={bare}>
      <div className="rb__head">
        {heading && <div className="rb__title">{heading}</div>}
        <div className="rb__spacer" />
        {/* What the model actually wrote is always one click away: a picture
            drawn from someone else's numbers should be inspectable. */}
        <button
          className="rb__source"
          onClick={() => setShowSource((on) => !on)}
          title={showSource ? 'Show the block' : `Show the ${language} source`}
          aria-pressed={showSource}
          type="button"
        >
          {showSource ? <Eye {...ICON} /> : <Code2 {...ICON} />}
        </button>
      </div>

      {showSource ? (
        fallback
      ) : (
        <Boundary fallback={fallback}>
          <div className="rb__body">{draw(parsed, body)}</div>
        </Boundary>
      )}

      {!showSource && note && <div className="rb__caption">{note}</div>}

      {!showSource &&
        parsed.notes.map((line) => (
          <div className="rb-note" key={line}>
            {line}
          </div>
        ))}
    </div>
  )
}
