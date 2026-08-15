/** Ink renderer for the interactive terminal surface. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, render, Static, Text, useApp, useCursor, useInput, useStdout, type CursorPosition, type DOMElement } from 'ink'
import TextInput from 'ink-text-input'
import stringWidth from 'string-width'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ModelChoice, SessionChoice, TuiController, TuiSnapshot } from './controller.ts'
import type { TranscriptEntry } from './transcript.ts'
import { Markdown } from './markdown.tsx'
import { tailColumns } from './text-layout.ts'

const palette = {
  // ANSI names deliberately defer their actual appearance to the user's
  // terminal theme. Ordinary content uses the terminal's default foreground.
  quiet: 'gray',
  faint: 'gray',
  signal: 'cyan',
  human: 'magenta',
  active: 'yellow',
  success: 'green',
  danger: 'red',
} as const

function useSnapshot(controller: TuiController): TuiSnapshot {
  const [snapshot, setSnapshot] = useState(() => controller.snapshot())
  useEffect(() => controller.subscribe(() => { setSnapshot(controller.snapshot()) }), [controller])
  return snapshot
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Rotate a braille glyph while the model is working. */
function useSpinner(active: boolean, intervalMs = 80): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame(current => current + 1), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return spinnerFrames[frame % spinnerFrames.length] ?? spinnerFrames[0]
}

function clipLines(value: string, lines = 8): string {
  const rows = value.split('\n')
  return rows.length <= lines ? value : `${rows.slice(0, lines).join('\n')}\n… ${rows.length - lines} more lines`
}

/** Show the tail of a growing live message so the newest lines stay visible. */
function tailLines(value: string, lines = 20): string {
  const rows = value.split('\n')
  return rows.length <= lines ? value : `… ${rows.length - lines} earlier lines\n${rows.slice(-lines).join('\n')}`
}

function TranscriptRow({ entry, live = false, spinner }: {
  entry: TranscriptEntry
  live?: boolean
  spinner?: string
}): React.JSX.Element {
  const { stdout } = useStdout()
  switch (entry.kind) {
    case 'user':
      return <Box marginTop={1}>
        <Box width={3}><Text color={palette.human}>◆</Text></Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={palette.human} bold>YOU</Text>
          <Text>{entry.text}</Text>
        </Box>
      </Box>
    case 'assistant': {
      const thinking = entry.streaming && entry.text === ''
      return <Box width="100%" minWidth={0} flexShrink={1} marginTop={1}>
        <Box width={3} flexShrink={0}><Text color={palette.signal}>{entry.streaming ? (thinking ? spinner ?? '◈' : '◈') : '◇'}</Text></Box>
        <Box minWidth={0} flexDirection="column" flexGrow={1} flexShrink={1}>
          {!thinking || entry.reasoning === undefined || entry.reasoning === '' ? null
            : <Text color={palette.faint}>{tailColumns(entry.reasoning, Math.max(1, (stdout.columns ?? 80) - 4))}</Text>}
          {entry.text === '' ? null
            : <>{<Markdown>{live ? tailLines(entry.text, 20) : entry.text}</Markdown>}{entry.streaming ? <Text color={palette.signal}> ▋</Text> : null}</>}
        </Box>
      </Box>
    }
    case 'tool':
      return <Box marginTop={1}>
        <Box width={3}><Text color={entry.isError ? palette.danger : palette.active}>{entry.result === undefined ? '◌' : '┊'}</Text></Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={entry.isError ? palette.danger : palette.quiet}>
            <Text bold>{entry.name}</Text> · {entry.result === undefined ? 'working' : entry.isError ? 'failed' : 'done'}
          </Text>
          {!entry.isError || entry.result === undefined ? null : <Text color={palette.danger}>{clipLines(entry.result, 3)}</Text>}
        </Box>
      </Box>
    case 'tool-summary':
      return <Box marginTop={1}>
        <Box width={3}><Text color={palette.quiet}>└</Text></Box>
        <Text color={palette.quiet}>{entry.count} tool {entry.count === 1 ? 'call' : 'calls'} folded · {entry.names}</Text>
      </Box>
    case 'command':
      return <Box marginTop={1}>
        <Box width={3}><Text color={entry.isError ? palette.danger : palette.signal}>›</Text></Box>
        <Box flexDirection="column">
          <Text color={palette.signal}>/{entry.name}{entry.arguments === undefined ? '' : ` ${entry.arguments}`}</Text>
          {entry.result === undefined ? null : <Text color={entry.isError ? palette.danger : palette.quiet}>{entry.result}</Text>}
        </Box>
      </Box>
    case 'notice':
      return <Box marginTop={1}>
        <Box width={3}><Text color={entry.tone === 'error' ? palette.danger : palette.quiet}>!</Text></Box>
        <Text color={entry.tone === 'error' ? palette.danger : palette.quiet}>{entry.text}</Text>
      </Box>
  }
}

