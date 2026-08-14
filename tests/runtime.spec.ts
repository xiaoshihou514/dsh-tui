import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, internals } from '../src/index.ts'
import type { TuiController } from '../src/controller.ts'
import type { TuiRenderHandle } from '../src/ui.tsx'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeAgent(ctx: Agent['ctx'] = {} as Agent['ctx']): Agent {
  return {
    id: 'session-runtime' as Agent['id'],
    options: {},
    session: {
      id: 'session-runtime',
      header: { id: 'session-runtime', cwd: process.cwd() },
      events: [],
    } as unknown as Agent['session'],
    inbox: {} as Agent['inbox'],
    status: 'idle',
    ctx,
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: vi.fn(),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  }
}

interface HarnessStub {
  readonly ctx: Context
  readonly agent: Agent
  readonly exit: ReturnType<typeof vi.fn>
  readonly stderr: ReturnType<typeof vi.fn>
  readonly rendered: ReturnType<typeof vi.fn>
  readonly wait: ReturnType<typeof deferred>
  readonly agents: {
    get: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
  }
  readonly disposeHandle: ReturnType<typeof vi.fn>
  disposeEffect(): Promise<void>
}

function harnessStub(options: {
  creationError?: Error
  persisted?: Array<string | { id: string; cwd?: string; turns?: number }>
  live?: Agent
  selectChoice?: number | false
} = {}): HarnessStub {
  const agent = options.live ?? fakeAgent()
  const exit = vi.fn()
  const stderr = vi.fn()
  const rendered = vi.fn()
  const wait = deferred()
  const disposeHandle = vi.fn(() => Promise.resolve())
  let effectDisposer: (() => Promise<void> | void) | undefined
  const renderer: TuiRenderHandle = { waitUntilExit: () => wait.promise, unmount: vi.fn() }
  internals.stderr = { write: stderr }
  internals.render = (controller) => {
    rendered(controller)
    const choiceIndex = options.selectChoice === false ? undefined : options.selectChoice ?? 0
    if (choiceIndex !== undefined) setTimeout(() => {
      const choices = controller.snapshot().sessionChoices
      if (choices !== undefined) controller.selectSession(choices[choiceIndex])
    }, 0)
    return renderer
  }

  const scopedContext = {
    on: vi.fn(() => vi.fn()),
  } as unknown as Context
  const create = vi.fn(async (createOptions: CreateAgentOptions) => {
    if (options.creationError !== undefined) throw options.creationError
    await createOptions.setup?.(scopedContext)
    return { agent, dispose: disposeHandle }
  })
  const resume = vi.fn(async (resumeOptions: { setup?: CreateAgentOptions['setup'] }) => {
    await resumeOptions.setup?.(scopedContext)
    return { agent, dispose: disposeHandle }
  })
  const agents = {
    get: vi.fn(() => options.live),
    create,
    resume,
  }
  const archivedSessionIds: string[] = []
  const services = {
    appExit: exit,
    loader: { await: () => Promise.resolve() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4 },
      saveImage: vi.fn(() => Promise.resolve({
        attachmentId: 'image-test', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'test.png',
      })),
    },
    commands: {
      list: vi.fn(() => [{ name: 'plan', description: 'Toggle plan mode' }]),
      execute: vi.fn(() => Promise.resolve({ commandId: 'command-test', result: { kind: 'success', text: 'Plan mode enabled.' } })),
    },
    llm: {
      listProviders: vi.fn(() => [{ id: 'test', name: 'Test' }]),
      listModels: vi.fn(() => Promise.resolve([{ provider: 'test', id: 'test', name: 'Test model' }])),
      resolveModelInfo: vi.fn(() => Promise.resolve({ provider: 'test', id: 'test', name: 'Test model' })),
      resolveCallConfig: vi.fn((value: unknown) => Promise.resolve(value)),
    },
    sessions: {},
    sessionPersistence: {
      list: vi.fn(() => Promise.resolve((options.persisted ?? []).map((entry, index) => typeof entry === 'string'
        ? { id: entry, createdAt: index, cwd: process.cwd() }
        : { ...entry, createdAt: index }) as never)),
    },
    sessionProjectionCache: {
      cachedSnapshot: vi.fn((header: { id: string }) => {
        const entry = options.persisted?.find(candidate => typeof candidate !== 'string' && candidate.id === header.id)
        return typeof entry === 'object' && entry.turns !== undefined
          ? { asOfSeq: 0, values: { sessionStats: { turns: entry.turns } } }
          : undefined
      }),
    },
    sessionTitle: {
      get: vi.fn(() => undefined),
      rename: vi.fn((_session: unknown, title: string) => ({ title: title.trim() })),
    },
    userQuestions: { registerProvider: vi.fn(() => vi.fn()) },
    workspaceRegistry: {
      archivedSessionIds,
      archiveSession: vi.fn((id: string) => { archivedSessionIds.push(id); return Promise.resolve() }),
    },
    agents,
  }
  const ctx = {
    get: (name: keyof typeof services) => services[name],
    on: vi.fn(() => vi.fn()),
    effect: (mount: () => (() => Promise<void> | void)) => {
      effectDisposer = mount()
      return vi.fn()
    },
  } as unknown as Context
  return {
    ctx,
    agent,
    exit,
    stderr,
    rendered,
    wait,
    agents,
    disposeHandle,
    async disposeEffect() { await effectDisposer?.() },
  }
}

