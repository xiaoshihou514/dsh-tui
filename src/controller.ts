/** UI-facing state and interaction queues for one root Harness agent. */

import { EventEmitter } from 'node:events'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  UserQuestionError,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { TranscriptProjector, type TranscriptEntry } from './transcript.ts'

/** Approval data the terminal needs to present. */
export interface PendingApproval {
  readonly toolName: string
  readonly reason?: string
}

/** One startup destination shown by the terminal session picker. */
export interface SessionChoice {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly kind: 'new' | 'global' | 'existing'
}

/** One provider/model route shown by the terminal model picker. */
export interface ModelChoice {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly label: string
  readonly detail?: string
  readonly current: boolean
}

/** Complete observable state consumed by the renderer. */
export interface TuiSnapshot {
  readonly entries: readonly TranscriptEntry[]
  readonly status: AgentStatus
  readonly approval?: PendingApproval
  readonly question?: AskUserQuestionRequest
  readonly sessionChoices?: readonly SessionChoice[]
  readonly modelChoices?: readonly ModelChoice[]
  readonly identity?: { readonly sessionId: string; readonly model: string; readonly cwd?: string; readonly title?: string }
  readonly panel?: 'help'
  readonly notice?: string
  readonly draftAttachments: readonly ImageAttachmentRef[]
  readonly commands: readonly CommandDescriptor[]
  readonly todos: readonly TodoItem[]
  readonly planMode: boolean
  readonly goal?: {
    readonly objective: string
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    readonly roundsStarted: number
    readonly maxGoalRounds: number
    readonly blockedReason?: string
  }
}

interface GoalChangeData {
  readonly kind: 'goal/change'
  readonly operation: string
  readonly goal?: {
    readonly objective: string
    readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
    readonly maxGoalRounds: number
    readonly blockedReason?: { readonly message: string }
  }
  readonly roundsStarted?: number
}

type ControllerCommand = 'sessions' | 'new' | 'global' | 'model' | 'attach' | 'rename' | 'fork' | 'archive' | 'harness'

interface ParsedCommand {
  readonly name: Exclude<ControllerCommand, 'harness'>
  readonly argument?: string
}

function parseCommand(prompt: string): ParsedCommand | undefined {
  switch (prompt) {
    case '/sessions': return { name: 'sessions' }
    case '/new': return { name: 'new' }
    case '/global': return { name: 'global' }
    case '/model': return { name: 'model' }
    case '/fork': return { name: 'fork' }
    case '/archive': return { name: 'archive' }
  }

  const match = /^\/(attach|rename)(?:\s+(.+))?$/.exec(prompt)
  if (match === null) return undefined
  const name = match[1]
  if (name !== 'attach' && name !== 'rename') return undefined
  const argument = match[2]?.trim()
  return { name, ...(argument === undefined ? {} : { argument }) }
}

function workspaceState(events: readonly SessionEvent[]): Pick<TuiSnapshot, 'planMode' | 'goal'> {
  let planMode = false
  let goal: TuiSnapshot['goal']
  let foundPlanMode = false
  let foundGoal = false
  for (let index = events.length - 1; index >= 0 && (!foundPlanMode || !foundGoal); index--) {
    const event = events[index]
    if (event === undefined) continue
    const durable = event as unknown as { readonly type: string; readonly data: unknown }
    if (!foundPlanMode && durable.type === 'plan/mode') {
      const data = durable.data as { readonly active?: unknown }
      if (typeof data.active === 'boolean') planMode = data.active
      foundPlanMode = true
    }
    if (!foundGoal && durable.type === 'goal/change') {
      const data = durable.data as GoalChangeData
      if (data.kind !== 'goal/change') continue
      if (data.operation === 'clear' || data.goal === undefined) goal = undefined
      else goal = {
        objective: data.goal.objective,
        phase: data.goal.phase,
        roundsStarted: data.roundsStarted ?? 0,
        maxGoalRounds: data.goal.maxGoalRounds,
        ...(data.goal.blockedReason === undefined ? {} : { blockedReason: data.goal.blockedReason.message }),
      }
      foundGoal = true
    }
  }
  return { planMode, ...(goal === undefined ? {} : { goal }) }
}

interface ApprovalWaiter {
  readonly request: ApprovalRequest
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly onAbort: () => void
}

interface QuestionWaiter {
  readonly request: AskUserQuestionRequest
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly onAbort: () => void
}

/** Mutable controller shared by the Cordis runtime and terminal renderer. */
export class TuiController implements UserQuestionProvider {
  private readonly changes = new EventEmitter()
  private events: readonly SessionEvent[] = []
  private projector = new TranscriptProjector()
  private projected = 0
  private status: AgentStatus = 'idle'
  private agent: Agent | undefined
  private approvalQueue: ApprovalWaiter[] = []
  private questionQueue: QuestionWaiter[] = []
  private sessionChoice: {
    choices: readonly SessionChoice[]
    resolve: (choice: SessionChoice | undefined) => void
  } | undefined
  private modelChoice: {
    choices: readonly ModelChoice[]
    resolve: (choice: ModelChoice | undefined) => void
  } | undefined
  private identity: TuiSnapshot['identity']
  private panel: TuiSnapshot['panel']
  private notice: string | undefined
  private command: ((command: ControllerCommand, argument?: string) => void) | undefined
  private userMessageSent: (() => void) | undefined
  private draftAttachments: ImageAttachmentRef[] = []
  private commands: readonly CommandDescriptor[] = []

