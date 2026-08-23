import type { Attachment, Message, Role, Thread } from '@shared/types'

/**
 * A thread as Markdown, for reading.
 *
 * This is a transcript, not a backup: images cannot be carried in a text file
 * and settings would only be noise to a reader, so neither is here. What is
 * here is everything that was said, what said it, and what it cost — the
 * archive format next door is the one that can be read back in.
 *
 * Pure on purpose, so it can be checked against real threads without a
 * database or a window.
 */

export interface MarkdownOptions {
  /** Stamped into the header, so a file says what wrote it. */
  appVersion: string
  exportedAt: number
  /** The folder the thread was filed in, if it was filed at all. */
  folder: string | null
}

const HEADINGS: Record<Role, string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool result'
}

/**
 * Local time, written the same way everywhere.
 *
 * Deliberately not `toLocaleString`: an exported file outlives the machine's
 * locale, and a reader in another timezone is better served by something
 * unambiguous and sortable than by something familiar.
 */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** A fence has to be longer than the longest run of backticks it encloses. */
function fenced(text: string, language = ''): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Arguments can be half-written when a turn was stopped mid-stream. Show
    // them as they are rather than pretending they parsed.
    return raw
  }
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function attachmentLine(attachment: Attachment): string {
  const size = fileSize(attachment.bytes)
  const dimensions =
    attachment.width && attachment.height ? `, ${attachment.width}×${attachment.height}` : ''
  return `> **Attached** \`${attachment.filename || 'untitled'}\` — ${attachment.mime}, ${size}${dimensions}`
}

/** The dim line under an assistant heading: what the turn cost. */
function usageLine(message: Message): string | null {
  const usage = message.usage
  if (!usage) return null

  const parts = [
    `${usage.promptTokens.toLocaleString('en-US')} → ${usage.completionTokens.toLocaleString('en-US')} tokens`
  ]
  if (usage.reasoningTokens > 0) {
    parts.push(`${usage.reasoningTokens.toLocaleString('en-US')} reasoning`)
  }
  if (usage.cachedTokens > 0) parts.push(`${usage.cachedTokens.toLocaleString('en-US')} cached`)
  if (usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 5 : 4)}`)
  if (usage.tokensPerSecond) parts.push(`${usage.tokensPerSecond.toFixed(1)} tok/s`)

  return `*${parts.join(' · ')}*`
}

function heading(message: Message): string {
  if (message.isCompactionSummary) return '## Context summary'

  if (message.role === 'assistant') {
    const model = message.model ? ` — \`${message.model}\`` : ''
    const provider = message.provider ? ` · ${message.provider}` : ''
    return `## Assistant${model}${provider}`
  }

  if (message.role === 'tool' && message.toolResult) {
    const seconds = (message.toolResult.durationMs / 1000).toFixed(1)
    const failed = message.toolResult.isError ? ' · failed' : ''
    return `## Tool result — \`${message.toolResult.name}\` *(${seconds}s${failed})*`
  }

  return `## ${HEADINGS[message.role]}`
}

function renderMessage(message: Message): string {
  const blocks: string[] = [heading(message)]

  const usage = usageLine(message)
  if (usage) blocks.push(usage)

  for (const attachment of message.attachments) blocks.push(attachmentLine(attachment))

  if (message.reasoning?.trim()) {
    // Collapsed rather than dropped: a reasoning trace is usually longer than
    // the answer, and burying it would make the transcript unreadable.
    blocks.push(`<details>\n<summary>Reasoning</summary>\n\n${message.reasoning.trim()}\n\n</details>`)
  }

  if (message.content.trim()) blocks.push(message.content.trim())

  for (const call of message.toolCalls ?? []) {
    blocks.push(`**Tool call** \`${call.name}\``)
    blocks.push(fenced(prettyJson(call.arguments), 'json'))
  }

  if (message.toolResult) blocks.push(fenced(message.toolResult.content))

  if (message.error) blocks.push(`> **Error** ${message.error}`)
  if (message.status === 'aborted') blocks.push('> *Stopped before it finished.*')

  return blocks.join('\n\n')
}

export function toMarkdown(
  thread: Thread,
  messages: Message[],
  options: MarkdownOptions
): string {
  const modelsUsed = [
    ...new Set(messages.map((m) => m.model).filter((m): m is string => Boolean(m)))
  ]
  const cost = messages.reduce((sum, m) => sum + (m.usage?.costUsd ?? 0), 0)
  const tokens = messages.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0)

  const facts: string[] = [`- **Started** ${stamp(thread.createdAt)}`]
  if (thread.config.model) facts.push(`- **Thread model** \`${thread.config.model}\``)
  if (modelsUsed.length) {
    facts.push(`- **Models used** ${modelsUsed.map((m) => `\`${m}\``).join(', ')}`)
  }
  if (options.folder) facts.push(`- **Folder** ${options.folder}`)
  facts.push(`- **Messages** ${messages.length}`)
  if (tokens > 0) {
    facts.push(
      `- **Tokens** ${tokens.toLocaleString('en-US')} · **Cost** $${cost.toFixed(cost < 0.01 ? 5 : 4)}`
    )
  }

  return [
    `# ${thread.title || 'Untitled thread'}`,
    facts.join('\n'),
    `*Exported from Deep Pink ${options.appVersion} on ${stamp(options.exportedAt)}.*`,
    '---',
    ...messages.map(renderMessage),
    ''
  ].join('\n\n')
}
