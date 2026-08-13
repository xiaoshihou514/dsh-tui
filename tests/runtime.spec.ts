import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, internals } from '../src/index.ts'
import type { TuiRenderHandle } from '../src/ui.tsx'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fakeAgent(): Agent {
  return {
    id: 'session-runtime' as Agent['id'],
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

interface HarnessStub {
  readonly ctx: Context
  readonly agent: Agent
  readonly exit: ReturnType<typeof vi.fn>
  readonly stderr: ReturnType<typeof vi.fn>
  readonly rendered: ReturnType<typeof vi.fn>
  readonly wait: ReturnType<typeof deferred>
  disposeEffect(): Promise<void>
}

function harnessStub(options: { creationError?: Error } = {}): HarnessStub {
  const agent = fakeAgent()
  const exit = vi.fn()
  const stderr = vi.fn()
  const rendered = vi.fn()
  const wait = deferred()
  let effectDisposer: (() => Promise<void> | void) | undefined
  const renderer: TuiRenderHandle = { waitUntilExit: () => wait.promise, unmount: vi.fn() }
  internals.stderr = { write: stderr }
  internals.render = (controller) => {
    rendered(controller)
    return renderer
  }

  const scopedContext = {
    on: vi.fn(() => vi.fn()),
  } as unknown as Context
  const services = {
    appExit: exit,
    loader: { await: () => Promise.resolve() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    sessions: {},
    userQuestions: { registerProvider: vi.fn(() => vi.fn()) },
    agents: {
      create: vi.fn(async (createOptions: CreateAgentOptions) => {
        if (options.creationError !== undefined) throw options.creationError
        await createOptions.setup?.(scopedContext)
        return { agent, dispose: vi.fn(() => Promise.resolve()) }
      }),
    },
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
    expect(stub.rendered).not.toHaveBeenCalled()
    await stub.disposeEffect()
  })
})