  /** Attach the exact root agent this controller may drive. */
  attach(agent: Agent, identity?: Omit<NonNullable<TuiSnapshot['identity']>, 'sessionId'>): void {
    this.agent = agent
    this.events = agent.session.events
    this.projector = new TranscriptProjector()
    for (const event of this.events) this.projector.push(event)
    this.projected = this.events.length
    this.status = agent.status
    this.identity = {
      sessionId: String(agent.session.id),
      model: identity?.model ?? 'default model',
      ...(identity?.cwd === undefined ? {} : { cwd: identity.cwd }),
      ...(identity?.title === undefined ? {} : { title: identity.title }),
    }
    this.emit()
  }

  /** Replace the canonical log prefix after a session notification. */
  update(events: readonly SessionEvent[]): void {
    this.events = events
    if (events.length < this.projected) {
      // The durable log shrank (compaction): rebuild from the prefix.
      this.projector = new TranscriptProjector()
      for (const event of events) this.projector.push(event)
    } else {
      for (let index = this.projected; index < events.length; index++) {
        const event = events[index]
        if (event !== undefined) this.projector.push(event)
      }
    }
    this.projected = events.length
    this.emit()
  }

  /** Record a whole-agent status transition. */
  setStatus(status: AgentStatus): void {
    this.status = status
    this.emit()
  }

  /** Read the current renderer state. */
  snapshot(): TuiSnapshot {
    const approval = this.approvalQueue[0]?.request
    const todoEvent = this.events.findLast(event => event.type === 'todo/write')
    return {
      // The transcript is projected incrementally (one event at a time) and
      // rendered through Ink's <Static>, so the terminal owns scrolling and
      // history. No windowing happens here.
      entries: this.projector.entries,
      status: this.status,
      ...(approval === undefined ? {} : {
        approval: {
          toolName: approval.toolName,
          ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        },
      }),
      ...(this.questionQueue[0] === undefined ? {} : { question: this.questionQueue[0].request }),
      ...(this.sessionChoice === undefined ? {} : { sessionChoices: this.sessionChoice.choices }),
      ...(this.modelChoice === undefined ? {} : { modelChoices: this.modelChoice.choices }),
      ...(this.identity === undefined ? {} : { identity: this.identity }),
      ...(this.panel === undefined ? {} : { panel: this.panel }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      draftAttachments: this.draftAttachments,
      commands: this.commands,
      todos: todoEvent?.type === 'todo/write' ? todoEvent.data.todos : [],
      ...workspaceState(this.events),
    }
  }

  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void {
    this.changes.on('change', listener)
    return () => { this.changes.off('change', listener) }
  }

  /** Submit one ordinary user turn. */
  submit(text: string): void {
    const prompt = text.trim()
    if (prompt === '' && this.draftAttachments.length === 0) return
    if (prompt === '/help' || prompt === '/?') {
      this.panel = this.panel === 'help' ? undefined : 'help'
      this.emit()
      return
    }
    if (prompt === '/clear-attachments') {
      this.draftAttachments = []
      this.notice = 'Draft attachments cleared.'
      this.emit()
      return
    }
    const command = parseCommand(prompt)
    if (command !== undefined) {
      if (this.status === 'running' && command.name !== 'attach' && command.name !== 'rename') this.showNotice('Interrupt the active turn before changing session settings.')
      else if (command.name === 'attach' && command.argument === undefined) this.showNotice('Usage: /attach <image-path>')
      else if (command.name === 'rename' && command.argument === undefined) this.showNotice('Usage: /rename <title>')
      else this.command?.(command.name, command.argument)
      return
    }
    if (prompt.startsWith('/')) {
      this.command?.('harness', prompt)
      return
    }
    this.notice = undefined
    const agent = this.requireAgent()
    const attachments = this.draftAttachments
    agent.followup(createUserMessage({
      content: [
        ...attachments.map(attachment => ({ type: 'image' as const, attachment })),
        ...(prompt === '' ? [] : [{ type: 'text' as const, text: prompt }]),
      ],
      source: { kind: 'user' },
    }))
    this.userMessageSent?.()
    this.draftAttachments = []
    this.emit()
  }

  /** Interrupt current agent activity without arming future work. */
  cancel(): void {
    this.agent?.cancel({ kind: 'user' })
  }

  /** Close the active local-only panel. */
  dismissPanel(): void {
    if (this.panel === undefined) return
    this.panel = undefined
    this.emit()
  }

  /** Install runtime-owned session commands used by the local command palette. */
  setCommandHandler(handler: (command: ControllerCommand, argument?: string) => void): () => void {
    this.command = handler
    return () => { if (this.command === handler) this.command = undefined }
  }

  /** Observe accepted ordinary messages, excluding local and Harness commands. */
  setUserMessageSentHandler(handler: () => void): () => void {
    this.userMessageSent = handler
    return () => { if (this.userMessageSent === handler) this.userMessageSent = undefined }
  }

  /** Replace command-completion metadata for the active agent scope. */
  setCommands(commands: readonly CommandDescriptor[]): void {
    this.commands = commands
    this.emit()
  }

  /** Add one validated durable image to the next submitted message. */
  addAttachment(attachment: ImageAttachmentRef): void {
    this.draftAttachments.push(attachment)
    this.notice = `Attached ${attachment.name ?? 'image'} (${attachment.width}×${attachment.height}).`
    this.emit()
  }

  /** Show a concise non-durable interface notice. */
  showNotice(message: string): void {
    this.notice = message
    this.emit()
  }

  /** Ask the startup UI which durable conversation to open. */
  chooseSession(choices: readonly SessionChoice[]): Promise<SessionChoice | undefined> {
    return new Promise((resolve) => {
      this.sessionChoice = { choices, resolve }
      this.emit()
    })
  }

  /** Complete the startup session picker. Undefined means exit without attaching. */
  selectSession(choice: SessionChoice | undefined): void {
    const pending = this.sessionChoice
    if (pending === undefined) return
    this.sessionChoice = undefined
    pending.resolve(choice)
    this.emit()
  }

  /** Ask the UI to select an available provider/model route. */
  chooseModel(choices: readonly ModelChoice[]): Promise<ModelChoice | undefined> {
    return new Promise((resolve) => {
      this.modelChoice = { choices, resolve }
      this.emit()
    })
  }

  /** Complete or dismiss the model picker. */
  selectModel(choice: ModelChoice | undefined): void {
    const pending = this.modelChoice
    if (pending === undefined) return
    this.modelChoice = undefined
    pending.resolve(choice)
    this.emit()
  }

  /** Reflect the active next-step model in the terminal header. */
  setModel(model: string): void {
    if (this.identity === undefined) return
    this.identity = { ...this.identity, model }
    this.notice = `Model changed to ${model}.`
    this.emit()
  }

  /** Reflect a durable user rename in the terminal header. */
  setTitle(title: string): void {
    if (this.identity === undefined) return
    this.identity = { ...this.identity, title }
    this.notice = `Renamed conversation to “${title}”.`
    this.emit()
  }

  /** Queue one scoped approval request for terminal input. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return Promise.resolve('cancelled')
    return new Promise((resolve) => {
      const waiter: ApprovalWaiter = {
        request,
        resolve,
        onAbort: () => { this.finishApproval(waiter, 'cancelled') },
      }
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.approvalQueue.push(waiter)
      this.emit()
    })
  }

  /** Resolve the approval currently shown in the terminal. */
  decideApproval(outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>): void {
    const waiter = this.approvalQueue[0]
    if (waiter !== undefined) this.finishApproval(waiter, outcome)
  }

  /** Queue a user-question request for terminal input. */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      return Promise.reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    return new Promise((resolve, reject) => {
      const waiter: QuestionWaiter = {
        request,
        resolve,
        reject,
        onAbort: () => {
          this.finishQuestion(waiter, new UserQuestionError(
            'ask_user_question was aborted before the user answered',
            'ASK_ABORTED',
          ))
        },
      }
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.questionQueue.push(waiter)
      this.emit()
    })
  }

