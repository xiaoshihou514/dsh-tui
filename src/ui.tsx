/** Ink renderer for the interactive terminal surface. */

import { useEffect, useState } from 'react'
import { Box, render, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { TuiController, TuiSnapshot } from './controller.ts'
import type { TranscriptEntry } from './transcript.ts'

function useSnapshot(controller: TuiController): TuiSnapshot {
  const [snapshot, setSnapshot] = useState(() => controller.snapshot())
  useEffect(() => controller.subscribe(() => { setSnapshot(controller.snapshot()) }), [controller])
  return snapshot
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }): React.JSX.Element {
  switch (entry.kind) {
    case 'user':
      return <Box marginTop={1}><Text color="cyan" bold>{'> '}</Text><Text>{entry.text}</Text></Box>
    case 'assistant':
      return <Box flexDirection="column" marginTop={1}>
        {entry.reasoning === undefined ? null : <Text dimColor>{entry.reasoning}</Text>}
        <Text>{entry.text}{entry.streaming ? <Text color="cyan">▋</Text> : null}</Text>
      </Box>
    case 'tool':
      return <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={entry.isError ? 'red' : 'gray'} paddingX={1}>
        <Text bold>{entry.name}</Text>
        <Text dimColor>{entry.arguments}</Text>
        {entry.result === undefined
          ? <Text color="yellow">running...</Text>
          : <Text {...entry.isError ? { color: 'red' as const } : {}}>{entry.result}</Text>}
      </Box>
    case 'notice':
      return <Box marginTop={1}><Text color={entry.tone === 'error' ? 'red' : 'gray'}>{entry.text}</Text></Box>
  }
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
  return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
    <Text bold>Allow {toolName}?</Text>
    {reason === undefined ? null : <Text>{reason}</Text>}
    <Text><Text color="green">y</Text> allow once  <Text color="red">n</Text> reject</Text>
  </Box>
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
  return {
    id: question.id,
    selected,
    ...(custom.length === 0 ? {} : { custom: custom.join(', ') }),
  }
}

function Question({ controller, questions }: {
  controller: TuiController
  questions: AskUserQuestionItem[]
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<AskUserQuestionAnswerItem[]>([])
  const question = questions[index]
  useInput((input, key) => {
    if (key.escape || (input === 'c' && key.ctrl)) controller.cancel()
  })
  if (question === undefined) return <Text color="red">Invalid empty question request.</Text>

  const submit = (input: string): void => {
    const answer = parseAnswer(question, input)
    const next = [...answers, answer]
    if (index + 1 === questions.length) controller.answer({ answers: next })
    else {
      setAnswers(next)
      setIndex(index + 1)
      setValue('')
    }
  }

  return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
    <Text bold>{question.header === undefined ? question.question : `${question.header}: ${question.question}`}</Text>
    {question.detail === undefined ? null : <Text dimColor>{question.detail}</Text>}
    {(question.options ?? []).map((option, optionIndex) =>
      <Text key={option.label}>{optionIndex + 1}. {option.label}{option.description === undefined ? '' : ` (${option.description})`}</Text>)}
    <Box><Text color="cyan">answer › </Text><TextInput value={value} onChange={setValue} onSubmit={submit} /></Box>
  </Box>
}

function Composer({ controller, running }: { controller: TuiController; running: boolean }): React.JSX.Element {
  const [value, setValue] = useState('')
  const { exit } = useApp()
  useInput((input, key) => {
    if (key.escape && running) controller.cancel()
    if (input === 'c' && key.ctrl) {
      if (running) controller.cancel()
      else exit()
    }
  })
  const submit = (input: string): void => {
    controller.submit(input)
    setValue('')
  }
  return <Box marginTop={1} borderStyle="single" borderColor={running ? 'yellow' : 'cyan'} paddingX={1}>
    <Text color="cyan">› </Text><TextInput value={value} onChange={setValue} onSubmit={submit} />
  </Box>
}

function App({ controller }: { controller: TuiController }): React.JSX.Element {
  const snapshot = useSnapshot(controller)
  const interaction = snapshot.approval !== undefined
    ? <Approval controller={controller} {...snapshot.approval} />
    : snapshot.question !== undefined
      ? <Question key={snapshot.question.questions.map(question => question.id).join('/')} controller={controller} questions={snapshot.question.questions} />
      : <Composer controller={controller} running={snapshot.status === 'running'} />

  return <Box flexDirection="column">
    <Box justifyContent="space-between">
      <Text bold color="cyan">dsh-tui</Text>
      <Text color={snapshot.status === 'running' ? 'yellow' : 'green'}>{snapshot.status}</Text>
    </Box>
    {snapshot.entries.map(entry => <TranscriptRow key={entry.id} entry={entry} />)}
    {interaction}
    <Text dimColor>{snapshot.status === 'running' ? 'Esc interrupt' : 'Ctrl+C exit'}</Text>
  </Box>
}

/** Live Ink application handle owned by the runtime lifecycle. */
export interface TuiRenderHandle {
  waitUntilExit(): Promise<void>
  unmount(): void
}

/** Start the terminal renderer. */
export function renderTui(controller: TuiController): TuiRenderHandle {
  const instance = render(<App controller={controller} />, { exitOnCtrlC: false })
  return {
    waitUntilExit: async () => { await instance.waitUntilExit() },
    unmount: () => { instance.unmount() },
  }
}