function Panel({ title, accent = palette.signal, children }: {
  title: string
  accent?: string
  children: React.ReactNode
}): React.JSX.Element {
  return <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
    <Text color={accent} bold>{title}</Text>
    {children}
  </Box>
}

function Approval({ controller, toolName, reason }: {
  controller: TuiController
  toolName: string
  reason?: string
}): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) controller.cancel()
    if (input.toLowerCase() === 'y') controller.decideApproval('allowed-once')
    if (input.toLowerCase() === 'n' || key.escape) controller.decideApproval('rejected')
  })
  return <Panel title={`Permission · ${toolName}`} accent={palette.active}>
    {reason === undefined ? <Text color={palette.quiet}>This tool needs your approval.</Text> : <Text>{reason}</Text>}
    <Box marginTop={1} gap={2}>
      <Text><Text color={palette.success} inverse bold> Y </Text> allow once</Text>
      <Text><Text color={palette.danger} inverse bold> N </Text> reject</Text>
    </Box>
  </Panel>
}

function parseAnswer(question: AskUserQuestionItem, value: string): AskUserQuestionAnswerItem {
  const options = question.options ?? []
  const tokens = value.split(',').map(token => token.trim()).filter(Boolean)
  const selected: string[] = []
  const custom: string[] = []
  for (const token of tokens) {
    const index = Number(token) - 1
    const option = Number.isInteger(index) ? options[index] : undefined
    if (option === undefined) custom.push(token)
    else if (!selected.includes(option.label)) selected.push(option.label)
  }
  if (question.multiSelect !== true && selected.length > 1) selected.splice(1)
  return { id: question.id, selected, ...(custom.length === 0 ? {} : { custom: custom.join(', ') }) }
}

function Question({ controller, questions }: { controller: TuiController; questions: AskUserQuestionItem[] }): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<AskUserQuestionAnswerItem[]>([])
  const question = questions[index]
  useInput((input, key) => { if (key.escape || (input === 'c' && key.ctrl)) controller.cancel() })
  if (question === undefined) return <Text color={palette.danger}>The question request was empty.</Text>
  const submit = (input: string): void => {
    const next = [...answers, parseAnswer(question, input)]
    if (index + 1 === questions.length) controller.answer({ answers: next })
    else { setAnswers(next); setIndex(index + 1); setValue('') }
  }
  return <Panel title={`Question ${index + 1}/${questions.length}${question.header === undefined ? '' : ` · ${question.header}`}`}>
    <Text bold>{question.question}</Text>
    {question.detail === undefined ? null : <Text color={palette.quiet}>{question.detail}</Text>}
    <Box flexDirection="column" marginTop={1}>
      {(question.options ?? []).map((option, optionIndex) => <Text key={option.label}>
        <Text color={palette.signal}>{optionIndex + 1}.</Text> {option.label}
        {option.description === undefined ? '' : <Text color={palette.quiet}> — {option.description}</Text>}
      </Text>)}
    </Box>
    <Box marginTop={1}><Text color={palette.signal}>answer › </Text><TextInput value={value} onChange={setValue} onSubmit={submit} /></Box>
  </Panel>
}

