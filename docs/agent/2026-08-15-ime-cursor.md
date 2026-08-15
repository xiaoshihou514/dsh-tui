# IME cursor positioning

IME candidate windows follow the terminal's hardware cursor. The composer previously drew an inverse character as a visual cursor but never told Ink where the real cursor belonged, leaving IME UI at the live region's bottom-left corner.

The editor now renders plain text and reports a hardware cursor position through Ink's public `useCursor` API. The position is derived from the editor element's computed Yoga coordinates plus the Unicode display width and wrapped line count before the logical cursor. The cursor consumes no layout cell, uses the terminal's configured shape, and gives IMEs a real screen anchor.

Cursor coordinates are recomputed after every committed layout, not only after text changes. This is required because activity, approval, and completion panels can move the composer without changing its draft.

The composer frame is rendered from fixed-width text rows instead of Ink's `borderStyle`. Cursor-only repaints could otherwise leave Ink's right border missing from the content row or paint a copy at the cursor column. Each wrapped input row gets its own explicit left and right edge, so moving the hardware cursor cannot alter frame geometry.

Logical cursor and draft values are mirrored in synchronous refs. Ink refreshes input subscriptions after renders, so consecutive control and printable key events must not depend on a callback closure from the previous frame. Ctrl+A/E, Ctrl+B/F, Home, End, Ctrl+Backspace, and Ctrl+W are consumed before ordinary text insertion.

An isolated tmux screen capture at 80 columns confirmed that Ctrl+A leaves the right frame edge at column 79 and changes only the hardware cursor coordinate from column 9 to column 5. On terminals with a cyan bar cursor, the cursor and the old cyan `│` edge were visually indistinguishable. Frame edges are now neutral gray while the prompt and native cursor remain the active accent, so cursor movement cannot look like border movement.

An attempted workaround forced full repaints by appending cursor-dependent U+200B and U+2060 format characters. It was removed after reproducing the failure in Kitty: although JavaScript width libraries report those characters as zero cells, sending them to a terminal's shaping stack is not layout-neutral. Placing them at the end of the fixed-width editor could consume or damage the following right-border cell in the graphical grid. Cursor navigation now changes only Ink's hardware-cursor position and never sends invisible text payload as part of the editor line.
