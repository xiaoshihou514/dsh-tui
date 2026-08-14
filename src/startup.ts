/** Command-line provider for the dsh-tui surface. @module dsh-tui/startup */

import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { Command } from 'commander'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before command-line parsing starts. */
export const inject = ['cmdlineArgs']

/** Service published for the runtime row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** Immutable values resolved from this invocation. */
export interface TuiStartupValues {
  /** Optional prompt submitted after the terminal surface is ready. */
  initialPrompt?: string
  /** Reuse the stable, shared global session across invocations. */
  globalSession?: boolean
  /** Resume one existing Harness session by id. */
  sessionId?: string
}

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run DeepSeek Harness in an interactive terminal interface.')
    .helpOption('-h, --help', 'show this help')
    .option('--global', 'use the shared global session')
    .option('--session <id>', 'attach to an existing Harness session')
    .argument('[prompt...]', 'optional prompt to submit after startup')
    .addHelpText('after', `
Examples:
  dsh --profile tui
  dsh --profile tui --global
  dsh --profile tui --session <session-id>
  dsh --profile tui "explain this repository"
`)
}

/**
 * Parse TUI-owned arguments and publish the startup service.
 * @param ctx - plugin context carrying the immutable Harness command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const prompt = program.args.join(' ').trim()
    const options = program.opts<{ global?: boolean; session?: string }>()
    if (options.global === true && options.session !== undefined) {
      program.error('--global and --session cannot be used together')
    }
    const sessionId = options.session?.trim()
    if (options.session !== undefined && sessionId === '') program.error('--session requires a non-empty id')
    const values: TuiStartupValues = {
      ...(prompt === '' ? {} : { initialPrompt: prompt }),
      ...(options.global === true ? { globalSession: true } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    ctx.provide(TUI_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