function Help({ controller }: { controller: TuiController }): React.JSX.Element {
  useInput((_input, key) => { if (key.escape || key.return) controller.dismissPanel() })
  return <Panel title="Keyboard & commands">
    <Text><Text color={palette.signal}>Enter</Text> send · <Text color={palette.signal}>Shift+Enter</Text> newline · <Text color={palette.signal}>Esc</Text> interrupt</Text>
    <Text><Text color={palette.signal}>↑/↓</Text> prompt history      <Text color={palette.signal}>Ctrl+U</Text> clear draft</Text>
    <Text><Text color={palette.signal}>Ctrl+C</Text> exit when idle   <Text color={palette.signal}>/?</Text> or <Text color={palette.signal}>/help</Text> toggle help</Text>
    <Text color={palette.quiet}>Session selection: type to filter, ↑/↓ to move, Enter to open.</Text>
    <Text color={palette.quiet}>Press Esc or Enter to return.</Text>
  </Panel>
}

interface CompletionChoice {
  readonly name: string
  readonly description: string
  readonly hint?: string
}

function ComposerEditor({ value, width, onChange, onSubmit, onHistory, completion, placeholder, completionCount, onMoveCompletion }: {
  value: string
  width: number
  onChange: (value: string) => void
  onSubmit: () => void
  onHistory: (direction: -1 | 1) => void
  completion?: CompletionChoice
  placeholder: string
  completionCount: number
  onMoveCompletion: (direction: -1 | 1) => void
}): React.JSX.Element {
  const [cursor, setCursor] = useState(value.length)
  const [screenCursor, setScreenCursor] = useState<CursorPosition>()
  const editorRef = useRef<DOMElement>(null)
  const { setCursorPosition } = useCursor()
  setCursorPosition(screenCursor)
  useEffect(() => { setCursor(current => Math.min(current, value.length)) }, [value.length])
  const replace = (next: string, nextCursor: number): void => { onChange(next); setCursor(nextCursor) }
  useInput((input, key) => {
    if ((input === 'c' && key.ctrl) || key.escape) return
    if ((key.tab || input === '\t') && completion !== undefined) {
      const next = `/${completion.name}${completion.hint === undefined ? '' : ' '}`
      replace(next, next.length)
      return
    }
    if (value.startsWith('/') && completionCount > 0 && key.upArrow) { onMoveCompletion(-1); return }
    if (value.startsWith('/') && completionCount > 0 && key.downArrow) { onMoveCompletion(1); return }
    if (key.return) {
      if (key.shift || key.meta) replace(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1)
      else onSubmit()
      return
    }
    if (key.upArrow && !value.includes('\n')) { onHistory(-1); return }
    if (key.downArrow && !value.includes('\n')) { onHistory(1); return }
    if (key.leftArrow) { setCursor(current => Math.max(0, current - 1)); return }
    if (key.rightArrow) { setCursor(current => Math.min(value.length, current + 1)); return }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') { replace('', 0); return }
    if (key.backspace || key.delete) {
      if (cursor > 0) replace(`${value.slice(0, cursor - 1)}${value.slice(cursor)}`, cursor - 1)
      return
    }
    if (input !== '') replace(`${value.slice(0, cursor)}${input}${value.slice(cursor)}`, cursor + input.length)
  })
  useLayoutEffect(() => {
    const element = editorRef.current
    const yoga = element?.yogaNode
    if (element === null || yoga === undefined) return
    let x = 0
    let y = 0
    let ancestor: DOMElement | undefined = element
    while (ancestor !== undefined) {
      x += ancestor.yogaNode?.getComputedLeft() ?? 0
      y += ancestor.yogaNode?.getComputedTop() ?? 0
      ancestor = ancestor.parentNode
    }
    const width = Math.max(1, yoga.getComputedWidth())
    let localX = 0
    let localY = 0
    for (const character of value.slice(0, cursor)) {
      if (character === '\n') { localX = 0; localY += 1; continue }
      const cellWidth = stringWidth(character)
      if (localX + cellWidth > width) { localX = 0; localY += 1 }
      localX += cellWidth
    }
    const next = { x: x + localX, y: y + localY }
    setScreenCursor(current => current?.x === next.x && current.y === next.y ? current : next)
  })
  return <Box ref={editorRef} width={width} minWidth={0} flexShrink={0}>
    <Text>{value === '' ? ' ' : value}{value === '' ? <Text dimColor>{placeholder}</Text> : null}</Text>
  </Box>
}

