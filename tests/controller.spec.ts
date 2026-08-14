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

  it('folds durable goal and plan state for the workspace strip', () => {
    const controller = new TuiController()
    controller.update([
      { type: 'plan/mode', seq: 0, time: 1, data: { active: true } },
      {
        type: 'goal/change', seq: 1, time: 2,
        data: {
          kind: 'goal/change', version: 1, operation: 'block', roundsStarted: 2,
          createdAt: 1, updatedAt: 2,
          goal: {
            id: 'goal-1', revision: 2, objective: 'Ship the terminal UI', phase: 'blocked',
            maxGoalRounds: 6, blockedReason: { code: 'input-needed', message: 'Choose a release channel.' },
          },
        },
      },
    ] as unknown as SessionEvent[])

    expect(controller.snapshot()).toMatchObject({
      planMode: true,
      goal: {
        objective: 'Ship the terminal UI', phase: 'blocked', roundsStarted: 2,
        maxGoalRounds: 6, blockedReason: 'Choose a release channel.',
      },
    })
  })

  it('projects the complete durable transcript without truncating history', () => {
    const controller = new TuiController()
    const events = Array.from({ length: 50 }, (_, seq) => ({
      type: 'user/message', seq, time: seq,
      data: { content: [{ type: 'text', text: `message ${seq}` }], source: { kind: 'user' } },
      surfaceOp: 'append',
    })) as unknown as SessionEvent[]

    controller.update(events)

    expect(controller.snapshot().entries).toHaveLength(50)
    expect(controller.snapshot().entries[0]).toMatchObject({ text: 'message 0' })
    expect(events).toHaveLength(50)
  })

  it('appends new events incrementally without re-projecting the prefix', () => {
    const controller = new TuiController()
    const message = (seq: number): SessionEvent => ({
      type: 'user/message', seq, time: seq,
      data: { content: [{ type: 'text', text: `message ${seq}` }], source: { kind: 'user' } },
      surfaceOp: 'append',
    }) as unknown as SessionEvent

    controller.update([message(0), message(1), message(2)])
    expect(controller.snapshot().entries).toHaveLength(3)

    controller.update([message(0), message(1), message(2), message(3)])
    expect(controller.snapshot().entries).toHaveLength(4)
    expect(controller.snapshot().entries[3]).toMatchObject({ text: 'message 3' })
  })

  it('publishes and settles the startup session picker', async () => {
    const controller = new TuiController()
    const choice = { id: 'web-1', label: 'web-1', kind: 'existing' as const }
    const selected = controller.chooseSession([choice])

    expect(controller.snapshot().sessionChoices).toEqual([choice])
    controller.selectSession(choice)
    await expect(selected).resolves.toBe(choice)
    expect(controller.snapshot().sessionChoices).toBeUndefined()

    const cancelled = controller.chooseSession([choice])
    controller.close()
    await expect(cancelled).resolves.toBeUndefined()
  })

  it('handles local help and session commands without adding chat messages', () => {
    const controller = new TuiController()
    const agent = fakeAgent()
    const command = vi.fn()
    controller.attach(agent)
    controller.setCommandHandler(command)

    controller.submit('/help')
    expect(controller.snapshot().panel).toBe('help')
    controller.dismissPanel()
    controller.submit('/sessions')
    controller.submit('/new')
    controller.submit('/global')
    controller.submit('/model')
    controller.submit('/plan on')
    controller.submit('/rename Project notes')
    controller.submit('/fork')
    controller.submit('/archive')

    expect(command.mock.calls.map(call => call[0])).toEqual(['sessions', 'new', 'global', 'model', 'harness', 'rename', 'fork', 'archive'])
    expect(command.mock.calls[4]).toEqual(['harness', '/plan on'])
    expect(command.mock.calls[5]).toEqual(['rename', 'Project notes'])
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('publishes model choices and updates the visible selection', async () => {
    const controller = new TuiController()
    const agent = fakeAgent()
    controller.attach(agent, { model: 'old/model' })
    const choice = {
      id: 'provider/model', provider: 'provider', model: 'model', label: 'Model', current: false,
    }
    const selected = controller.chooseModel([choice])

    expect(controller.snapshot().modelChoices).toEqual([choice])
    controller.selectModel(choice)
    await expect(selected).resolves.toBe(choice)
    controller.setModel('provider/model')
    expect(controller.snapshot().identity?.model).toBe('provider/model')
  })

  it('submits durable draft images with text and clears the draft rail', () => {
    const controller = new TuiController()
    const agent = fakeAgent()
    controller.attach(agent)
    controller.addAttachment({
      attachmentId: 'image-1' as never,
      mediaType: 'image/png', bytes: 10, width: 2, height: 3, name: 'diagram.png',
    })

    controller.submit('explain this')

    const message = vi.mocked(agent.followup).mock.calls[0]?.[0]
    expect(message?.content).toEqual([
      { type: 'image', attachment: expect.objectContaining({ attachmentId: 'image-1' }) },
      { type: 'text', text: 'explain this' },
    ])
    expect(controller.snapshot().draftAttachments).toEqual([])
  })
})