const originalInternals = { ...internals }
afterEach(() => {
  internals.stderr = originalInternals.stderr
  internals.render = originalInternals.render
})

describe('tui runtime', () => {
  it('creates one root agent, submits the initial prompt, and exits cleanly', async () => {
    const stub = harnessStub()
    apply(stub.ctx, { initialPrompt: 'hello' })

    await vi.waitFor(() => { expect(stub.rendered).toHaveBeenCalledOnce() })
    expect(stub.agent.followup).toHaveBeenCalledOnce()
    expect(vi.mocked(stub.agent.followup).mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: 'hello' }])

    stub.wait.resolve()
    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(0) })
    expect(stub.stderr).not.toHaveBeenCalled()
  })

  it('reports creation failures and requests a failing process exit', async () => {
    const stub = harnessStub({ creationError: new Error('factory offline') })
    apply(stub.ctx, {})

    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(1) })
    expect(stub.stderr).toHaveBeenCalledWith('dsh-tui: factory offline\n')
    expect(stub.rendered).toHaveBeenCalledOnce()
    await stub.disposeEffect()
  })

  it('creates the global session once when no persisted history exists', async () => {
    const stub = harnessStub()
    apply(stub.ctx, { globalSession: true })

    await vi.waitFor(() => { expect(stub.rendered).toHaveBeenCalledOnce() })
    expect(stub.agents.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'global' }))
    expect(stub.agents.resume).not.toHaveBeenCalled()
    stub.wait.resolve()
    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(0) })
  })

  it('resumes persisted global and explicitly selected sessions', async () => {
    const global = harnessStub({ persisted: ['global'] })
    apply(global.ctx, { globalSession: true })
    await vi.waitFor(() => { expect(global.rendered).toHaveBeenCalledOnce() })
    expect(global.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'global' }))
    global.wait.resolve()
    await vi.waitFor(() => { expect(global.exit).toHaveBeenCalledWith(0) })

    const selected = harnessStub()
    apply(selected.ctx, { sessionId: 'web-session-1' })
    await vi.waitFor(() => { expect(selected.rendered).toHaveBeenCalledOnce() })
    expect(selected.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'web-session-1' }))
    expect(selected.agents.create).not.toHaveBeenCalled()
    selected.wait.resolve()
    await vi.waitFor(() => { expect(selected.exit).toHaveBeenCalledWith(0) })
  })

  it('shows only sessions belonging to the directory where the TUI started', async () => {
    const stub = harnessStub({
      persisted: [
        { id: 'same-workspace', cwd: process.cwd() },
        { id: 'other-workspace', cwd: '/tmp/a-different-workspace' },
        { id: 'legacy-without-cwd' },
        { id: 'empty-session', cwd: process.cwd(), turns: 0 },
        { id: 'global', cwd: '/tmp/anywhere' },
      ],
      selectChoice: false,
    })
    apply(stub.ctx, {})

    await vi.waitFor(() => {
      expect((stub.rendered.mock.calls[0]?.[0] as TuiController | undefined)?.snapshot().sessionChoices).toBeDefined()
    })
    const controller = stub.rendered.mock.calls[0]?.[0] as TuiController
    expect(controller.snapshot().sessionChoices?.map(choice => choice.id)).toEqual(['new', 'global', 'same-workspace'])

    controller.selectSession(undefined)
    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(0) })
  })

  it('borrows an already-live session without disposing its owner', async () => {
    const live = fakeAgent({ on: vi.fn(() => vi.fn()) } as unknown as Agent['ctx'])
    const stub = harnessStub({ live })
    apply(stub.ctx, { sessionId: String(live.id) })

    await vi.waitFor(() => { expect(stub.rendered).toHaveBeenCalledOnce() })
    expect(stub.agents.create).not.toHaveBeenCalled()
    expect(stub.agents.resume).not.toHaveBeenCalled()
    stub.wait.resolve()
    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(0) })
    expect(stub.disposeHandle).not.toHaveBeenCalled()
  })

  it('switches conversations through terminal-native commands', async () => {
    const stub = harnessStub()
    apply(stub.ctx, {})
    await vi.waitFor(() => { expect(stub.rendered).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(stub.agents.create).toHaveBeenCalledOnce() })
    const controller = stub.rendered.mock.calls[0]?.[0] as TuiController

    controller.submit('/global')
    await vi.waitFor(() => { expect(stub.agents.create).toHaveBeenCalledTimes(2) })
    expect(stub.agents.create.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ sessionId: 'global' }))
    expect(stub.disposeHandle).toHaveBeenCalledOnce()

    controller.submit('/model')
    await vi.waitFor(() => { expect(controller.snapshot().modelChoices).toHaveLength(1) })
    controller.selectModel(controller.snapshot().modelChoices?.[0])
    await vi.waitFor(() => { expect(controller.snapshot().notice).toContain('Model changed') })

    controller.submit('/attach assets/logo.png')
    await vi.waitFor(() => { expect(controller.snapshot().draftAttachments).toHaveLength(1) })
    controller.submit('inspect this image')
    expect(stub.agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
    }))

    controller.submit('/plan on')
    await vi.waitFor(() => { expect(controller.snapshot().notice).toBe('Plan mode enabled.') })
    expect(controller.snapshot().commands).toEqual([{ name: 'plan', description: 'Toggle plan mode' }])

    controller.submit('/rename Project notes')
    await vi.waitFor(() => { expect(controller.snapshot().identity?.title).toBe('Project notes') })

    controller.submit('/fork')
    await vi.waitFor(() => { expect(stub.agents.create).toHaveBeenCalledTimes(3) })
    expect(stub.agents.create.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      seed: [],
      meta: expect.objectContaining({ parentSession: 'session-runtime', seedLength: 0 }),
    }))
    await vi.waitFor(() => { expect(controller.snapshot().notice).toContain('Forked from') })

    controller.submit('/archive')
    await vi.waitFor(() => { expect(stub.agents.create).toHaveBeenCalledTimes(4) })
    await vi.waitFor(() => { expect(controller.snapshot().notice).toContain('Archived') })

    stub.wait.resolve()
    await vi.waitFor(() => { expect(stub.exit).toHaveBeenCalledWith(0) })
  })
})
