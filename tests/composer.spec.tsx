import React, { useState } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ComposerEditor } from '../src/ui.tsx'

function Editor(): React.JSX.Element {
  const [value, setValue] = useState('tail')
  return <ComposerEditor value={value} width={40} placeholder="" onChange={setValue} onSubmit={() => {}}
    onHistory={() => {}} completionCount={0} onMoveCompletion={() => {}} />
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('composer control keys', () => {
  it('moves from the end with Ctrl+A without changing text', async () => {
    const view = render(<Editor />)
    await settle(); view.stdin.write('\u0001'); await settle(); view.stdin.write('X'); await settle()
    expect(view.lastFrame()).toContain('Xtail')
    expect(view.lastFrame()).not.toMatch(/[\u200b\u2060]/u)
  })

  it('moves left from the end with Ctrl+B instead of inserting b', async () => {
    const view = render(<Editor />)
    await settle(); view.stdin.write('\u0002'); await settle(); view.stdin.write('X'); await settle()
    expect(view.lastFrame()).toContain('taiXl')
    expect(view.lastFrame()).not.toContain('tailb')
  })
})
