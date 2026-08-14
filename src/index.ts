/** In-process terminal surface for DeepSeek Harness. @module dsh-tui */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-stats/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TuiController, type SessionChoice } from './controller.ts'
import { renderTui, type TuiRenderHandle } from './ui.tsx'

interface SessionPersistenceListing {
  list(): Promise<readonly SessionHeader[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistenceListing
  }
}

/** Stable Cordis plugin name. */
export const name = 'tui-runtime'

/** Services required by the interactive runtime. */
export const inject = [
  'agentDefaultModel',
  'agents',
  'approval',
  'attachments',
  'commands',
  'llm',
  'sessions',
  'sessionPersistence',
  'sessionProjectionCache',
  'sessionTitle',
  'userQuestions',
  'workspaceRegistry',
]

/** Runtime configuration resolved from the startup provider. */
export interface Config {
  /** Optional prompt submitted once the UI is ready. */
  initialPrompt?: string
  /** Reuse the stable global session, creating it on first use. */
  globalSession?: boolean
  /** Resume one pre-existing persisted session by id. */
  sessionId?: string
}

export const Config: z<Config> = z.object({
  initialPrompt: z.string(),
  globalSession: z.boolean(),
  sessionId: z.string(),
})

/** Durable identity used by the OpenClaw-style global conversation. */
export const GLOBAL_SESSION_ID = SessionId('global')

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
  private agent: AgentHandle['agent'] | undefined
  private borrowedApprovalDisposer: (() => void) | undefined
  private modelSelection: ModelSelectionRef | undefined
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
    if (this.config.globalSession === true && this.config.sessionId !== undefined) {
      throw new Error('tui-runtime: globalSession and sessionId are mutually exclusive')
    }

    const agents = this.ctx.get('agents')
    const attachments = this.ctx.get('attachments')
    const commands = this.ctx.get('commands')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const llm = this.ctx.get('llm')
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    const projectionCache = this.ctx.get('sessionProjectionCache')
    const sessionTitle = this.ctx.get('sessionTitle')
    const userQuestions = this.ctx.get('userQuestions')
    const workspaceRegistry = this.ctx.get('workspaceRegistry')
    if (agents === undefined || attachments === undefined || commands === undefined || defaultModel === undefined || llm === undefined || sessions === undefined || persistence === undefined || projectionCache === undefined || sessionTitle === undefined || userQuestions === undefined || workspaceRegistry === undefined) return

    this.disposers.push(userQuestions.registerProvider(this.controller))
    const selection = defaultModel.currentSelection()
    const startingCwd = process.cwd()
    this.renderer = this.io.render(this.controller)
    const sessionChoices = async (): Promise<SessionChoice[]> => {
      const headers = [...await persistence.list()].sort((a, b) => b.createdAt - a.createdAt)
      return [
        { id: 'new', label: 'New session', kind: 'new' },
        { id: String(GLOBAL_SESSION_ID), label: 'Global session', detail: 'Shared, persistent conversation', kind: 'global' },
        ...headers
          .filter(header => header.id !== GLOBAL_SESSION_ID
            && header.cwd !== undefined
            && resolve(header.cwd) === startingCwd
            && projectionCache.cachedSnapshot(header)?.values.sessionStats?.turns !== 0
            && !workspaceRegistry.archivedSessionIds.includes(header.id))
          .map(header => {
            const snapshot = projectionCache.cachedSnapshot(header)
            const title = snapshot?.values.title ?? undefined
            return {
              id: String(header.id),
              label: title ?? String(header.id),
              detail: [header.cwd, new Date(header.createdAt).toLocaleString()].filter(Boolean).join(' · '),
              kind: 'existing' as const,
            }
          }),
      ]
    }
    const adopt = async (
      nextAgent: AgentHandle['agent'],
      nextHandle: AgentHandle | undefined,
      nextSelection: ModelSelectionRef,
      nextBorrowedDisposer?: () => void,
    ): Promise<void> => {
      if (this.stopping) {
        nextBorrowedDisposer?.()
        await nextHandle?.dispose()
        return
      }
      const previousHandle = this.handle
      this.borrowedApprovalDisposer?.()
      this.handle = nextHandle
      this.agent = nextAgent
      this.modelSelection = nextSelection
      this.borrowedApprovalDisposer = nextBorrowedDisposer
      const title = sessionTitle.get(nextAgent.session)?.title
      this.controller.attach(nextAgent, {
        model: `${selection.provider}/${selection.model}`,
        cwd: nextAgent.session.header.cwd ?? process.cwd(),
        ...(title === undefined ? {} : { title }),
      })
      this.controller.setCommands(commands.list(nextAgent))
      await previousHandle?.dispose()
      await nextAgent.whenIdle()
    }
    const activate = async (choice: SessionChoice): Promise<void> => {
      const requestedId = choice.kind === 'new' ? undefined : SessionId(choice.id)
      if (requestedId !== undefined && requestedId === this.agent?.id) return
      const agentOptions = { provider: selection.provider, model: selection.model }
      const nextSelection: ModelSelectionRef = { current: selection, assembled: undefined }
      const setup = (agentCtx: Context): void => {
        installModelSelection(agentCtx, nextSelection)
        agentCtx.on('approval/request', request => this.controller.requestApproval(request))
      }
      const live = requestedId === undefined ? undefined : agents.get(requestedId)
      let nextHandle: AgentHandle | undefined
      let nextAgent: AgentHandle['agent']
      let nextBorrowedDisposer: (() => void) | undefined
      if (live !== undefined) {
        nextAgent = live
        const approvalDisposer = live.ctx.on('approval/request', request => this.controller.requestApproval(request))
        const modelDisposer = installModelSelection(live.ctx, nextSelection)
        nextBorrowedDisposer = () => { approvalDisposer(); modelDisposer() }
      } else if (requestedId !== undefined && choice.kind === 'global') {
        const exists = (await persistence.list()).some(header => header.id === requestedId)
        nextHandle = exists
          ? await agents.resume({ resumeSessionId: requestedId, agentOptions, setup })
          : await agents.create({ sessionId: requestedId, meta: { cwd: process.cwd() }, agentOptions, setup })
        nextAgent = nextHandle.agent
      } else if (requestedId !== undefined) {
        nextHandle = await agents.resume({ resumeSessionId: requestedId, agentOptions, setup })
        nextAgent = nextHandle.agent
      } else {
        nextHandle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: startingCwd },
          agentOptions,
          setup,
        })
        nextAgent = nextHandle.agent
      }
      await adopt(nextAgent, nextHandle, nextSelection, nextBorrowedDisposer)
    }

    this.disposers.push(this.ctx.on('session/event', (session, _event) => {
      if (session === this.agent?.session) this.controller.update(session.events)
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent: changed, status }) => {
      if (changed === this.agent) this.controller.setStatus(status)
    }))
    this.disposers.push(this.ctx.on('commands/change', () => {
      if (this.agent !== undefined) this.controller.setCommands(commands.list(this.agent))
    }))
    let switching = false
    const runModelCommand = async (): Promise<void> => {
      const current = this.modelSelection?.current
      const choices = (await Promise.all(llm.listProviders().map(async (provider) => {
        try {
          return (await Promise.all((await llm.listModels(provider.id)).map(async (model) => {
            const resolved = await llm.resolveModelInfo(provider.id, model.id)
            const efforts = resolved.reasoning?.efforts ?? []
            const variants = efforts.length === 0
              ? [{ effort: undefined, name: undefined }]
              : [
                { effort: undefined, name: 'Provider default' },
                ...efforts.map(effort => ({ effort: String(effort.id), name: effort.name })),
              ]
            return variants.map(variant => ({
              id: `${provider.id}/${model.id}/${variant.effort ?? 'default'}`,
              provider: provider.id,
              model: model.id,
              ...(variant.effort === undefined ? {} : { reasoningEffort: variant.effort }),
              label: variant.name === undefined ? model.name : `${model.name} · ${variant.name}`,
              ...(model.description === undefined ? {} : { detail: model.description }),
              current: current?.provider === provider.id
                && current.model === model.id
                && current.reasoningEffort === variant.effort,
            }))
          }))).flat()
        } catch {
          return []
        }
      }))).flat()
      if (choices.length === 0) {
        this.controller.showNotice('No models are advertised by the configured providers.')
        return
      }
      const choice = await this.controller.chooseModel(choices)
      if (choice === undefined) return
      const resolved = await llm.resolveCallConfig({
        provider: choice.provider,
        model: choice.model,
        ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort as never }),
      })
      const ref = this.modelSelection
      if (ref === undefined) throw new Error('The active session has no model selection context.')
      ref.current = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
      this.controller.setModel(`${resolved.provider}/${resolved.model}${resolved.reasoningEffort === undefined ? '' : ` · ${resolved.reasoningEffort}`}`)
    }
    const attachImage = async (inputPath: string): Promise<void> => {
      if (this.controller.snapshot().draftAttachments.length >= attachments.imageLimits.maxImagesPerMessage) {
        throw new Error(`A message can contain at most ${attachments.imageLimits.maxImagesPerMessage} images.`)
      }
      const cwd = this.agent?.session.header.cwd ?? process.cwd()
      const path = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath)
      const mediaTypes: Record<string, ImageMediaType> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
      }
      const mediaType = mediaTypes[extname(path).toLowerCase()]
      if (mediaType === undefined) throw new Error('Supported image types: PNG, JPEG, WebP, and GIF.')
      const data = await readFile(path)
      const attachment = await attachments.saveImage({ data, mediaType, name: basename(path) })
      this.controller.addAttachment(attachment)
    }
    const runCommand = async (
      command: 'sessions' | 'new' | 'global' | 'model' | 'attach' | 'rename' | 'fork' | 'archive' | 'harness',
      argument?: string,
    ): Promise<void> => {
      if (switching) return
      switching = true
      try {
        if (command === 'harness') {
          const agent = this.agent
          if (agent === undefined || argument === undefined) throw new Error('No active session for this command.')
          const execution = await commands.execute(agent, argument, new AbortController().signal)
          if (execution === undefined) this.controller.showNotice(`Unknown command: ${argument.split(/\s/u, 1)[0] ?? argument}`)
          else if (execution.result.text !== undefined) this.controller.showNotice(execution.result.text)
          else this.controller.showNotice(execution.result.kind === 'success' ? 'Command completed.' : 'Command failed.')
          return
        }
        if (command === 'attach') {
          if (argument === undefined) throw new Error('Usage: /attach <image-path>')
          await attachImage(argument.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2'))
          return
        }
        if (command === 'rename') {
          const agent = this.agent
          if (agent === undefined || argument === undefined) throw new Error('Usage: /rename <title>')
          const renamed = sessionTitle.rename(agent.session, argument)
          this.controller.setTitle(renamed.title)
          return
        }
        if (command === 'fork') {
          const source = this.agent
          if (source === undefined) throw new Error('No active session to fork.')
          const currentSelection = this.modelSelection?.current ?? selection
          const nextSelection: ModelSelectionRef = { current: currentSelection, assembled: undefined }
          const setup = (agentCtx: Context): void => {
            installModelSelection(agentCtx, nextSelection)
            agentCtx.on('approval/request', request => this.controller.requestApproval(request))
          }
          const seed = [...source.session.events]
          const nextHandle = await agents.create({
            sessionId: SessionId(`session-${randomUUID()}`),
            seed,
            meta: {
              ...(source.session.header.cwd === undefined ? {} : { cwd: source.session.header.cwd }),
              parentSession: source.session.id,
              seedLength: seed.length,
            },
            agentOptions: {
              provider: currentSelection?.provider ?? selection.provider,
              model: currentSelection?.model ?? selection.model,
            },
            setup,
          })
          const sourceId = source.session.id
          await adopt(nextHandle.agent, nextHandle, nextSelection)
          this.controller.showNotice(`Forked from ${sourceId}.`)
          return
        }
        if (command === 'archive') {
          const archived = this.agent?.session.id
          if (archived === undefined) throw new Error('No active session to archive.')
          if (archived === GLOBAL_SESSION_ID) throw new Error('The global session cannot be archived.')
          await workspaceRegistry.archiveSession(archived)
          await activate({ id: 'new', label: 'New session', kind: 'new' })
          this.controller.showNotice(`Archived ${archived}.`)
          return
        }
        if (command === 'model') {
          await runModelCommand()
          return
        }
        const choice = command === 'new'
          ? { id: 'new', label: 'New session', kind: 'new' as const }
          : command === 'global'
            ? { id: String(GLOBAL_SESSION_ID), label: 'Global session', kind: 'global' as const }
            : await this.controller.chooseSession(await sessionChoices())
        if (choice !== undefined) await activate(choice)
      } catch (error: unknown) {
        this.controller.showNotice(error instanceof Error ? error.message : String(error))
      } finally {
        switching = false
      }
    }
    this.disposers.push(this.controller.setCommandHandler((command, argument) => { void runCommand(command, argument) }))

    const initialChoice = this.config.globalSession === true
      ? { id: String(GLOBAL_SESSION_ID), label: 'Global session', kind: 'global' as const }
      : this.config.sessionId !== undefined
        ? { id: this.config.sessionId, label: this.config.sessionId, kind: 'existing' as const }
        : await this.controller.chooseSession(await sessionChoices())
    if (initialChoice === undefined) {
      if (!this.stopping) { await this.cleanup(); this.io.exit(0) }
      return
    }
    await activate(initialChoice)
    if (this.stopping) {
      const handle = this.handle
      this.handle = undefined
      this.agent = undefined
      if (handle !== undefined) await handle.dispose()
      return
    }

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
    this.borrowedApprovalDisposer?.()
    this.borrowedApprovalDisposer = undefined
    const handle = this.handle
    this.handle = undefined
    this.agent = undefined
    this.modelSelection = undefined
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
    const task = runtime.start().catch(async (error: unknown) => {
      internals.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
      await runtime.stop()
      exit(1)
    })
    return async () => {
      await runtime.stop()
      await task
    }
  }, 'tui.run')
}
