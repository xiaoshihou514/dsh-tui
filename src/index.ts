/** In-process terminal surface for DeepSeek Harness. @module dsh-tui */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

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

/**
 * Mount the TUI runtime.
 * @param _ctx - plugin context carrying Harness services.
 * @param _config - validated startup values.
 */
export function apply(_ctx: Context, _config: Config): void {
  throw new Error('dsh-tui runtime is not implemented yet')
}
