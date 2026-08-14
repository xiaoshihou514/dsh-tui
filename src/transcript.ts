/** Pure projection from the durable Harness log to terminal transcript rows. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands/types'

/** One row rendered in the terminal transcript. */
export type TranscriptEntry =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; reasoning?: string; streaming: boolean }
  | { id: string; kind: 'tool'; name: string; arguments: string; result?: string; isError: boolean }
  | { id: string; kind: 'command'; name: string; arguments?: string; result?: string; isError: boolean }
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
 * Incremental projector from the append-only durable log to transcript rows.
 *
 * The durable log only grows, so the projector folds events one at a time and
 * keeps the complete transcript without ever re-scanning the prefix. A
 * final `assistant/message` replaces its raw streaming chunks in place; surface
 * replacement records stay model-only, matching Harness's human-transcript
 * contract. The terminal owns scrolling and history, so no windowing happens
 * here.
 */
export class TranscriptProjector {
  readonly entries: TranscriptEntry[] = []
  private readonly finalizedSteps = new Set<string>()
  private readonly streaming = new Map<string, Extract<TranscriptEntry, { kind: 'assistant' }>>()
  private readonly tools = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>()
  private readonly commands = new Map<string, Extract<TranscriptEntry, { kind: 'command' }>>()

  /** Fold one more durable event into the transcript. */
  push(event: SessionEvent): void {
    switch (event.type) {
      case 'user/message': {
        if (!isAppendSurfaceEvent(event) || event.data.source.kind !== 'user') break
        const text = blocksText(event.data.content)
        if (text !== '') this.entries.push({ id: `event-${event.seq}`, kind: 'user', text })
        break
      }
      case 'assistant/chunk': {
        const key = `${event.data.turn}/${event.data.step}`
        if (this.finalizedSteps.has(key)) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        let row = this.streaming.get(key)
        if (row === undefined) {
          row = { id: `stream-${key}`, kind: 'assistant', text: '', streaming: true }
          this.streaming.set(key, row)
          this.entries.push(row)
        }
        if (chunk.type === 'text-delta') row.text += chunk.text
        else row.reasoning = (row.reasoning ?? '') + chunk.text
        break
      }
      case 'assistant/message': {
        const key = `${event.data.turn}/${event.data.step}`
        this.finalizedSteps.add(key)
        const live = this.streaming.get(key)
        if (live !== undefined) {
          this.streaming.delete(key)
          const index = this.entries.indexOf(live)
          if (index !== -1) this.entries.splice(index, 1)
        }
        if (!isAppendSurfaceEvent(event)) break
        const text = blocksText(event.data.message.content)
        const reasoning = reasoningText(event.data.message.content)
        if (text !== '' || reasoning !== '') {
          this.entries.push({
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
        this.tools.set(String(event.data.callId), row)
        this.entries.push(row)
        break
      }
      case 'tool/result': {
        if (!isAppendSurfaceEvent(event)) break
        const callId = String(event.data.message.source.callId)
        const row = this.tools.get(callId)
        const result = resultText(event)
        const block = event.data.message.content[0]
        if (row === undefined) {
          this.entries.push({
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
        if (notice !== undefined) this.entries.push(notice)
        break
      }
      case 'command/run': {
        const row: Extract<TranscriptEntry, { kind: 'command' }> = {
          id: `command-${String(event.data.commandId)}`,
          kind: 'command',
          name: event.data.name,
          ...(event.data.args === undefined || event.data.args.trim() === '' ? {} : { arguments: event.data.args.trim() }),
          isError: false,
        }
        this.commands.set(String(event.data.commandId), row)
        this.entries.push(row)
        break
      }
      case 'command/done': {
        const row = this.commands.get(String(event.data.commandId))
        if (row === undefined) break
        row.isError = event.data.kind === 'error'
        if (event.data.text !== undefined) row.result = event.data.text
        break
      }
      default:
        break
    }
  }
}

/** Rebuild the transcript for a complete log prefix (initial replay and tests). */
export function projectTranscript(events: readonly SessionEvent[]): TranscriptEntry[] {
  const projector = new TranscriptProjector()
  for (const event of events) projector.push(event)
  return projector.entries
}
