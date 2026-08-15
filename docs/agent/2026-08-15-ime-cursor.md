# IME cursor positioning

IME candidate windows follow the terminal's hardware cursor. The composer previously drew an inverse character as a visual cursor but never told Ink where the real cursor belonged, leaving IME UI at the live region's bottom-left corner.

The editor now renders plain text and reports a hardware cursor position through Ink's public `useCursor` API. The position is derived from the editor element's computed Yoga coordinates plus the Unicode display width and wrapped line count before the logical cursor. The cursor consumes no layout cell, uses the terminal's configured shape, and gives IMEs a real screen anchor.

Cursor coordinates are recomputed after every committed layout, not only after text changes. This is required because activity, approval, and completion panels can move the composer without changing its draft.

The composer frame is rendered from fixed-width text rows instead of Ink's `borderStyle`. Cursor-only repaints could otherwise leave Ink's right border missing from the content row or paint a copy at the cursor column. Each wrapped input row gets its own explicit left and right edge, so moving the hardware cursor cannot alter frame geometry.

Logical cursor and draft values are mirrored in synchronous refs. Ink refreshes input subscriptions after renders, so consecutive control and printable key events must not depend on a callback closure from the previous frame. Ctrl+A/E, Ctrl+B/F, Home, End, Ctrl+Backspace, and Ctrl+W are consumed before ordinary text insertion.

An isolated tmux screen capture at 80 columns confirmed that Ctrl+A leaves the right frame edge at column 79 and changes only the hardware cursor coordinate from column 9 to column 5. On terminals with a cyan bar cursor, the cursor and the old cyan `│` edge were visually indistinguishable. Frame edges are now neutral gray while the prompt and native cursor remain the active accent, so cursor movement cannot look like border movement.

An attempted workaround forced full repaints by appending cursor-dependent U+200B and U+2060 format characters. It was removed after reproducing the failure in Kitty: although JavaScript width libraries report those characters as zero cells, sending them to a terminal's shaping stack is not layout-neutral. Placing them at the end of the fixed-width editor could consume or damage the following right-border cell in the graphical grid. Cursor navigation now changes only Ink's hardware-cursor position and never sends invisible text payload as part of the editor line.

Kitty can retain a correct `get-text` cell model while its rendered output is visually different, so model-level captures alone are insufficient verification. A later attempted targeted repair wrote `│` directly at a captured `frameWidth`. Rapid Ctrl+A bursts after Kitty's startup resize proved that callback could retain the old 96-column width while the live frame had grown to 147 columns, creating the apparent drifting border in the middle of the editor. The manual ANSI write was removed; frame edges are owned exclusively by Ink's current layout.

A 50-event zero-delay Ctrl+A pixel capture confirmed that the remaining middle bar was a selectable box-drawing cell, not a second cursor. Ink's resize handler clears its previous output when terminal width decreases but does not clear when width increases. Kitty created the window at 96 columns before expanding it to 147, leaving the original right edge behind inside the new frame. `renderTui` now schedules one clear-and-rerender after Ink processes every resize. This keeps static scrollback intact while replacing the complete live region at its current dimensions.

Inspecting Kitty's selectable text exposed a second half of the resize bug: the horizontal frame strings were 147 columns wide while the content row's right edge remained at column 96. Reading `stdout.columns` during render does not subscribe React to changes, so Yoga retained the old editor constraint. The composer now owns terminal-column state and subscribes to stdout's `resize` event. Frame width and editor width therefore change together in a committed layout instead of mixing new literal strings with old Yoga geometry.

The requested width alone was insufficient because Yoga's default shrinking kept the frame container at its stale 96-column parent constraint; only the unwrapped horizontal `Text` visibly overflowed to 147. The frame is now `flexShrink={0}`, making the horizontal rows and flex content row honor the same terminal-derived width.

Pixel and selectable-text verification showed that `flexShrink={0}` alone did not override the editor's explicit `minWidth={0}`. The editor, frame, and content row now use their computed terminal widths as both `width` and `minWidth`, removing the contradictory style that allowed only the content row to collapse.

Kitty's PTY reached 147 columns after Ink had initialized its Yoga root at 96, and the initial resize notification could occur before the application subscribed. `renderTui` now emits one startup reflow after 250 ms, once the OS window has settled, so Ink recalculates its root width before interactive input begins.

The PTY and Kitty both reported 147 columns while Yoga constrained the flex content row to 96. To avoid mixing a 147-column literal horizontal border with a 96-column flex row, the composer now has a 96-column readability cap. Every side is generated from that single width; narrower terminals still use their available width.

The border geometry was ultimately removed by design. The composer is now a three-row background surface: a blank padded row, one atomic prompt/input row, and another blank padded row. No box-drawing edge exists to become stale or be confused with the hardware cursor, and the surface can use the available terminal width safely.
