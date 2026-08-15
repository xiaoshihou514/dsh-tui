import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/markdown.tsx'

describe('Markdown', () => {
  it('renders common GFM structures without showing their source punctuation', () => {
    const view = render(<Markdown>{'# Result\n\n- **ready**\n- ~~old~~ and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |'}</Markdown>)
    const frame = view.lastFrame() ?? ''

    expect(frame).toContain('Result')
    expect(frame).toContain('• ready')
    expect(frame).toContain('old and code')
    expect(frame).toContain('│ A │ B │')
    expect(frame).not.toContain('**')
    expect(frame).not.toContain('~~')
  })

  it('renders incomplete streaming markdown without throwing', () => {
    const view = render(<Markdown>{'Working on **the current'}</Markdown>)
    expect(view.lastFrame()).toContain('Working on **the current')
  })
})
