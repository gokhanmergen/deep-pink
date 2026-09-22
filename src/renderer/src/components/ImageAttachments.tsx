import type { Attachment } from '@shared/types'
import { useStore } from '../store'

/**
 * The pictures on a message, whoever put them there.
 *
 * Lifted out of `MessageItem` when models started drawing. A generated image
 * is stored exactly as an attached one — same table, same `dpimg://` address,
 * same row against the message — so the thing that shows it should be the
 * same too. The alternative was this markup twice, drifting, with the model's
 * pictures quietly missing whatever the reader's ones gained.
 */
export function ImageAttachments({ attachments }: { attachments: Attachment[] }): React.JSX.Element | null {
  const openImageViewer = useStore((s) => s.openImageViewer)
  const images = attachments.filter((file) => file.kind === 'image')
  if (!images.length) return null

  /*
   * Every picture in the transcript, for stepping through — not just this
   * message's. Read at the moment of the click rather than subscribed to: a
   * row that re-rendered on each new picture would be a row re-rendering on
   * each new picture, which during a turn that draws several is every frame.
   */
  const imagesOnScreen = (): Attachment[] =>
    useStore
      .getState()
      .messages.flatMap((entry) => entry.attachments.filter((file) => file.kind === 'image'))

  return (
    <div className="attachments">
      {images.map((image) => (
        <a
          key={image.id}
          className="attachment"
          href={image.url}
          onClick={(event) => {
            // Opens in the app's own viewer, where it can be zoomed, saved and
            // stepped through — handing it to the desktop's image program is
            // still offered, from in there.
            event.preventDefault()
            openImageViewer(imagesOnScreen(), image.id)
          }}
          title={`${image.filename} — ${Math.round(image.bytes / 1024)} KB`}
        >
          <img
            src={image.url}
            alt={image.filename}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            /*
             * Lazy only when the size is known, which is the net under the
             * measuring done when a picture is stored.
             *
             * Every attachment in a real library has its dimensions (79 of
             * 79, checked 2026-09-22), so this never fires today. It is here
             * because the one thing that could produce an unsized row is a
             * format `nativeImage` cannot read — it answers 0×0 and the size
             * is stored as null — and an unsized image lays out as a
             * zero-by-zero box, which is a box that need never intersect the
             * viewport. Lazy plus no size is an image that waits for a
             * moment that does not come.
             */
            loading={image.width && image.height ? 'lazy' : 'eager'}
          />
        </a>
      ))}
    </div>
  )
}
