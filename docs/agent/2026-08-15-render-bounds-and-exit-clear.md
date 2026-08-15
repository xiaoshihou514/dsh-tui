# Render bounds and exit clearing

## Code block bounds

Percentage widths inside the assistant row were resolved without a definite-width parent, allowing a fenced code block to claim the root terminal width in addition to the three-column transcript gutter. Markdown now receives an explicit terminal-minus-gutter width, and both its root and fenced blocks use that numeric border-box bound. The regression fixture includes wide CJK glyphs and asserts display-cell width with `string-width`.

## Exit clearing

Ink deliberately leaves its final dynamic frame on `unmount()`. That made the three-row composer surface remain above the restored shell prompt. User-triggered exits now call the renderer's `clear()` immediately before Ink unmounts; lifecycle-triggered unmounts do the same. Clearing is restricted to shutdown so native static transcript history is not disturbed during ordinary rendering.
