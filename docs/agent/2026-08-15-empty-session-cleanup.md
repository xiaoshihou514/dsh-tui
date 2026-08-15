# Empty session cleanup

## Decision

Only ordinary sessions created by the TUI are cleanup candidates. If the user exits or switches away before sending an ordinary user message, the runtime archives that session before releasing its agent handle. Resumed, global, borrowed-live, and forked sessions are never implicit cleanup candidates.

The runtime records message acceptance at the controller boundary instead of waiting for a `user/message` event. This avoids an exit race between `agent.followup()` and asynchronous session-event delivery. Local slash commands do not preserve an otherwise empty session.

## Harness constraint

Session persistence is append-only and exposes no physical delete operation. Brand-new sessions are lazily materialized, while `workspaceRegistry.archiveSession()` is the supported durable way to remove a known session from user-facing listings. Consequently, “delete on exit” is implemented as retirement through the workspace archive API.
