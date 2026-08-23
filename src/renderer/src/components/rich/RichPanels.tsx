import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  File as FileIcon,
  Folder as FolderIcon,
  Info,
  Lightbulb,
  OctagonAlert
} from 'lucide-react'
import type {
  AccordionSpec,
  CalloutSpec,
  CalloutTone,
  CardsSpec,
  MeterSpec,
  StatsSpec,
  StepsSpec,
  TableSpec,
  TabsSpec,
  TreeNode,
  TreeSpec
} from '@shared/richBlocks'
import { ICON } from '../../icons'
import { Sparkline } from './RichCharts'
import { formatUnit } from './units'

/**
 * Everything a rich block can be that is not a chart.
 *
 * Each is an ordinary React component over validated data. Nothing here builds
 * markup from a string: a title is text in a node, a body is Markdown rendered
 * by the same component that renders the rest of the reply, and a link is an
 * href the parser has already proved is http or https.
 *
 * `renderBody` is passed in rather than imported so this file never depends on
 * the Markdown renderer that owns it — which is also what bounds the nesting.
 */

type Body = (markdown: string) => ReactNode

/* ---------------- headline numbers ---------------- */

export function RichStats({ spec }: { spec: StatsSpec }): React.JSX.Element {
  return (
    <div className="tiles rb-tiles">
      {spec.tiles.map((tile, index) => (
        <div className="tile" key={`${tile.label}-${index}`}>
          <div className="tile__label">{tile.label}</div>
          <div className="rb-tile__row">
            <div className="tile__value">{tile.value}</div>
            {tile.trend.length > 1 && <Sparkline values={tile.trend} unit={tile.deltaUnit} />}
          </div>
          {tile.delta !== null && (
            // Direction is a word and an arrow as well as a colour: green and
            // red alone are the one encoding a reader may not have.
            <div className="rb-delta" data-direction={tile.delta > 0 ? 'up' : tile.delta < 0 ? 'down' : 'flat'}>
              {tile.delta > 0 ? '▲' : tile.delta < 0 ? '▼' : '■'}{' '}
              {formatUnit(Math.abs(tile.delta), tile.deltaUnit)}
              <span className="rb-delta__word">{tile.delta > 0 ? 'up' : tile.delta < 0 ? 'down' : 'flat'}</span>
            </div>
          )}
          {tile.sub && <div className="tile__sub">{tile.sub}</div>}
        </div>
      ))}
    </div>
  )
}

/* ---------------- ratios against a limit ---------------- */

export function RichMeter({ spec }: { spec: MeterSpec }): React.JSX.Element {
  return (
    <div className="rb-meters">
      {spec.items.map((item, index) => {
        const ratio = Math.max(Math.min(item.value / item.max, 1), 0)
        return (
          <div className="share" key={`${item.label}-${index}`}>
            <div className="share__head">
              <span className="share__label">{item.label}</span>
              <span className="share__value">
                {formatUnit(item.value, spec.unit)}
                <span className="rb-meter__max"> / {formatUnit(item.max, spec.unit)}</span>
              </span>
            </div>
            <div
              className="share__track"
              role="meter"
              aria-valuenow={item.value}
              aria-valuemin={0}
              aria-valuemax={item.max}
              aria-label={item.label}
            >
              <div className="share__fill" style={{ width: `${Math.max(ratio * 100, 1)}%` }} />
            </div>
            {item.sub && <div className="share__sub">{item.sub}</div>}
          </div>
        )
      })}
    </div>
  )
}

/* ---------------- table ---------------- */

