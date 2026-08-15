import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { projectTranscript } from '../src/transcript.ts'
import type {} from '@deepseek-ai/dsh-commands/types'

function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
  surface = false,
): Extract<SessionEvent, { type: T }> {
  return { type, seq, time: seq, data, ...(surface ? { surfaceOp: 'append' } : {}) } as Extract<SessionEvent, { type: T }>
}

describe('projectTranscript', () => {
  it('shows a live stream until its assembled message arrives', () => {
    const chunks: SessionEvent[] = [
      event('assistant/chunk', 0, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Think' } }),
      event('assistant/chunk', 1, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Hel' } }),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'lo' } }),
    ]
    expect(projectTranscript(chunks)).toEqual([
      { id: 'stream-1/1', kind: 'assistant', reasoning: 'Think', text: 'Hello', streaming: true },
    ])

    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'Thought' }, { type: 'text', text: 'Hello' }],
      source: { provider: 'test', model: 'test' },
    })
    expect(projectTranscript([...chunks, event('assistant/message', 3, { turn: 1, step: 1, message }, true)]))
      .toEqual([{ id: 'event-3', kind: 'assistant', reasoning: 'Thought', text: 'Hello', streaming: false }])
  })

  it('correlates tool calls and results', () => {
    const callId = CallId('call-1')
    const result = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    })
    const rows = projectTranscript([
      event('tool/call', 0, { turn: 1, step: 1, callId, name: 'bash', arguments: '{"cmd":"pwd"}' }),
      event('tool/result', 1, { turn: 1, step: 1, message: result }, true),
    ])
    expect(rows).toEqual([{
      id: 'tool-call-1', kind: 'tool', name: 'bash', arguments: '{"cmd":"pwd"}', result: 'done', isError: false,
    }])
  })

  it('folds completed tools when the next answer starts', () => {
    const bashId = CallId('bash-1')
    const grepId = CallId('grep-1')
    const result = (callId: CallId) => createToolResultMessage({
      callId,
      content: [{ type: 'text' as const, text: 'done' }],
      isError: false,
    })
    const rows = projectTranscript([
      event('tool/call', 0, { turn: 1, step: 1, callId: bashId, name: 'bash', arguments: '{}' }),
      event('tool/result', 1, { turn: 1, step: 1, message: result(bashId) }, true),
      event('tool/call', 2, { turn: 1, step: 2, callId: grepId, name: 'grep', arguments: '{}' }),
      event('tool/result', 3, { turn: 1, step: 2, message: result(grepId) }, true),
      event('assistant/chunk', 4, { turn: 1, step: 3, chunk: { type: 'text-delta', index: 0, text: 'Found it.' } }),
    ])
    expect(rows).toEqual([
      { id: 'tool-summary-tool-bash-1', kind: 'tool-summary', count: 2, names: 'bash, grep' },
      { id: 'stream-1/3', kind: 'assistant', text: 'Found it.', streaming: true },
    ])
  })

  it('does not retain a blank assistant row for reasoning-only steps', () => {
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'internal work' }],
      source: { provider: 'test', model: 'test' },
    })
    expect(projectTranscript([
      event('assistant/chunk', 0, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'internal' } }),
      event('assistant/message', 1, { turn: 1, step: 1, message }, true),
    ])).toEqual([])
  })

  it('shows only direct user prompts and append-origin messages', () => {
    const direct = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'hidden context' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const replacement = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } })
    const events = [
      event('user/message', 0, direct, true),
      event('user/message', 1, injected, true),
      { ...event('user/message', 2, replacement), surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] },
    ] as SessionEvent[]
    expect(projectTranscript(events)).toEqual([{ id: 'event-0', kind: 'user', text: 'hello' }])
  })

  it('renders terminal turn failures without inventing a successful response', () => {
    const rows = projectTranscript([
      event('turn/end', 0, { turn: 1, reason: { kind: 'error', error: { code: 'UPSTREAM', message: 'offline' } } }),
    ])
    expect(rows).toEqual([{ id: 'turn-1', kind: 'notice', text: 'UPSTREAM: offline', tone: 'error' }])
  })

  it('bounds tool previews without changing ordinary output', () => {
    const callId = CallId('large-call')
    const result = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'x'.repeat(7_000) }],
      isError: false,
    })
    const rows = projectTranscript([
      event('tool/call', 0, { turn: 1, step: 1, callId, name: 'bash', arguments: 'a'.repeat(3_000) }),
      event('tool/result', 1, { turn: 1, step: 1, message: result }, true),
    ])
    const row = rows[0]
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') throw new Error('expected tool row')
    expect(row.arguments.length).toBeLessThan(2_100)
    expect(row.result?.length).toBeLessThan(6_100)
    expect(row.result).toContain('session log keeps the complete value')
  })

  it('correlates durable Harness command lifecycles', () => {
    const rows = projectTranscript([
      event('command/run', 0, {
        commandId: 'command-1' as never, name: 'plan', args: ' on', source: { kind: 'user' },
      }),
      event('command/done', 1, {
        commandId: 'command-1' as never, kind: 'success', text: 'Plan mode enabled.',
      }),
    ])
    expect(rows).toEqual([{
      id: 'command-command-1', kind: 'command', name: 'plan', arguments: 'on', result: 'Plan mode enabled.', isError: false,
    }])
  })
})
