import stringWidth from 'string-width'

/** Collapse arbitrary streamed reasoning into one terminal line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Keep the newest visible columns without splitting a wide terminal glyph. */
export function tailColumns(value: string, columns: number): string {
  const line = oneLine(value)
  if (columns <= 0) return ''
  if (stringWidth(line) <= columns) return line
  if (columns === 1) return '…'
  const suffix: string[] = []
  let width = 0
  for (const character of Array.from(line).reverse()) {
    const characterWidth = stringWidth(character)
    if (width + characterWidth > columns - 1) break
    suffix.push(character)
    width += characterWidth
  }
  return `…${suffix.reverse().join('')}`
}
