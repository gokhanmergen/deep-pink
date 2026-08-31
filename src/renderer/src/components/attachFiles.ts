import type { PendingAttachment } from '@shared/types'

/**
 * Turning clipboard content and dropped files into attachments the main process
 * can store. Kept out of the component so it can be reasoned about — and tested
 * — on its own.
 */

const ALLOWED_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_COUNT = 8

/**
 * Extensions accepted as text. Dropped files often arrive with an empty MIME
 * type, so the extension is the only thing to go on.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'dart',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'graphql', 'proto', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'lua', 'vim', 'nix', 'zig', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'el',
  'tex', 'bib', 'diff', 'patch', 'dockerfile', 'makefile', 'gitignore'
])

export interface StagedFile extends PendingAttachment {
  /** Local id, only for React keys and removal before sending. */
  key: string
  kind: 'image' | 'text'
  /** Data URL for an image thumbnail; null for text. */
  preview: string | null
  /** First lines of a text attachment, for the chip. */
  excerpt: string | null
  lines: number | null
  bytes: number
}

function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name
  if (!base.includes('.')) return base.toLowerCase()
  return base.split('.').pop()!.toLowerCase()
}

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('image/')) return false
  if (file.type.startsWith('text/')) return true
  if (['application/json', 'application/xml', 'application/x-yaml', 'application/yaml'].includes(file.type)) {
    return true
  }
  return TEXT_EXTENSIONS.has(extensionOf(file.name))
}

/** Every file from a clipboard or drop that this app is willing to attach. */
export function attachableFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const fromItems = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)

  const files = fromItems.length ? fromItems : Array.from(transfer.files ?? [])
  return files.filter((file) => file.type.startsWith('image/') || isTextFile(file))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Turns a long paste into an attachment, the way a dropped file would be. */
export function stageText(text: string, filename: string): StagedFile {
  const encoded = new TextEncoder().encode(text)
  return {
    key: `paste-${encoded.length}-${performance.now()}`,
    kind: 'text',
    mime: 'text/plain',
    filename,
    data: toBase64(encoded),
    width: null,
    height: null,
    preview: null,
    excerpt: text.slice(0, 400),
    lines: text.split('\n').length,
    bytes: encoded.length
  }
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
  staged: StagedFile[]
  /** Human-readable reasons anything was turned away. */
  rejected: string[]
}

export async function stageFiles(files: File[], alreadyStaged: number): Promise<StageResult> {
  const staged: StagedFile[] = []
  const rejected: string[] = []

  for (const file of files) {
    if (alreadyStaged + staged.length >= MAX_COUNT) {
      rejected.push(`only ${MAX_COUNT} attachments per message`)
      break
    }

    const isImage = file.type.startsWith('image/')
    const name = file.name || (isImage ? 'pasted-image' : 'pasted-text.txt')

    if (isImage && !ALLOWED_IMAGE.has(file.type)) {
      rejected.push(`${name}: ${file.type || 'unknown type'} is not a supported image`)
      continue
    }
    if (!isImage && !isTextFile(file)) {
      rejected.push(`${name}: only images and text files can be attached`)
      continue
    }

    const limit = isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
    if (file.size > limit) {
      rejected.push(
        `${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB (limit ${limit / 1024 / 1024} MB)`
      )
      continue
    }

    if (!isImage) {
      const text = await file.text()
      staged.push({ ...stageText(text, name), key: `${name}-${file.size}-${performance.now()}` })
      continue
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const data = toBase64(bytes)
    const preview = `data:${file.type};base64,${data}`
    const { width, height } = await measure(preview)

    staged.push({
      key: `${name}-${file.size}-${staged.length}-${performance.now()}`,
      kind: 'image',
      mime: file.type,
      filename: name,
      data,
      width,
      height,
      preview,
      excerpt: null,
      lines: null,
      bytes: file.size
    })
  }

  return { staged, rejected }
}
