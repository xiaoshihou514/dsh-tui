# Streaming output rendering

Reasoning is transient UI state, not transcript content. While the model is reasoning, the TUI now collapses whitespace and keeps only the newest terminal-width slice visible. As soon as answer text arrives, or the assistant message is finalized, the reasoning line is removed.

Assistant output is parsed with Marked's GFM lexer and rendered as Ink elements. We do not generate terminal HTML or trust ANSI sequences from model output. Native elements preserve terminal wrapping and let the TUI style headings, emphasis, lists, quotations, code blocks, links, images, rules, and tables consistently. Incomplete Markdown is parsed on each streaming update and falls back to visible source text when a construct has not closed yet.

Code blocks are constrained to the assistant column and wrap instead of extending the terminal viewport. Tables measure Unicode display width, allocate a shared width to each column, and shrink the widest columns when the table would exceed the terminal.

Successful tool rows remain in Ink's live region until the next answer begins. At that point, the projector replaces a consecutive run with one summary row. This timing matters: once a row enters Ink's `Static` region it belongs to native terminal scrollback and cannot be folded retroactively. Failed tool calls remain expanded, and reasoning-only assistant steps leave no empty diamond behind.
