# IME cursor positioning

IME candidate windows follow the terminal's hardware cursor. The composer previously drew an inverse character as a visual cursor but never told Ink where the real cursor belonged, leaving IME UI at the live region's bottom-left corner.

The editor now renders plain text and reports a hardware cursor position through Ink's public `useCursor` API. The position is derived from the editor element's computed Yoga coordinates plus the Unicode display width and wrapped line count before the logical cursor. The cursor consumes no layout cell, uses the terminal's configured shape, and gives IMEs a real screen anchor.

Cursor coordinates are recomputed after every committed layout, not only after text changes. This is required because activity, approval, and completion panels can move the composer without changing its draft.

The composer frame is rendered from fixed-width text rows instead of Ink's `borderStyle`. Cursor-only repaints could otherwise leave Ink's right border missing from the content row or paint a copy at the cursor column. Each wrapped input row gets its own explicit left and right edge, so moving the hardware cursor cannot alter frame geometry.

Logical cursor and draft values are mirrored in synchronous refs. Ink refreshes input subscriptions after renders, so consecutive control and printable key events must not depend on a callback closure from the previous frame. Ctrl+A/E, Ctrl+B/F, Home, End, Ctrl+Backspace, and Ctrl+W are consumed before ordinary text insertion.