function Composer({ controller, running, commands, attachments }: {
  controller: TuiController
  running: boolean
  commands: TuiSnapshot['commands']
  attachments: TuiSnapshot['draftAttachments']
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const [savedDraft, setSavedDraft] = useState('')
  const [completionIndex, setCompletionIndex] = useState(0)
  const [confirmExit, setConfirmExit] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { exit } = useApp()
  const { stdout } = useStdout()

  useEffect(() => () => {
    if (confirmTimer.current !== undefined) clearTimeout(confirmTimer.current)
  }, [])

  const disarmExit = (): void => {
    if (confirmTimer.current !== undefined) {
      clearTimeout(confirmTimer.current)
      confirmTimer.current = undefined
    }
    setConfirmExit(false)
  }

  const handleCtrlC = (): void => {
    // First press: stop the active turn and clear the draft, arming exit.
    if (running) controller.cancel()
    setValue('')
    if (confirmExit) {
      if (confirmTimer.current !== undefined) clearTimeout(confirmTimer.current)
      exit()
      return
    }
    setConfirmExit(true)
    if (confirmTimer.current !== undefined) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmExit(false), 1500)
  }

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      handleCtrlC()
      return
    }
    if (key.escape && running) controller.cancel()
    // Any other key cancels the pending double-Ctrl+C exit.
    if (confirmExit) disarmExit()
  })
  const submit = (): void => {
    if (value.trim() === '') return
    controller.submit(value)
    if (!value.trim().startsWith('/')) setHistory(previous => [...previous.slice(-49), value])
    setHistoryIndex(undefined)
    setSavedDraft('')
    setValue('')
  }
  const browseHistory = (direction: -1 | 1): void => {
    if (history.length === 0) return
    const current = historyIndex ?? history.length
    if (historyIndex === undefined) setSavedDraft(value)
    const next = Math.max(0, Math.min(history.length, current + direction))
    setHistoryIndex(next === history.length ? undefined : next)
    setValue(next === history.length ? savedDraft : history[next] ?? value)
  }
  const commandNeedle = /^\/([^\s]*)$/u.exec(value)?.[1]?.toLowerCase()
  const localCommands: readonly CompletionChoice[] = [
    { name: 'sessions', description: 'Switch conversation' },
    { name: 'new', description: 'Start a new conversation' },
    { name: 'global', description: 'Open the shared global conversation' },
    { name: 'fork', description: 'Fork this conversation' },
    { name: 'rename', description: 'Rename this conversation', hint: '<title>' },
    { name: 'archive', description: 'Archive this conversation' },
    { name: 'model', description: 'Choose model and reasoning effort' },
    { name: 'attach', description: 'Attach an image', hint: '<path>' },
    { name: 'clear-attachments', description: 'Clear draft images' },
    { name: 'help', description: 'Show keyboard shortcuts' },
  ]
  const commandMatches: CompletionChoice[] = commandNeedle === undefined ? [] : [
    ...localCommands,
    ...commands.map(command => ({
      name: command.name,
      description: command.description,
      ...(command.input === undefined ? {} : { hint: command.input.hint }),
    })),
  ]
    .filter((command, index, all) => all.findIndex(candidate => candidate.name === command.name) === index)
    .filter(command => command.name.includes(commandNeedle))
    .sort((left, right) => Number(!left.name.startsWith(commandNeedle)) - Number(!right.name.startsWith(commandNeedle)))
    .slice(0, 7)
  useEffect(() => { setCompletionIndex(0) }, [commandNeedle])
  useEffect(() => {
    if (completionIndex >= commandMatches.length) setCompletionIndex(Math.max(0, commandMatches.length - 1))
  }, [commandMatches.length, completionIndex])
  const moveCompletion = (direction: -1 | 1): void => {
    setCompletionIndex(current => (current + direction + commandMatches.length) % Math.max(1, commandMatches.length))
  }
  const frameWidth = Math.max(12, (stdout.columns ?? 80) - 1)
  const editorWidth = frameWidth - 6
  let inputLines = 1
  let inputColumn = 0
  for (const character of value) {
    if (character === '\n') { inputLines += 1; inputColumn = 0; continue }
    const cellWidth = stringWidth(character)
    if (inputColumn + cellWidth > editorWidth) { inputLines += 1; inputColumn = 0 }
    inputColumn += cellWidth
  }
  const borderColor = running ? palette.active : palette.signal
  const prompt = running ? '◌ ' : '› '
  const editor = <ComposerEditor
    value={value} width={editorWidth} onChange={setValue} onSubmit={submit} onHistory={browseHistory}
    placeholder={running ? 'Add a follow-up…' : 'Ask DeepSeek…'}
    {...commandMatches[completionIndex] === undefined ? {} : { completion: commandMatches[completionIndex] }}
    completionCount={commandMatches.length} onMoveCompletion={moveCompletion}
  />
  return <Box flexDirection="column" marginTop={1}>
    {attachments.length === 0 ? null : <Box paddingX={1} gap={1}>
      <Text color={palette.human}>images</Text>
      {attachments.map((attachment, index) => <Text key={String(attachment.attachmentId)} color={palette.quiet}>
        [{index + 1}] {attachment.name ?? `${attachment.width}×${attachment.height}`}
      </Text>)}
    </Box>}
    <Box width={frameWidth} flexDirection="column">
      <Text color={borderColor}>╭{'─'.repeat(frameWidth - 2)}╮</Text>
      <Box width={frameWidth}>
        <Text color={borderColor}>{Array.from({ length: inputLines }, (_, index) => index === 0 ? `│ ${prompt}` : '│   ').join('\n')}</Text>
        {editor}
        <Text color={borderColor}>{Array.from({ length: inputLines }, () => ' │').join('\n')}</Text>
      </Box>
      <Text color={borderColor}>╰{'─'.repeat(frameWidth - 2)}╯</Text>
    </Box>
    {value.startsWith('/') ? <Box flexDirection="column" paddingX={2}>
      {commandMatches.length === 0 ? <Text color={palette.quiet}>No matching commands</Text> : commandMatches.map((command, index) => <Text key={command.name} {...index === completionIndex ? { inverse: true, bold: true } : { color: palette.quiet }}>
        {index === completionIndex ? '› ' : '  '}/<Text {...index === completionIndex ? {} : { color: palette.signal }}>{command.name}</Text>{command.hint === undefined ? '' : ` ${command.hint}`} — {command.description}
      </Text>)}
      {commandMatches.length === 0 ? null : <Text color={palette.quiet}>↑/↓ select · Tab complete</Text>}
    </Box> : null}
  </Box>
}

