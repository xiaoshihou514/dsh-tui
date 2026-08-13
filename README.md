<p align="center"><img src="assets/logo.png" width="160" alt="dsh-tui logo"></p>
<h1 align="center">dsh-tui</h1>
<p align="center">A terminal interface for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</p>

`dsh-tui` runs inside the Harness plugin tree. Harness still owns the agent loop, tools, sessions, permissions, and model adapters. This plugin adds an interactive terminal surface over those services.

The current alpha supports one fresh interactive session. It streams assistant output, renders tool calls and results, handles approvals and user questions, and interrupts the active turn without discarding later input.

## Install

You need DeepSeek Harness, Node.js 22.19 or later, and pnpm.

Install the plugin into a dedicated profile:

```sh
dsh plugin --profile tui add github:xiaoshihou514/dsh-tui
dsh --profile tui
```

pnpm 10 and later may block the package's `prepare` script on the first Git install. If that happens, copy the package key from pnpm's error into the profile's `pnpm-workspace.yaml` under `allowBuilds`, then run the install command again. The script compiles the TypeScript entry points shipped by this repository. Registry packages and release tarballs contain built files and do not need install-time build permission.

To install a local checkout:

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
dsh plugin --profile tui add .
```

Harness reads credentials through its normal credentials service. Set `DEEPSEEK_API_KEY` or use the Harness settings flow before submitting a prompt.

## Controls

| Input | Action |
|---|---|
| Enter | Submit the prompt |
| Esc | Interrupt the running turn |
| Ctrl+C | Interrupt while running; exit while idle |
| y | Allow the pending action once |
| n or Esc | Reject the pending action |

Question prompts list numbered options. Enter one number for a single choice, comma-separated numbers for a multiple choice, or free text for a custom answer.

## What it displays

- Direct user prompts from the durable session log
- Reasoning and assistant text while the provider streams
- Final assistant messages without duplicated raw chunks
- Tool names, raw arguments, results, and failures
- Turn interruption, token-limit, and provider errors
- Harness approval reasons and structured user questions

Surface replacement records created by compaction stay out of the human transcript. The original append-only conversation remains visible, following the Harness session contract.

## Known limits

- Every launch creates a new session. Session resume and selection are not available yet.
- The composer is single-line and does not accept attachments.
- Tool output is rendered as text. Harness tool-specific render intents are not interpreted yet.
- Subagent events remain in the parent session's ordinary tool transcript; there is no separate subagent view.

## Development

The implementation is split into three parts: `src/transcript.ts` projects durable events, `src/controller.ts` owns live interaction queues, and `src/ui.tsx` renders the current state with Ink. Design notes and package-smoke evidence live in [`docs/agent`](docs/agent).

Run the local checks with:

```sh
pnpm run check
pnpm test
pnpm run build
pnpm run lint:package
pnpm pack --pack-destination /tmp
```

[MIT](LICENSE)
