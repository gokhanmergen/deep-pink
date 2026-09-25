import type { ChatMessageParam, ToolParam } from './providers/openrouter'
import { streamChat } from './providers/openrouter'
import {
  WEB_FETCH_TOOL,
  WEB_PROMPT_SEGMENT,
  WEB_SEARCH_TOOL,
  runWebFetch,
  runWebSearch
} from './tools/web'
import { loadSettings } from './settings'

function firstParagraph(text: string): string {
  return (text.trim().split(/\n\s*\n/, 1)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim()
}

/** Runs Quick Question without tying the request to a particular UI transport. */
export async function askQuickQuestion(
  question: string,
  signal: AbortSignal,
  onContent: (content: string) => void
): Promise<string> {
  const prompt = String(question ?? '').trim()
  if (!prompt) throw new Error('Enter a question first.')

  const settings = loadSettings()
  const model = settings.quickQuestion.model || settings.defaultModel
  const webEnabled = settings.quickQuestion.webAccessEnabled
  const useWebPlugin = webEnabled && settings.web.engine === 'openrouter'
  const webInstructions = useWebPlugin
    ? [
        'Web search is enabled through the model provider.',
        'Use it for current or uncertain information, and cite the URLs it returns.'
      ].join(' ')
    : WEB_PROMPT_SEGMENT
  const webTools: ToolParam[] = webEnabled && !useWebPlugin ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : []
  const messages: ChatMessageParam[] = [
    {
      role: 'system',
      content: [
        settings.quickQuestion.systemPrompt.trim(),
        'Answer in one short paragraph maximum. Do not use headings or lists.',
        ...(webEnabled ? [webInstructions] : [])
      ]
        .filter(Boolean)
        .join('\n\n')
    },
    { role: 'user', content: prompt }
  ]

  let shown = ''
  try {
    // Bound tool turns so a model that repeatedly searches cannot hold the
    // native popup open without returning an answer.
    for (let toolRound = 0; toolRound <= 4; toolRound++) {
      let raw = ''
      const result = await streamChat(
        {
          model,
          messages,
          temperature: settings.temperature,
          maxTokens: 256,
          tools: webTools.length ? webTools : undefined,
          providerRouting: webTools.length
            ? {
                ...(settings.modelProviderRouting[model] ?? settings.defaultProviderRouting),
                requireParameters: true
              }
            : settings.modelProviderRouting[model] ?? settings.defaultProviderRouting,
          webPlugin: useWebPlugin,
          attribution: settings.sendAppAttribution,
          includeReasoning: false,
          signal
        },
        {
          onContent: (delta) => {
            raw += delta
            // Wait for the final turn before showing web-enabled content, so a
            // pre-search sentence does not flash as the completed answer.
            if (webEnabled || signal.aborted) return
            const next = firstParagraph(raw)
            if (next === shown) return
            shown = next
            onContent(shown)
          }
        }
      )

      if (result.toolCalls.length) {
        if (!webTools.length || toolRound === 4) {
          throw new Error('Quick Question could not finish its web search. Please try again.')
        }

        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments || '{}' }
          }))
        })

        for (const call of result.toolCalls) {
          let content: string
          try {
            const args: unknown = JSON.parse(call.arguments || '{}')
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('Tool arguments must be a JSON object.')
            }
            content =
              call.name === 'web_search'
                ? await runWebSearch(args as { query?: string; max_results?: number }, settings.web)
                : call.name === 'web_fetch'
                  ? await runWebFetch(args as { url?: string; max_chars?: number }, settings.web)
                  : `Unsupported Quick Question tool: ${call.name}`
          } catch (error) {
            content = `Web tool error: ${error instanceof Error ? error.message : String(error)}`
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content })
        }

        shown = ''
        onContent('')
        continue
      }

      const citationUrls = [...new Set(result.citations.map((citation) => citation.url))]
      const answer = firstParagraph(
        [result.content || raw, citationUrls.length ? `Sources: ${citationUrls.join(', ')}` : '']
          .filter(Boolean)
          .join(' ')
      )
      if (!answer) {
        throw new Error(
          'The model returned an empty response. Try again or choose another Quick Question model.'
        )
      }

      if (answer !== shown) onContent(answer)
      return answer
    }
    throw new Error('Quick Question could not finish its response. Please try again.')
  } catch (error) {
    if (signal.aborted) return shown
    throw error
  }
}
