# Harness plugin research

## Decision

`dsh-tui` will ship as an out-of-tree DeepSeek Harness bundle containing an in-process Cordis surface plugin. The bundle will layer over `@deepseek-ai/dsh-base`, add a TUI startup provider and runtime, and leave the agent loop, tools, persistence, and model adapters in Harness.

## Evidence

- Harness composes every feature as a Cordis plugin. An installable package declares `dsh.bundle.patch` in `package.json`; `dsh plugin --profile tui add <package>` installs the package and adds its patch to the profile.
- Harness architecture directs UI integrations to drive `ctx.agents` and render `session/event`.
- The base bundle already mounts the session store, agent registry and loop, interaction services, tools, persistence, permission presets, commands, plans, goals, subagents, and model adapters. The TUI bundle should not duplicate them.
- The JSON-RPC SDK server exposes `initialize`, `session/prompt`, and `shutdown`, plus session, status, and local-subagent notifications. It does not expose cancellation, session close, approval answers, or user-question answers. Those gaps prevent the approval-first interactive milestone.
- Approval is a scoped `approval/request` waterfall. A TUI answerer must call `next()` for agents it does not own and return a closed `ApprovalOutcome` only for its root agent.
- User questions use one registered `UserQuestionProvider`; registration returns a disposer and delegated child agents are rejected by the service before reaching the provider.

## Initial topology

The package will contain these responsibilities:

- `startup`: parse TUI-owned command-line options from the Harness argument snapshot and publish immutable startup state.
- `runtime`: create or resume one root agent, mount scoped approval handling, register the user-question provider, subscribe to durable session events and live status, and own terminal teardown.
- `ui`: maintain a deterministic presentation model and render it. Terminal-library details stay behind this layer so lifecycle and event projection can be tested without a real TTY.
- `cordis.patch.yml`: add the startup and runtime rows over `dsh-base`, including the code-runtime worker needed by the coding surface.

## First milestone

One interactive root session must support:

1. prompt submission and streamed assistant output;
2. tool-call and tool-result presentation from the durable log;
3. cancellation of the active turn;
4. approval decisions with fail-closed cancellation;
5. user-question answers;
6. deterministic shutdown that restores terminal state and disposes the agent.

Resume, search, attachments, rich composition views, and customization remain later work.

## Constraints

- Rendering derives from `session/event`; model-visible data is never maintained in a parallel TUI-only transcript.
- Registrations and subscriptions are Cordis effects and prove disposal in tests.
- The TUI owns only its root agent. Child-agent activity may be displayed from durable lineage, but interactive requests from owned children remain unavailable under the Harness interaction contract.
- Errors and diagnostics go to stderr. Terminal presentation owns stdout while active.
- The package targets the Harness pre-release API directly; compatibility shims are deferred until Harness publishes a stable plugin contract.

## Prior art

DeepSeek Reasonix's Bubble Tea frontend demonstrates the desired UX breadth: a multiline composer, streaming transcript, slash completion, resume and rewind pickers, approval and question flows, model and effort selectors, status lines, paste handling, mouse behavior, and diagnostics. `dsh-tui` will initially borrow interaction ideas only where Harness already exposes an owning service or event.

## Open risks

- Harness session-event payloads are merge-extensible. The projection must switch on known discriminants and preserve an explicit generic fallback.
- Streaming uses durable `assistant/chunk` records, so rendering must coalesce chunks without losing replay fidelity or duplicating the final `assistant/message`.
- A terminal renderer and Cordis both have asynchronous lifecycles. One runtime owner must coordinate signal handling, renderer exit, agent disposal, and root shutdown without double-disposal.
- The unpublished `turtle-ui` example referenced by Harness documentation was not available at its documented GitHub location during this investigation, so the checked-in Harness bundle and plugin contracts are the implementation authority.
