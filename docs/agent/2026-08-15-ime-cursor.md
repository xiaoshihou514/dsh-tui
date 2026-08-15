# IME cursor positioning

IME candidate windows follow the terminal's hardware cursor. The composer previously drew an inverse character as a visual cursor but never told Ink where the real cursor belonged, leaving IME UI at the live region's bottom-left corner.

The editor now renders plain text and reports a hardware cursor position through Ink's public `useCursor` API. The position is derived from the editor element's computed Yoga coordinates plus the Unicode display width and wrapped line count before the logical cursor. The cursor consumes no layout cell, uses the terminal's configured shape, and gives IMEs a real screen anchor.