export function RichTable({ spec }: { spec: TableSpec }): React.JSX.Element {
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(
    spec.sortBy === null ? null : { column: spec.sortBy, descending: spec.sortDescending }
  )

  const rows = useMemo(() => {
    if (!sort) return spec.rows
    const { column, descending } = sort
    const numeric = spec.columns[column]?.numeric

    // A copy: source order is the fallback the reader can always get back to.
    return [...spec.rows].sort((left, right) => {
      const a = left[column]
      const b = right[column]
      if (a === null) return 1
      if (b === null) return -1
      const result = numeric
        ? Number(a) - Number(b)
        : String(a).localeCompare(String(b), undefined, { numeric: true })
      return descending ? -result : result
    })
  }, [sort, spec.rows, spec.columns])

  const cell = (value: string | number | null, column: TableSpec['columns'][number]): string => {
    if (value === null) return '—'
    if (typeof value === 'number') return formatUnit(value, column.unit)
    return column.unit !== 'plain' && Number.isFinite(Number(value))
      ? formatUnit(Number(value), column.unit)
      : value
  }

  return (
    <div className="rb-table__scroll">
      <table className="rb-table">
        <thead>
          <tr>
            {spec.columns.map((column, index) => {
              const active = sort?.column === index
              return (
                <th key={column.key} data-align={column.align} data-sorted={active ? 'true' : undefined}>
                  {spec.sortable ? (
                    <button
                      className="rb-table__sort"
                      onClick={() =>
                        setSort((current) =>
                          current?.column === index
                            ? current.descending
                              ? null
                              : { column: index, descending: true }
                            : { column: index, descending: column.numeric }
                        )
                      }
                      type="button"
                      // Three states, in a loop: ascending, descending, and the
                      // order the model wrote them in.
                      title={active ? (sort.descending ? 'Back to the original order' : 'Sort descending') : 'Sort'}
                    >
                      {column.label}
                      <span className="rb-table__arrow">{active ? (sort.descending ? '▼' : '▲') : ''}</span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, at) => (
                <td key={at} data-align={spec.columns[at]?.align} data-numeric={spec.columns[at]?.numeric}>
                  {cell(value, spec.columns[at])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- tabs ---------------- */

export function RichTabs({ spec, body }: { spec: TabsSpec; body: Body }): React.JSX.Element {
  const [active, setActive] = useState(0)
  const strip = useRef<HTMLDivElement>(null)

  const move = (delta: number): void => {
    const next = (active + delta + spec.tabs.length) % spec.tabs.length
    setActive(next)
    // Focus follows selection, which is what a tablist is expected to do.
    strip.current?.querySelectorAll('button')[next]?.focus()
  }

  return (
    <div className="rb-tabs">
      <div className="rb-tabs__strip" role="tablist" ref={strip}>
        {spec.tabs.map((tab, index) => (
          <button
            key={`${tab.label}-${index}`}
            role="tab"
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            className="rb-tabs__tab"
            data-active={index === active}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') move(1)
              if (event.key === 'ArrowLeft') move(-1)
            }}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="rb-tabs__panel" role="tabpanel">
        {body(spec.tabs[active]?.body ?? '')}
      </div>
    </div>
  )
}

/* ---------------- accordion ---------------- */

export function RichAccordion({ spec, body }: { spec: AccordionSpec; body: Body }): React.JSX.Element {
  return (
    <div className="rb-accordion">
      {spec.items.map((item, index) => (
        <details className="disclosure" key={`${item.title}-${index}`} open={item.open}>
          <summary className="disclosure__summary">
            <ChevronRight {...ICON} className="rb-accordion__caret" />
            <span>{item.title}</span>
          </summary>
          <div className="disclosure__content">{body(item.body)}</div>
        </details>
      ))}
    </div>
  )
}

/* ---------------- steps and timelines ---------------- */

export function RichSteps({ spec, body }: { spec: StepsSpec; body: Body }): React.JSX.Element {
  // Dated steps are a timeline and read by their dates; undated ones are a
  // procedure and read by their number.
  const dated = spec.steps.some((step) => step.at)

  return (
    <ol className="rb-steps" data-dated={dated}>
      {spec.steps.map((step, index) => (
        <li className="rb-step" key={`${step.title}-${index}`}>
          <div className="rb-step__marker">{dated ? <span className="rb-step__dot" /> : index + 1}</div>
          <div className="rb-step__content">
            <div className="rb-step__head">
              <span className="rb-step__title">{step.title}</span>
              {step.at && <span className="rb-step__at">{step.at}</span>}
            </div>
            {step.body.trim() && <div className="rb-step__body">{body(step.body)}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ---------------- callout ---------------- */

const TONE_ICONS: Record<CalloutTone, typeof Info> = {
  note: Info,
  tip: Lightbulb,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert
}

const TONE_WORDS: Record<CalloutTone, string> = {
  note: 'Note',
  tip: 'Tip',
  success: 'Done',
  warning: 'Warning',
  danger: 'Careful'
}

export function RichCallout({ spec, body }: { spec: CalloutSpec; body: Body }): React.JSX.Element {
  const Icon = TONE_ICONS[spec.tone]

  return (
    // Icon and word as well as colour: a warning that is only orange is not a
    // warning to everyone.
    <div className="rb-callout" data-tone={spec.tone}>
      <div className="rb-callout__head">
        <Icon {...ICON} />
        <span className="rb-callout__title">{spec.title ?? TONE_WORDS[spec.tone]}</span>
      </div>
      <div className="rb-callout__body">{body(spec.body)}</div>
    </div>
  )
}

/* ---------------- cards ---------------- */

export function RichCards({ spec, body }: { spec: CardsSpec; body: Body }): React.JSX.Element {
  return (
    <div className="rb-cards" data-columns={spec.columns}>
      {spec.cards.map((card, index) => (
        <div className="rb-card" key={`${card.title}-${index}`}>
          <div className="rb-card__head">
            <span className="rb-card__title">{card.title}</span>
            {card.meta && <span className="chip">{card.meta}</span>}
          </div>
          {card.body.trim() && <div className="rb-card__body">{body(card.body)}</div>}
          {card.href && (
            <a
              className="rb-card__link"
              href={card.href}
              onClick={(event) => {
                event.preventDefault()
                void window.deepPink.shell.openExternal(card.href as string)
              }}
            >
              {new URL(card.href).host}
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------------- tree ---------------- */

function TreeBranch({ nodes, depth }: { nodes: TreeNode[]; depth: number }): React.JSX.Element {
  return (
    <ul className="rb-tree__list" data-depth={depth}>
      {nodes.map((node, index) => (
        <li className="rb-tree__item" key={`${node.label}-${index}`}>
          <span className="rb-tree__row">
            {node.kind === 'dir' ? (
              <FolderIcon {...ICON} className="rb-tree__icon" />
            ) : (
              <FileIcon {...ICON} className="rb-tree__icon" />
            )}
            <span className="rb-tree__label" data-kind={node.kind}>
              {node.label}
            </span>
            {node.note && <span className="rb-tree__note">{node.note}</span>}
          </span>
          {node.children.length > 0 && <TreeBranch nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  )
}

export function RichTree({ spec }: { spec: TreeSpec }): React.JSX.Element {
  return (
    <div className="rb-tree">
      <TreeBranch nodes={spec.nodes} depth={0} />
    </div>
  )
}
