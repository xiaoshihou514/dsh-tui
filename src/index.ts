/** In-process terminal surface for DeepSeek Harness. @module dsh-tui */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiController } from './controller.ts'
import { renderTui, type TuiRenderHandle } from './ui.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Services required by the interactive runtime. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'approval',
  'sessions',
  'userQuestions',
]

/** Runtime configuration resolved from the startup provider. */
export interface Config {
  /** Optional prompt submitted once the UI is ready. */
  initialPrompt?: string
}

export const Config: z<Config> = z.object({
  initialPrompt: z.string(),
})

interface RuntimeIo {
  readonly stderr: { write(chunk: string): unknown }
  readonly exit: (code: number) => void
  readonly render: (controller: TuiController) => TuiRenderHandle
}

/** Process integrations replaced by focused runtime tests. */
export const internals: { stderr: RuntimeIo['stderr']; render: RuntimeIo['render'] } = {
  stderr: process.stderr,
  render: renderTui,
}

class TuiRuntime {
  private readonly controller = new TuiController()
  private readonly disposers: (() => void)[] = []
  private handle: AgentHandle | undefined
  private renderer: TuiRenderHandle | undefined
  private cleanupTask: Promise<void> | undefined
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly io: RuntimeIo,
  ) {}

  async start(): Promise<void> {
    await this.ctx.get('loader')?.await()
    if (this.stopping) return

    const agents = this.ctx.get('agents')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const sessions = this.ctx.get('sessions')
    const userQuestions = this.ctx.get('userQuestions')
    if (agents === undefined || defaultModel === undefined || sessions === undefined || userQuestions === undefined) return

    this.disposers.push(userQuestions.registerProvider(this.controller))
    const selection = defaultModel.currentSelection()
    this.handle = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
        agentCtx.on('approval/request', request => this.controller.requestApproval(request))
      },
    })
    if (this.stopping) {
      const handle = this.handle
      this.handle = undefined
      if (handle !== undefined) await handle.dispose()
      return
    }

    const agent = this.handle.agent
    this.controller.attach(agent)
    this.disposers.push(this.ctx.on('session/event', (session, _event) => {
      if (session === agent.session) this.controller.update(session.events)
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent: changed, status }) => {
      if (changed === agent) this.controller.setStatus(status)
    }))

    this.renderer = this.io.render(this.controller)
    await agent.whenIdle()
    if (this.config.initialPrompt !== undefined && !this.stopping) {
      this.controller.submit(this.config.initialPrompt)
    }
    await this.renderer.waitUntilExit()
    if (this.stopping) return
    await this.cleanup()
    this.io.exit(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.renderer?.unmount()
    await this.cleanup()
  }

  private cleanup(): Promise<void> {
    this.cleanupTask ??= this.performCleanup()
    return this.cleanupTask
  }

  private async performCleanup(): Promise<void> {
    this.controller.close()
    while (this.disposers.length > 0) this.disposers.pop()?.()
    const handle = this.handle
    this.handle = undefined
    if (handle !== undefined) await handle.dispose()
  }
}

/**
 * Mount the TUI runtime.
 * @param ctx - plugin context carrying Harness services.
 * @param config - validated startup values.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runtime: the launcher must provide ctx.appExit before the tree mounts')
  ctx.effect(() => {
    const runtime = new TuiRuntime(ctx, config, { stderr: internals.stderr, render: internals.render, exit })
    const task = runtime.start().catch((error: unknown) => {
      internals.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    })
    return async () => {
      await runtime.stop()
      await task
    }
  }, 'tui.run')
}
