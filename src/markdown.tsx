import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { marked, type Token, type Tokens } from 'marked'

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

function tableRow(cells: readonly Tokens.TableCell[], key: string): React.JSX.Element {
  return <Text key={key}>│ {cells.map((cell, index) => <Text key={`${key}-${index}`}>{inline(cell.tokens, `${key}-${index}`)} │ </Text>)}</Text>
}

function blocks(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'space':
      case 'def': return []
      case 'heading': return <Box key={key} marginTop={index === 0 ? 0 : 1}><Text color={colors.accent} bold>{inline((token as Tokens.Heading).tokens, key)}</Text></Box>
      case 'paragraph': return <Box key={key}><Text>{inline((token as Tokens.Paragraph).tokens, key)}</Text></Box>
      case 'text': return <Box key={key}><Text>{token.tokens === undefined ? token.text : inline(token.tokens, key)}</Text></Box>
      case 'code': return <Box key={key} flexDirection="column" marginY={1} paddingX={1} borderStyle="single" borderColor={colors.quote}>
        {token.lang === undefined || token.lang === '' ? null : <Text color={colors.quote}>{token.lang}</Text>}
        <Text color={colors.code}>{token.text}</Text>
      </Box>
      case 'blockquote': return <Box key={key} paddingLeft={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderColor={colors.quote} flexDirection="column">
        {blocks((token as Tokens.Blockquote).tokens, key)}
      </Box>
      case 'list': {
        const list = token as Tokens.List
        return <Box key={key} flexDirection="column">{list.items.map((item, itemIndex) => {
        const marker = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${Number(list.start || 1) + itemIndex}.` : '•'
        return <Box key={`${key}-${itemIndex}`}><Text color={colors.accent}>{marker} </Text><Box flexDirection="column" flexShrink={1}>{blocks(item.tokens, `${key}-${itemIndex}`)}</Box></Box>
      })}</Box>
      }
      case 'table': {
        const table = token as Tokens.Table
        return <Box key={key} flexDirection="column" marginY={1}>
        {tableRow(table.header, `${key}-head`)}
        <Text color={colors.quote}>├{table.header.map(() => '────────').join('┼')}┤</Text>
        {table.rows.map((row, rowIndex) => tableRow(row, `${key}-row-${rowIndex}`))}
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
  const tokens = marked.lexer(children, { gfm: true })
  return <Box width="100%" minWidth={0} flexDirection="column">{blocks(tokens, 'md')}</Box>
}
