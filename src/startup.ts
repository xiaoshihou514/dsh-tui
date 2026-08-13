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
}

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run DeepSeek Harness in an interactive terminal interface.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'optional prompt to submit after startup')
    .addHelpText('after', `
Examples:
  dsh --profile tui
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
    const values: TuiStartupValues = prompt === '' ? {} : { initialPrompt: prompt }
    ctx.provide(TUI_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