  /** Resolve the question set currently shown in the terminal. */
  answer(answer: AskUserQuestionAnswer): void {
    const waiter = this.questionQueue[0]
    if (waiter === undefined) return
    this.removeQuestion(waiter)
    waiter.resolve(answer)
  }

  /** Fail closed and settle every pending interaction during teardown. */
  close(): void {
    this.selectSession(undefined)
    this.selectModel(undefined)
    for (const waiter of [...this.approvalQueue]) this.finishApproval(waiter, 'cancelled')
    for (const waiter of [...this.questionQueue]) {
      this.finishQuestion(waiter, new UserQuestionError('terminal interface closed', 'ASK_ABORTED'))
    }
    this.changes.removeAllListeners()
    this.agent = undefined
    this.identity = undefined
    this.command = undefined
  }

  private requireAgent(): Agent {
    if (this.agent === undefined) throw new Error('dsh-tui agent is not ready')
    return this.agent
  }

  private finishApproval(waiter: ApprovalWaiter, outcome: ApprovalOutcome): void {
    const index = this.approvalQueue.indexOf(waiter)
    if (index === -1) return
    this.approvalQueue.splice(index, 1)
    waiter.request.signal?.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(outcome)
    this.emit()
  }

  private removeQuestion(waiter: QuestionWaiter): void {
    const index = this.questionQueue.indexOf(waiter)
    if (index === -1) return
    this.questionQueue.splice(index, 1)
    waiter.request.signal?.removeEventListener('abort', waiter.onAbort)
    this.emit()
  }

  private finishQuestion(waiter: QuestionWaiter, error: Error): void {
    if (!this.questionQueue.includes(waiter)) return
    this.removeQuestion(waiter)
    waiter.reject(error)
  }

  private emit(): void {
    this.changes.emit('change')
  }
}
