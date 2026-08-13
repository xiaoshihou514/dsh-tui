/** Pure projection from the durable Harness log to terminal transcript rows. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'

/** One row rendered in the terminal transcript. */
export type TranscriptEntry =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; reasoning?: string; streaming: boolean }
  | { id: string; kind: 'tool'; name: string; arguments: string; result?: string; isError: boolean }
  | { id: string; kind: 'notice'; text: string; tone: 'muted' | 'error' }

function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... terminal preview truncated; the session log keeps the complete value`
}

function reasoningText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
}

function resultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  return clip(blocksText(block.content), 6_000)
}

function turnNotice(event: SessionEvent<'turn/end'>): TranscriptEntry | undefined {
  const reason = event.data.reason
  switch (reason.kind) {
    case 'completed':
      return
    case 'aborted':
      return { id: `turn-${event.data.turn}`, kind: 'notice', text: 'Turn interrupted.', tone: 'muted' }
    case 'blocked':
      return { id: `turn-${event.data.turn}`, kind: 'notice', text: 'Turn blocked.', tone: 'error' }
    case 'max-tokens':
      return { id: `turn-${event.data.turn}`, kind: 'notice', text: 'Model output reached its token limit.', tone: 'error' }
    case 'interrupted':
      return { id: `turn-${event.data.turn}`, kind: 'notice', text: 'The previous process stopped during this turn.', tone: 'error' }
    case 'error':
      return {
        id: `turn-${event.data.turn}`,
        kind: 'notice',
        text: `${reason.error.code}: ${reason.error.message}`,
        tone: 'error',
      }
    default:
      return {
        id: `turn-${event.data.turn}`,
        kind: 'notice',
        text: `Turn ended: ${String((reason as { kind: string }).kind)}`,
        tone: 'muted',
      }
  }
}

/**
 * Rebuild the visible transcript from the canonical event log.
 *
 * Final assistant messages replace their raw streaming chunks. Surface
 * replacement records stay model-only, matching Harness's human-transcript
 * contract.
 */
export function projectTranscript(events: readonly SessionEvent[]): TranscriptEntry[] {
  const finalizedSteps = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      finalizedSteps.add(`${event.data.turn}/${event.data.step}`)
    }
  }

  const rows: TranscriptEntry[] = []
  const streaming = new Map<string, Extract<TranscriptEntry, { kind: 'assistant' }>>()
  const tools = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (!isAppendSurfaceEvent(event) || event.data.source.kind !== 'user') break
        const text = blocksText(event.data.content)
        if (text !== '') rows.push({ id: `event-${event.seq}`, kind: 'user', text })
        break
      }
      case 'assistant/chunk': {
        const key = `${event.data.turn}/${event.data.step}`
        if (finalizedSteps.has(key)) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        let row = streaming.get(key)
        if (row === undefined) {
          row = { id: `stream-${key}`, kind: 'assistant', text: '', streaming: true }
          streaming.set(key, row)
          rows.push(row)
        }
        if (chunk.type === 'text-delta') row.text += chunk.text
        else row.reasoning = (row.reasoning ?? '') + chunk.text
        break
      }
      case 'assistant/message': {
        if (!isAppendSurfaceEvent(event)) break
        const text = blocksText(event.data.message.content)
        const reasoning = reasoningText(event.data.message.content)
        if (text !== '' || reasoning !== '') {
          rows.push({
            id: `event-${event.seq}`,
            kind: 'assistant',
            text,
            ...(reasoning === '' ? {} : { reasoning }),
            streaming: false,
          })
        }
        break
      }
      case 'tool/call': {
        const row: Extract<TranscriptEntry, { kind: 'tool' }> = {
          id: `tool-${String(event.data.callId)}`,
          kind: 'tool',
          name: event.data.name,
          arguments: clip(event.data.arguments, 2_000),
          isError: false,
        }
        tools.set(String(event.data.callId), row)
        rows.push(row)
        break
      }
      case 'tool/result': {
        if (!isAppendSurfaceEvent(event)) break
        const callId = String(event.data.message.source.callId)
        const row = tools.get(callId)
        const result = resultText(event)
        const block = event.data.message.content[0]
        if (row === undefined) {
          rows.push({
            id: `tool-${callId}`,
            kind: 'tool',
            name: 'tool result',
            arguments: '',
            result,
            isError: block.isError === true,
          })
        } else {
          row.result = result
          row.isError = block.isError === true
        }
        break
      }
      case 'turn/end': {
        const notice = turnNotice(event)
        if (notice !== undefined) rows.push(notice)
        break
      }
      default:
        break
    }
  }
  return rows
}
