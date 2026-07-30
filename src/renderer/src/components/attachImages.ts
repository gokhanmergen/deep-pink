import type { PendingAttachment } from '@shared/types'

/**
 * Turning clipboard and dropped files into attachments the main process can
 * store. Kept out of the component so it can be reasoned about — and tested —
 * on its own.
 */

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_BYTES = 20 * 1024 * 1024
export const MAX_COUNT = 8

export interface StagedImage extends PendingAttachment {
  /** Local id, only for React keys and removal before sending. */
  key: string
  /** Data URL for the thumbnail; the stored copy is served over dpimg:// later. */
  preview: string
  bytes: number
}

export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const fromItems = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)

  const files = fromItems.length ? fromItems : Array.from(transfer.files ?? [])
  return files.filter((file) => file.type.startsWith('image/'))
}

/** Reads intrinsic dimensions, so the transcript can reserve the right space. */
function measure(dataUrl: string): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: null, height: null })
    image.src = dataUrl
  })
}

export interface StageResult {
  staged: StagedImage[]
  /** Human-readable reasons anything was turned away. */
  rejected: string[]
}

export async function stageImages(files: File[], alreadyStaged: number): Promise<StageResult> {
  const staged: StagedImage[] = []
  const rejected: string[] = []

  for (const file of files) {
    if (alreadyStaged + staged.length >= MAX_COUNT) {
      rejected.push(`only ${MAX_COUNT} images per message`)
      break
    }
    if (!ALLOWED.has(file.type)) {
      rejected.push(`${file.name || 'that image'}: ${file.type || 'unknown type'} is not supported`)
      continue
    }
    if (file.size > MAX_BYTES) {
      rejected.push(
        `${file.name || 'that image'} is ${(file.size / 1024 / 1024).toFixed(1)} MB (limit ${
          MAX_BYTES / 1024 / 1024
        } MB)`
      )
      continue
    }

    const buffer = await file.arrayBuffer()
    // Chunked so a large image cannot blow the argument limit of String.fromCharCode.
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    const data = btoa(binary)
    const preview = `data:${file.type};base64,${data}`
    const { width, height } = await measure(preview)

    staged.push({
      key: `${file.name}-${file.size}-${staged.length}-${performance.now()}`,
      mime: file.type,
      filename: file.name || 'pasted-image',
      data,
      width,
      height,
      preview,
      bytes: file.size
    })
  }

  return { staged, rejected }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
