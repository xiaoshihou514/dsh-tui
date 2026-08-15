import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { tailColumns } from '../src/text-layout.ts'

describe('tailColumns', () => {
  it('keeps the newest reasoning within its display-width budget', () => {
    const result = tailColumns('old context\nnew 节点 analysis', 12)
    expect(stringWidth(result)).toBeLessThanOrEqual(12)
    expect(result).toMatch(/analysis$/u)
    expect(result).not.toContain('\n')
  })

  it('does not split double-width characters at the left edge', () => {
    expect(tailColumns('甲乙丙丁', 5)).toBe('…丙丁')
  })
})
