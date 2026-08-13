import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { TuiController } from '../src/controller.ts'

function fakeAgent(): Agent {
  return {
    id: 'session-test' as Agent['id'],
    options: {},
    session: { events: [] } as unknown as Agent['session'],
    inbox: {} as Agent['inbox'],
    status: 'idle',
    ctx: {} as Agent['ctx'],
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  }
}

describe('TuiController', () => {
  it('submits trimmed prompts and interrupts the attached agent', () => {
    const controller = new TuiController()
    const agent = fakeAgent()
    controller.attach(agent)

    controller.submit('  hello  ')
    controller.submit('   ')
    controller.cancel()

    expect(agent.followup).toHaveBeenCalledOnce()
    expect(vi.mocked(agent.followup).mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: 'hello' }])
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('queues approvals and resolves an aborted request fail closed', async () => {
    const controller = new TuiController()
    const first = controller.requestApproval({ agent: fakeAgent(), toolName: 'bash', reason: 'write file' })
    const abort = new AbortController()
    const second = controller.requestApproval({ agent: fakeAgent(), toolName: 'fs', signal: abort.signal })

    expect(controller.snapshot().approval).toEqual({ toolName: 'bash', reason: 'write file' })
    controller.decideApproval('allowed-once')
    expect(await first).toBe('allowed-once')
    expect(controller.snapshot().approval).toEqual({ toolName: 'fs' })

    abort.abort()
    expect(await second).toBe('cancelled')
    expect(controller.snapshot().approval).toBeUndefined()
  })

  it('answers queued question sets and rejects them on close', async () => {
    const controller = new TuiController()
    const request = {
      questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }] }],
    }
    const first = controller.ask(request)
    controller.answer({ answers: [{ id: 'choice', selected: ['A'] }] })
    await expect(first).resolves.toEqual({ answers: [{ id: 'choice', selected: ['A'] }] })

    const second = controller.ask(request)
    controller.close()
    await expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('notifies subscribers when canonical events change', () => {
    const controller = new TuiController()
    const listener = vi.fn()
    const dispose = controller.subscribe(listener)
    controller.update([] as SessionEvent[])
    controller.setStatus('running')
    dispose()
    controller.setStatus('idle')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