function SessionPicker({ controller, choices }: { controller: TuiController; choices: readonly SessionChoice[] }): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [query, setQuery] = useState('')
  const { exit } = useApp()
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? choices : choices.filter(choice => `${choice.label} ${choice.detail ?? ''}`.toLowerCase().includes(needle))
  }, [choices, query])
  useEffect(() => { if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1)) }, [filtered.length, index])
  useInput((input, key) => {
    if (key.upArrow) setIndex(current => (current + filtered.length - 1) % Math.max(1, filtered.length))
    if (key.downArrow) setIndex(current => (current + 1) % Math.max(1, filtered.length))
    if (key.return && filtered[index] !== undefined) controller.selectSession(filtered[index])
    if (key.escape || (input === 'c' && key.ctrl)) { controller.selectSession(undefined); exit() }
  })
  return <Panel title="Open a conversation">
    <Box><Text color={palette.signal}>search › </Text><TextInput value={query} onChange={setQuery} placeholder="session or workspace" /></Box>
    <Box flexDirection="column" marginTop={1}>
      {filtered.length === 0 ? <Text color={palette.quiet}>No conversations match “{query}”.</Text> : filtered.map((choice, choiceIndex) =>
        <Box key={`${choice.kind}/${choice.id}`} flexDirection="column">
          <Text {...choiceIndex === index ? { inverse: true, bold: true } : {}}>
            {choiceIndex === index ? ' › ' : '   '}{choice.kind === 'new' ? '＋' : choice.kind === 'global' ? '◎' : '·'} {choice.label}{choiceIndex === index ? ' ' : ''}
          </Text>
          {choice.detail === undefined ? null : <Text color={palette.quiet}>     {choice.detail}</Text>}
        </Box>)}
    </Box>
    <Text color={palette.quiet}>↑/↓ choose · Enter open · Esc exit</Text>
  </Panel>
}

