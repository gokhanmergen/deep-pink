import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Maximize2,
  Minus,
  Plus,
  X
} from 'lucide-react'
import { ICON } from '../icons'
import { formatBytes } from '../format'
import { useStore } from '../store'

/**
 * The image viewer.
 *
 * Clicking a picture in a conversation used to hand it to whatever the desktop
 * has registered for PNGs, which takes you out of the app to read something
 * that is part of the conversation. This keeps it here: mostly full screen over
 * the transcript, zoomable, pannable, and with the two things anyone wants from
 * an image they are looking at — a copy of it, and it on the clipboard.
 *
 * The picture is served over `dpimg://` exactly as it is in the transcript, so
 * the viewer never handles bytes; and saving names an attachment id rather than
 * a path, so it can only ever write out something this app is already holding.
 */

/** How far in and out the wheel and the buttons may go. */
const MIN_SCALE = 1
const MAX_SCALE = 40
const STEP = 1.4

interface Point {
  x: number
  y: number
}

const ORIGIN: Point = { x: 0, y: 0 }

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

export function ImageViewer(): React.JSX.Element | null {
  const viewer = useStore((s) => s.imageViewer)
  const close = useStore((s) => s.closeImageViewer)
  const step = useStore((s) => s.stepImageViewer)
  const showToast = useStore((s) => s.showToast)

  const stage = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const surface = useRef<HTMLDivElement>(null)

  /** 1 is "as large as it fits"; the CSS does the fitting, this multiplies it. */
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>(ORIGIN)
  /**
   * How much bigger the file is than the fitted picture on screen. 1 means it
   * is already being shown pixel for pixel, so there is no "actual size" to go
   * to and the button says so.
   */
  const [oneToOne, setOneToOne] = useState(1)
  const [busy, setBusy] = useState(false)

  const dragging = useRef<{ from: Point; at: Point } | null>(null)
  /** Set by a drag that actually went somewhere, so its click is not a click. */
  const dragged = useRef(false)

  const image = viewer ? viewer.images[viewer.index] : null
  const count = viewer?.images.length ?? 0

  /** Back to the size it arrived at, centred. */
  const reset = useCallback((): void => {
    setScale(1)
    setOffset(ORIGIN)
  }, [])

  // A new picture starts fresh: keeping the last one's zoom would drop the
  // reader into the middle of an image they have not seen yet.
  useEffect(reset, [image?.id, reset])

  /**
   * Measures how much detail is being held back.
   *
   * The picture's own metadata is used when it has any, because it is known
   * before a single byte is decoded; what the element reports once it has
   * loaded is better still, and replaces it.
   */
  const measure = useCallback((): void => {
    const el = picture.current
    if (!el || !el.clientWidth) return
    const natural = el.naturalWidth || image?.width || 0
    setOneToOne(natural ? Math.max(natural / el.clientWidth, 1) : 1)
  }, [image?.width])

  useLayoutEffect(measure, [measure, image?.id])

  useEffect(() => {
    if (!viewer) return
    const observer = new ResizeObserver(measure)
    if (picture.current) observer.observe(picture.current)
    return () => observer.disconnect()
  }, [viewer, measure])

  /** Never lets the picture be dragged out of the frame it is being shown in. */
  const contain = useCallback((next: Point, at: number): Point => {
    const frame = stage.current?.getBoundingClientRect()
    const el = picture.current
    if (!frame || !el) return next

    const width = el.clientWidth * at
    const height = el.clientHeight * at
    // Smaller than the frame in an axis: it stays centred in that axis.
    const room = { x: Math.max((width - frame.width) / 2, 0), y: Math.max((height - frame.height) / 2, 0) }
    return { x: clamp(next.x, -room.x, room.x), y: clamp(next.y, -room.y, room.y) }
  }, [])

  /**
   * Zooms about a point, so what is under the pointer stays under it.
   *
   * The picture is drawn as `translate(offset) scale(at)` about its centre, so
   * a point `p` measured from that centre sits at `offset + at · p`. Holding
   * that still across a change of scale is what the second line says.
   */
  const zoomAbout = useCallback(
    (factor: number, about: Point | null): void => {
      setScale((current) => {
        const next = clamp(current * factor, MIN_SCALE, MAX_SCALE)
        if (next === current) return current

        setOffset((position) => {
          const anchor = about ?? ORIGIN
          const moved = {
            x: anchor.x - (next / current) * (anchor.x - position.x),
            y: anchor.y - (next / current) * (anchor.y - position.y)
          }
          return contain(next === 1 ? ORIGIN : moved, next)
        })
        return next
      })
    },
    [contain]
  )

  /** Where a pointer is, measured from the middle of the frame. */
  const fromCentre = (event: { clientX: number; clientY: number }): Point => {
    const frame = stage.current?.getBoundingClientRect()
    if (!frame) return ORIGIN
    return {
      x: event.clientX - (frame.left + frame.width / 2),
      y: event.clientY - (frame.top + frame.height / 2)
    }
  }

  const save = async (): Promise<void> => {
    if (!image || busy) return
    setBusy(true)
    try {
      const path = await window.deepPink.attachments.save(image.id)
      if (path) showToast(`Saved as ${path.split(/[\\/]/).pop()}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!image) return
    const done = await window.deepPink.attachments.copy(image.id)
    showToast(done ? 'Image copied' : 'That image could not be copied', done ? 'info' : 'error')
  }

  // Keys are bound on the window rather than the panel: the panel can lose
  // focus to one of its own buttons, and Escape has to work regardless.
  useEffect(() => {
    if (!viewer) return

    const onKey = (event: KeyboardEvent): void => {
      const key = event.key
      if (key === 'Escape') {
        event.stopPropagation()
        close()
      } else if (key === '+' || key === '=') {
        zoomAbout(STEP, null)
      } else if (key === '-' || key === '_') {
        zoomAbout(1 / STEP, null)
      } else if (key === '0') {
        reset()
      } else if (key === '1') {
        zoomAbout(oneToOne / scale, null)
      } else if (key === 'ArrowRight') {
        step(1)
      } else if (key === 'ArrowLeft') {
        step(-1)
      } else {
        return
      }
      event.preventDefault()
    }

    // Captured, so the app's own shortcuts do not fire underneath the viewer.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [viewer, close, step, zoomAbout, reset, oneToOne, scale])

  /**
   * The wheel zooms rather than scrolls, which is what every image viewer does
   * and what a trackpad pinch arrives as. Bound here rather than with onWheel
   * because React attaches passively, and a passive listener may not preventDefault.
   */
  useEffect(() => {
    const el = surface.current
    if (!el) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomAbout(Math.exp(-event.deltaY * 0.0015), fromCentre(event))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAbout, viewer])

  if (!viewer || !image) return null

  const percent = Math.round((scale / oneToOne) * 100)
  const canPan = scale > 1

  return (
    <div
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={image.filename || 'Image'}
      ref={surface}
      onPointerDown={(event) => {
        dragged.current = false
        if (!canPan || event.button !== 0) return
        dragging.current = { from: { x: event.clientX, y: event.clientY }, at: offset }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragging.current
        if (!drag) return
        const moved = {
          x: drag.at.x + (event.clientX - drag.from.x),
          y: drag.at.y + (event.clientY - drag.from.y)
        }
        if (Math.abs(moved.x - drag.at.x) > 2 || Math.abs(moved.y - drag.at.y) > 2) {
          dragged.current = true
        }
        setOffset(contain(moved, scale))
      }}
      onPointerUp={(event) => {
        dragging.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onClick={(event) => {
        // Clicking beside the picture closes, which is what the dark area is
        // for. The end of a drag is not a click, however far from the picture
        // the pointer happened to finish.
        if (dragged.current) {
          dragged.current = false
          return
        }
        const target = event.target as HTMLElement
        if (target === event.currentTarget || target.dataset.backdrop) close()
      }}
    >
      <div className="viewer__bar">
        <div className="viewer__name" title={image.filename}>
          {image.filename || 'Image'}
        </div>
        <div className="viewer__meta">
          {image.width && image.height ? `${image.width} × ${image.height} · ` : ''}
          {formatBytes(image.bytes)}
          {count > 1 && ` · ${viewer.index + 1} of ${count}`}
        </div>

        <div className="viewer__spacer" />

        <div className="viewer__zoom">
          <button
            className="viewer__btn"
            onClick={() => zoomAbout(1 / STEP, null)}
            disabled={scale <= MIN_SCALE}
            title="Zoom out (−)"
            type="button"
          >
            <Minus {...ICON} />
          </button>
          {/* The readout is the way back: whatever you have done to it, this
              puts the whole picture on screen again. */}
          <button
            className="viewer__percent"
            onClick={reset}
            title="Fit to the window (0)"
            type="button"
          >
            {percent}%
          </button>
          <button
            className="viewer__btn"
            onClick={() => zoomAbout(STEP, null)}
            disabled={scale >= MAX_SCALE}
            title="Zoom in (+)"
            type="button"
          >
            <Plus {...ICON} />
          </button>
        </div>

        {oneToOne > 1.01 && (
          <button
            className="viewer__btn"
            onClick={() => zoomAbout(oneToOne / scale, null)}
            title="Actual size (1)"
            type="button"
          >
            <Maximize2 {...ICON} />
          </button>
        )}

        <button className="viewer__btn" onClick={() => void save()} title="Save a copy…" type="button">
          <Download {...ICON} />
        </button>
        <button className="viewer__btn" onClick={() => void copy()} title="Copy the image" type="button">
          <Copy {...ICON} />
        </button>
        <button
          className="viewer__btn"
          onClick={() => void window.deepPink.attachments.open(image.id)}
          title="Open in the desktop's image viewer"
          type="button"
        >
          <ExternalLink {...ICON} />
        </button>
        <button className="viewer__btn" onClick={close} title="Close (Esc)" type="button">
          <X {...ICON} />
        </button>
      </div>

      {count > 1 && (
        <>
          <button
            className="viewer__step viewer__step--prev"
            onClick={() => step(-1)}
            title="Previous image (←)"
            type="button"
          >
            <ChevronLeft size={20} strokeWidth={2} />
          </button>
          <button
            className="viewer__step viewer__step--next"
            onClick={() => step(1)}
            title="Next image (→)"
            type="button"
          >
            <ChevronRight size={20} strokeWidth={2} />
          </button>
        </>
      )}

      <div className="viewer__stage" ref={stage} data-backdrop="true">
        <img
          className="viewer__image"
          ref={picture}
          src={image.url}
          alt={image.filename}
          draggable={false}
          data-panning={canPan}
          onLoad={measure}
          onDoubleClick={(event) => {
            // Between the whole picture and its own pixels, about the point
            // that was asked about.
            if (scale > 1) reset()
            else zoomAbout(Math.max(oneToOne, 2) / scale, fromCentre(event))
          }}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
          }}
        />
      </div>
    </div>
  )
}
