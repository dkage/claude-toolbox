import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerItem, LedgerKind } from '../types'

const PANE = 'ledger'
const TOOL = 'mcp__ledger__ledger'
const items = atom({ plugin: 'ledger', key: 'items' } as const, [])

const KINDS: { kind: LedgerKind; title: string }[] = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'bug', title: 'Bugs' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'smell', title: 'Smells' },
]

type Input = {
  action: 'add' | 'resolve' | 'obsolete' | 'reopen' | 'list'
  kind?: LedgerKind
  title?: string
  detail?: string
  where?: string
  id?: number
  outcome?: string
}

const describe = (i: LedgerItem) =>
  `${i.id} [${i.kind}] ${i.title}${i.where ? ` (${i.where})` : ''}`

const RULES = `The ledger is a numbered list the person keeps in a side panel of open decisions, bugs, gaps and code smells found during this session. Use the ${TOOL} tool:
- add: when you find a confirmed bug, a spec or documentation gap, a code smell worth tracking, or a decision the person must make that you cannot settle yourself. Log it as soon as you find it, with a short title and, when known, "where" (file:line) and "detail" (for a decision, the options). Do not log trivia or things you will simply do as part of the task.
- resolve: when the person decides or the item is dealt with; put what was done in "outcome".
- obsolete: when a finding stops mattering (for example the code was removed or the premise was wrong); say why in "outcome". Check the open items whenever your work could invalidate one.
- When the person says "add them to the ledger", log everything open from the conversation that is not on the list yet.
A number followed by "(ledger)" (e.g. "13 (ledger)") or written "L13" refers to the ledger item with that number. Numbers are never reused.`

async function refresh($: EngineInterface) {
  const open = (await read($, items)).filter((i: LedgerItem) => i.status === 'open').length
  $.ui.status(open > 0 ? `ledger: ${open} open` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ledger',
      description:
        'Log, resolve or retire numbered items (decisions, bugs, gaps, smells) in the ledger side panel the person is watching. Actions: add, resolve, obsolete, reopen, list.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'resolve', 'obsolete', 'reopen', 'list'] },
          kind: { type: 'string', enum: ['decision', 'bug', 'gap', 'smell'] },
          title: { type: 'string', description: 'Short one-line title (add).' },
          detail: { type: 'string', description: 'Context or, for a decision, the options (add).' },
          where: { type: 'string', description: 'file:line the item concerns (add).' },
          id: { type: 'integer', description: 'Item number (resolve, obsolete, reopen).' },
          outcome: { type: 'string', description: 'What was decided or done, or why obsolete.' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'ledger', description: 'Open the ledger panel' })
    void $.ui.open({ id: PANE, title: 'Ledger' })

    return next(e)
  })

  on('command.run', { command: 'ledger' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Ledger' })

    return { text: 'Ledger panel opened.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Input
    const list: LedgerItem[] = await read($, items)

    if (input.action === 'list') {
      const open = list.filter(i => i.status === 'open')

      return { result: open.length === 0 ? 'Ledger: nothing open.' : open.map(describe).join('\n') }
    }

    if (input.action === 'add') {
      if (!input.kind || !input.title) {
        return { deny: 'add needs "kind" and "title".' }
      }
      let id = 0
      await update($, items, (current: LedgerItem[]) => {
        id = current.reduce((max, i) => Math.max(max, i.id), 0) + 1

        return [
          ...current,
          {
            id,
            kind: input.kind as LedgerKind,
            title: input.title as string,
            detail: input.detail,
            where: input.where,
            status: 'open',
          },
        ]
      })
      await refresh($)

      return { result: `Logged as ${id} (ledger).` }
    }

    const target = list.find(i => i.id === input.id)
    if (!target) {
      return { deny: `No ledger item ${input.id}.` }
    }
    const status = { resolve: 'resolved', obsolete: 'obsolete', reopen: 'open' }[input.action] as LedgerItem['status']
    await update($, items, (current: LedgerItem[]) =>
      current.map(i => (i.id === target.id ? { ...i, status, outcome: input.outcome ?? i.outcome } : i)),
    )
    await refresh($)

    return { result: `${target.id} (ledger) is now ${status}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const open = (await read($, items)).filter((i: LedgerItem) => i.status === 'open')
    const shown = open.slice(-40).map(describe)
    const text = `${RULES}\n\nOpen ledger items now:\n${shown.length ? shown.join('\n') : '(none)'}`

    return { sections: [...composed.sections, { id: 'ledger:rules', text, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text
    const ids = new Set<number>()
    for (const m of text.matchAll(/\b(\d+)\s*\(ledger\)|\bL(\d+)\b/gi)) {
      ids.add(Number(m[1] ?? m[2]))
    }
    if (ids.size === 0) {
      return next(e)
    }
    const list: LedgerItem[] = await read($, items)
    const notes = list
      .filter(i => ids.has(i.id))
      .map(i => `Ledger ${i.id} (${i.status}): ${i.title}${i.detail ? ` | ${i.detail}` : ''}${i.where ? ` | ${i.where}` : ''}`)

    return next(notes.length ? { ...e, text: `${text}\n\n${notes.join('\n')}` } : e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list: LedgerItem[] = await read($, items)

    if (list.length === 0) {
      return <Text dimColor>Ledger is empty.</Text>
    }

    return (
      <Box flexDirection="column">
        {KINDS.map(({ kind, title }) => {
          const group = list.filter(i => i.kind === kind)
          const ordered = [
            ...group.filter(i => i.status === 'open'),
            ...group.filter(i => i.status !== 'open'),
          ]

          return group.length === 0 ? null : (
            <Box flexDirection="column">
              <Text bold>{title}</Text>
              {ordered.map(i => (
                <Text dimColor={i.status !== 'open'}>
                  {i.status === 'open' ? '☐' : i.status === 'resolved' ? '✓' : '–'} {i.id}. {i.title}
                  {i.status === 'obsolete' ? ' (obsolete)' : ''}
                  {i.outcome && i.status !== 'open' ? ` → ${i.outcome}` : ''}
                </Text>
              ))}
              <Text> </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