function ModelPicker({ controller, choices }: { controller: TuiController; choices: readonly ModelChoice[] }): React.JSX.Element {
  const [index, setIndex] = useState(Math.max(0, choices.findIndex(choice => choice.current)))
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? choices : choices.filter(choice => `${choice.provider} ${choice.label} ${choice.detail ?? ''}`.toLowerCase().includes(needle))
  }, [choices, query])
  useEffect(() => { if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1)) }, [filtered.length, index])
  useInput((_input, key) => {
    if (key.upArrow) setIndex(current => (current + filtered.length - 1) % Math.max(1, filtered.length))
    if (key.downArrow) setIndex(current => (current + 1) % Math.max(1, filtered.length))
    if (key.return && filtered[index] !== undefined) controller.selectModel(filtered[index])
    if (key.escape) controller.selectModel(undefined)
  })
  return <Panel title="Choose a model">
    <Box><Text color={palette.signal}>search › </Text><TextInput value={query} onChange={setQuery} placeholder="provider or model" /></Box>
    <Box flexDirection="column" marginTop={1}>
      {filtered.length === 0 ? <Text color={palette.quiet}>No models match “{query}”.</Text> : filtered.map((choice, choiceIndex) =>
        <Box key={choice.id} flexDirection="column">
          <Text {...choiceIndex === index ? { inverse: true, bold: true } : {}}>
            {choiceIndex === index ? ' › ' : '   '}{choice.current ? '●' : '·'} {choice.label} <Text dimColor>({choice.provider})</Text>{choiceIndex === index ? ' ' : ''}
          </Text>
          {choice.detail === undefined ? null : <Text color={palette.quiet}>     {choice.detail}</Text>}
        </Box>)}
    </Box>
    <Text color={palette.quiet}>↑/↓ choose · Enter apply · Esc cancel</Text>
  </Panel>
}

function StatusBar({ snapshot, spinner }: { snapshot: TuiSnapshot; spinner: string }): React.JSX.Element {
  const running = snapshot.status === 'running'
  const identity = snapshot.identity
  const parts: string[] = []
  if (identity?.title !== undefined && identity.title !== '') parts.push(identity.title)
  if (identity?.model !== undefined && identity.model !== '') parts.push(identity.model)
  if (identity?.cwd !== undefined && identity.cwd !== '') parts.push(identity.cwd)
  const right = parts.join(' · ')
  return <Box marginTop={1} paddingX={1} flexDirection="row">
    <Box flexShrink={0}>
      <Text>
        <Text color={palette.signal} bold>◆ DSH</Text>
        <Text color={palette.quiet}> </Text>
        <Text color={running ? palette.active : palette.success}>{running ? `${spinner} working` : '● ready'}</Text>
      </Text>
    </Box>
    <Box flexGrow={1} flexShrink={1} justifyContent="flex-end">
      <Text color={palette.quiet} wrap="truncate-end">{right}</Text>
    </Box>
  </Box>
}

