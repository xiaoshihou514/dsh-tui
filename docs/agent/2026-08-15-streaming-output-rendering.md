# Streaming output rendering

Reasoning is transient UI state, not transcript content. While the model is reasoning, the TUI now collapses whitespace and keeps only the newest terminal-width slice visible. As soon as answer text arrives, or the assistant message is finalized, the reasoning line is removed.

Assistant output is parsed with Marked's GFM lexer and rendered as Ink elements. We do not generate terminal HTML or trust ANSI sequences from model output. Native elements preserve terminal wrapping and let the TUI style headings, emphasis, lists, quotations, code blocks, links, images, rules, and tables consistently. Incomplete Markdown is parsed on each streaming update and falls back to visible source text when a construct has not closed yet.
