/** UI-facing state and interaction queues for one root Harness agent. */

import { EventEmitter } from 'node:events'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  UserQuestionError,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { projectTranscript, type TranscriptEntry } from './transcript.ts'

/** Approval data the terminal needs to present. */
export interface PendingApproval {
  readonly toolName: string
  readonly reason?: string
}

/** Complete observable state consumed by the renderer. */
export interface TuiSnapshot {
  readonly entries: readonly TranscriptEntry[]
  readonly status: AgentStatus
  readonly approval?: PendingApproval
  readonly question?: AskUserQuestionRequest
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
  private status: AgentStatus = 'idle'
  private agent: Agent | undefined
  private approvalQueue: ApprovalWaiter[] = []
  private questionQueue: QuestionWaiter[] = []

  /** Attach the exact root agent this controller may drive. */
  attach(agent: Agent): void {
    this.agent = agent
    this.events = agent.session.events
    this.status = agent.status
    this.emit()
  }

  /** Replace the canonical log prefix after a session notification. */
  update(events: readonly SessionEvent[]): void {
    this.events = events
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
    return {
      entries: projectTranscript(this.events),
      status: this.status,
      ...(approval === undefined ? {} : {
        approval: {
          toolName: approval.toolName,
          ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        },
      }),
      ...(this.questionQueue[0] === undefined ? {} : { question: this.questionQueue[0].request }),
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
    if (prompt === '') return
    const agent = this.requireAgent()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
  }

  /** Interrupt current agent activity without arming future work. */
  cancel(): void {
    this.agent?.cancel({ kind: 'user' })
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
    for (const waiter of [...this.approvalQueue]) this.finishApproval(waiter, 'cancelled')
    for (const waiter of [...this.questionQueue]) {
      this.finishQuestion(waiter, new UserQuestionError('terminal interface closed', 'ASK_ABORTED'))
    }
    this.changes.removeAllListeners()
    this.agent = undefined
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