function ActivityStrip({ snapshot }: { snapshot: TuiSnapshot }): React.JSX.Element | null {
  const { todos, goal, planMode } = snapshot
  if (todos.length === 0 && goal === undefined && !planMode) return null
  const completed = todos.filter(todo => todo.status === 'completed').length
  const active = todos.find(todo => todo.status === 'in_progress')
  const phaseColor = goal?.phase === 'blocked' ? palette.danger
    : goal?.phase === 'complete' ? palette.success : palette.active
  return <Box marginTop={1} paddingX={1} flexDirection="column" borderStyle="single" borderColor={palette.faint}>
    {goal === undefined ? null : <Box justifyContent="space-between">
      <Text color={palette.quiet}>GOAL <Text color={phaseColor}>{goal.phase.toUpperCase()}</Text> · round {goal.roundsStarted}/{goal.maxGoalRounds}</Text>
      <Text wrap="truncate-end">{goal.objective}</Text>
    </Box>}
    {goal?.blockedReason === undefined ? null : <Text color={palette.danger}>↳ {goal.blockedReason}</Text>}
    {todos.length === 0 ? null : <Box justifyContent="space-between">
      <Text color={palette.quiet}><Text color={palette.success}>{completed}/{todos.length}</Text> tasks</Text>
      <Text color={active === undefined ? palette.quiet : palette.active}>{active?.content ?? (completed === todos.length ? 'complete' : 'queued')}</Text>
    </Box>}
    {!planMode ? null : <Text color={palette.signal}>◇ PLAN MODE · review and exploration only</Text>}
  </Box>
}

function App({ controller }: { controller: TuiController }): React.JSX.Element {
  const snapshot = useSnapshot(controller)
  const spinner = useSpinner(snapshot.status === 'running')
  // Finalized entries are written once to native scrollback. Successful tools
  // stay live until the projector can fold them; failures remain visible.
  const staticEntries = snapshot.entries.filter(entry => (entry.kind !== 'tool' || entry.isError) && !(entry.kind === 'assistant' && entry.streaming))
  const liveEntries = snapshot.entries.filter(entry => (entry.kind === 'assistant' && entry.streaming) || (entry.kind === 'tool' && !entry.isError))
  const interaction = snapshot.sessionChoices !== undefined
    ? <SessionPicker controller={controller} choices={snapshot.sessionChoices} />
    : snapshot.modelChoices !== undefined ? <ModelPicker controller={controller} choices={snapshot.modelChoices} />
      : snapshot.panel === 'help' ? <Help controller={controller} />
        : snapshot.approval !== undefined ? <Approval controller={controller} {...snapshot.approval} />
          : snapshot.question !== undefined
            ? <Question key={snapshot.question.questions.map(question => question.id).join('/')} controller={controller} questions={snapshot.question.questions} />
            : <Composer controller={controller} running={snapshot.status === 'running'} commands={snapshot.commands} attachments={snapshot.draftAttachments} />
  return <Box flexDirection="column">
    <Static items={staticEntries}>
      {(entry) => <TranscriptRow key={entry.id} entry={entry} />}
    </Static>
    {liveEntries.map(entry => <TranscriptRow key={entry.id} entry={entry} live spinner={spinner} />)}
    {snapshot.entries.length === 0 && snapshot.sessionChoices === undefined
      ? <Box marginTop={1} paddingX={3}><Text color={palette.quiet}>A quiet workspace. Ask a question or describe a task.</Text></Box>
      : null}
    {snapshot.notice === undefined ? null : <Box paddingX={3} marginTop={1}><Text color={palette.active}>! {snapshot.notice}</Text></Box>}
    <ActivityStrip snapshot={snapshot} />
    {interaction}
    <StatusBar snapshot={snapshot} spinner={spinner} />
  </Box>
}

/** Live Ink application handle owned by the runtime lifecycle. */
export interface TuiRenderHandle { waitUntilExit(): Promise<void>; unmount(): void }

/** Start the terminal renderer. */
export function renderTui(controller: TuiController): TuiRenderHandle {
  const instance = render(<App controller={controller} />, { exitOnCtrlC: false })
  return { waitUntilExit: async () => { await instance.waitUntilExit() }, unmount: () => { instance.unmount() } }
}
