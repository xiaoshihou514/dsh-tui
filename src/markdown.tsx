import type { ReactNode } from 'react'
import { Box, Text, useStdout } from 'ink'
import { marked, type Token, type Tokens } from 'marked'
import stringWidth from 'string-width'

const colors = {
  accent: 'cyan',
  code: 'yellow',
  quote: 'gray',
} as const

function inline(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'text':
        return token.tokens === undefined ? token.text : <Text key={key}>{inline(token.tokens, key)}</Text>
      case 'escape': return token.text
      case 'strong': return <Text key={key} bold>{inline((token as Tokens.Strong).tokens, key)}</Text>
      case 'em': return <Text key={key} italic>{inline((token as Tokens.Em).tokens, key)}</Text>
      case 'del': return <Text key={key} strikethrough>{inline((token as Tokens.Del).tokens, key)}</Text>
      case 'codespan': return <Text key={key} color={colors.code}>{token.text}</Text>
      case 'link': return <Text key={key} color={colors.accent} underline>{inline((token as Tokens.Link).tokens, key)} ({token.href})</Text>
      case 'image': return <Text key={key} color={colors.accent}>[image: {token.text || token.href}]</Text>
      case 'br': return '\n'
      case 'html': return token.text
      default: return 'tokens' in token && Array.isArray(token.tokens)
        ? <Text key={key}>{inline(token.tokens, key)}</Text>
        : token.raw
    }
  })
}

function fit(value: string, width: number): string {
  if (stringWidth(value) <= width) return value + ' '.repeat(width - stringWidth(value))
  let result = ''
  for (const character of value) {
    if (stringWidth(result + character) > width - 1) break
    result += character
  }
  return `${result}…` + ' '.repeat(Math.max(0, width - stringWidth(result) - 1))
}

function tableWidths(table: Tokens.Table, maxWidth: number): number[] {
  const widths = table.header.map((cell, index) => Math.max(3, ...[cell, ...table.rows.map(row => row[index])]
    .filter((value): value is Tokens.TableCell => value !== undefined)
    .map(value => stringWidth(value.text.replace(/\s+/gu, ' ')))))
  const contentBudget = Math.max(widths.length * 3, maxWidth - (widths.length * 3 + 1))
  while (widths.reduce((sum, width) => sum + width, 0) > contentBudget) {
    const widest = Math.max(...widths)
    const index = widths.indexOf(widest)
    if (widest <= 3 || index === -1) break
    widths[index] = widest - 1
  }
  return widths
}

function tableRow(cells: readonly Tokens.TableCell[], widths: readonly number[], key: string): React.JSX.Element {
  return <Text key={key}>│{widths.map((width, index) => <Text key={`${key}-${index}`}> {fit(cells[index]?.text.replace(/\s+/gu, ' ') ?? '', width)} │</Text>)}</Text>
}

function blocks(tokens: readonly Token[], keyPrefix: string, maxWidth: number): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'space':
      case 'def': return []
      case 'heading': return <Box key={key} marginTop={index === 0 ? 0 : 1}><Text color={colors.accent} bold>{inline((token as Tokens.Heading).tokens, key)}</Text></Box>
      case 'paragraph': return <Box key={key}><Text>{inline((token as Tokens.Paragraph).tokens, key)}</Text></Box>
      case 'text': return <Box key={key}><Text>{token.tokens === undefined ? token.text : inline(token.tokens, key)}</Text></Box>
      case 'code': return <Box key={key} width="100%" minWidth={0} flexShrink={1} overflow="hidden" flexDirection="column" marginY={1} paddingX={1} borderStyle="single" borderColor={colors.quote}>
        {token.lang === undefined || token.lang === '' ? null : <Text color={colors.quote}>{token.lang}</Text>}
        <Text color={colors.code} wrap="wrap">{token.text}</Text>
      </Box>
      case 'blockquote': return <Box key={key} paddingLeft={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={colors.quote} flexDirection="column">
        {blocks((token as Tokens.Blockquote).tokens, key, maxWidth - 2)}
      </Box>
      case 'list': {
        const list = token as Tokens.List
        return <Box key={key} flexDirection="column">{list.items.map((item, itemIndex) => {
        const marker = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${Number(list.start || 1) + itemIndex}.` : '•'
        return <Box key={`${key}-${itemIndex}`}><Text color={colors.accent}>{marker} </Text><Box minWidth={0} flexDirection="column" flexShrink={1}>{blocks(item.tokens, `${key}-${itemIndex}`, maxWidth - stringWidth(marker) - 1)}</Box></Box>
      })}</Box>
      }
      case 'table': {
        const table = token as Tokens.Table
        const widths = tableWidths(table, maxWidth)
        return <Box key={key} flexDirection="column" marginY={1}>
        {tableRow(table.header, widths, `${key}-head`)}
        <Text color={colors.quote}>├{widths.map(width => '─'.repeat(width + 2)).join('┼')}┤</Text>
        {table.rows.map((row, rowIndex) => tableRow(row, widths, `${key}-row-${rowIndex}`))}
      </Box>
      }
      case 'hr': return <Text key={key} color={colors.quote}>────────────────────────────────────────</Text>
      case 'html': return <Text key={key}>{token.text}</Text>
      default: return <Box key={key}><Text>{inline([token], key)}</Text></Box>
    }
  })
}

/** Render GFM as terminal-native Ink elements without passing through HTML. */
export function Markdown({ children }: { children: string }): React.JSX.Element {
  const { stdout } = useStdout()
  const tokens = marked.lexer(children, { gfm: true })
  return <Box width="100%" minWidth={0} flexShrink={1} flexDirection="column">{blocks(tokens, 'md', Math.max(20, (stdout.columns ?? 80) - 3))}</Box>
}
