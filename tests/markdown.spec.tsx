import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import { Markdown } from '../src/markdown.tsx'

describe('Markdown', () => {
  it('renders common GFM structures without showing their source punctuation', () => {
    const view = render(<Markdown>{'# Result\n\n- **ready**\n- ~~old~~ and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |'}</Markdown>)
    const frame = view.lastFrame() ?? ''

    expect(frame).toContain('Result')
    expect(frame).toContain('• ready')
    expect(frame).toContain('old and code')
    const tableLines = frame.split('\n').filter(line => line.startsWith('│') || line.startsWith('├'))
    expect(tableLines).toHaveLength(3)
    expect(new Set(tableLines.map(line => line.length)).size).toBe(1)
    expect(frame).toContain('│ A')
    expect(frame).not.toContain('**')
    expect(frame).not.toContain('~~')
  })

  it('renders incomplete streaming markdown without throwing', () => {
    const view = render(<Markdown>{'Working on **the current'}</Markdown>)
    expect(view.lastFrame()).toContain('Working on **the current')
  })

  it('wraps code blocks inside the available terminal width', () => {
    const view = render(<Markdown>{`\`\`\`bash\n${'gcc -std=c23 -O2 -pthread -Wall -Wextra qfind.c -o qfind # 零警告 '.repeat(4)}\n\`\`\``}</Markdown>)
    const frame = view.lastFrame() ?? ''
    expect(Math.max(...frame.split('\n').map(line => stringWidth(line)))).toBeLessThanOrEqual(view.stdout.columns - 3)
  })
})
