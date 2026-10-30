import type { EngineInterface } from 'claude-code'

import type { LedgerItem, LedgerKind, LedgerStatus } from '../types'
import { addMany, type NewItem, type ToolAnswer } from './batch'
import { describe, descendants, errorText, isOpen, topId, when } from './model'
import { updateItems, updateItem } from './state'
import { loadExport, mdPathOf, persist, writeExport } from './storage'

export type Input = {
  action: string
  kind?: LedgerKind
  title?: string
  detail?: string
  where?: string
  url?: string
  parent?: number
  id?: number
  outcome?: string
  note?: string
  path?: string
  briefing?: string
  items?: NewItem[]
}

/** What an action works on: the call, the ledger as it stood, and the parent it names. */
type Call = { input: Input; list: LedgerItem[]; parent?: LedgerItem }

/** An action on one existing item. */
type ItemCall = Call & { target: LedgerItem }

/** The status each status action sets. */
const STATUS_OF = new Map<string, LedgerStatus>([
  ['start', 'in-progress'],
  ['resolve', 'resolved'],
  ['obsolete', 'obsolete'],
  ['reopen', 'open'],
])

async function change($: EngineInterface, id: number, fn: (i: LedgerItem) => LedgerItem) {
  await updateItem($, id, fn)
  await persist($)
}

function listOpen(list: LedgerItem[]): ToolAnswer {
  const open = list.filter(isOpen)

  return { result: open.length === 0 ? 'Ledger: nothing open.' : open.map(describe).join('\n') }
}

async function brief($: EngineInterface, input: Input): Promise<ToolAnswer> {
  if (!input.path || !input.briefing) {
    return { deny: 'brief needs "path" and "briefing".' }
  }
  try {
    const data = await loadExport($, input.path)
    await writeExport($, input.path, { ...data, briefing: input.briefing })
  } catch (error) {
    return { deny: `Could not save the briefing: ${errorText(error)}` }
  }

  return { result: `Briefing saved to ${input.path} and ${mdPathOf(input.path)}.` }
}

async function add($: EngineInterface, { input, list, parent }: Call): Promise<ToolAnswer> {
  if (input.items) {
    return addMany($, list, input.items)
  }
  const { kind, title, detail, where, url } = input
  if (!kind || !title) {
    return { deny: 'add needs "kind" and "title".' }
  }
  let id = 0
  await updateItems($, (current: LedgerItem[]) => {
    id = topId(current) + 1

    return [...current, { id, kind, title, detail, where, url, parent: parent?.id, status: 'open' as const }]
  })
  await persist($)

  return { result: `Logged as ${id} (ledger)` + when(parent, `, under ${parent?.id}`) + '.' }
}

/** The new value of a text field: left out keeps it, an empty string clears it. */
const cleared = (value: string | undefined, was: string | undefined) => (value === undefined ? was : value || undefined)

async function edit($: EngineInterface, { input, target }: ItemCall): Promise<ToolAnswer> {
  if (input.title === '') {
    return { deny: 'An item needs a title; leave "title" out to keep it.' }
  }
  await change($, target.id, i => ({
    ...i,
    title: input.title ?? i.title,
    kind: input.kind ?? i.kind,
    detail: cleared(input.detail, i.detail),
    where: cleared(input.where, i.where),
    url: cleared(input.url, i.url),
  }))

  return { result: `${target.id} (ledger) edited.` }
}

async function note($: EngineInterface, { input, target }: ItemCall): Promise<ToolAnswer> {
  if (!input.note) {
    return { deny: 'note needs "note".' }
  }
  const added = { at: new Date().toISOString(), text: input.note }
  await change($, target.id, i => ({ ...i, notes: [...(i.notes ?? []), added] }))

  return { result: `Note added to ${target.id} (ledger).` }
}

async function move($: EngineInterface, { list, parent, target }: ItemCall): Promise<ToolAnswer> {
  const isUnderItself = parent && (parent.id === target.id || descendants(target.id, list).some(d => d.id === parent.id))
  if (isUnderItself) {
    return { deny: `${parent.id} is ${target.id} or one of its children; an item cannot sit under itself.` }
  }
  await change($, target.id, i => ({ ...i, parent: parent?.id }))

  return { result: `${target.id} (ledger) is now ` + (parent ? `under ${parent.id}.` : 'top-level.') }
}

async function setStatus($: EngineInterface, { input, list, target }: ItemCall, status: LedgerStatus): Promise<ToolAnswer> {
  await change($, target.id, i => ({ ...i, status, outcome: input.outcome ?? i.outcome }))
  const stillOpen = isOpen({ ...target, status }) ? [] : descendants(target.id, list).filter(isOpen)
  const warning = when(stillOpen.length, ` It still has open children: ${stillOpen.map(i => i.id).join(', ')}.`)

  return { result: `${target.id} (ledger) is now ${status}.${warning}` }
}

/** An action on one existing item: edit, note, move, or a status change. */
async function changeItem($: EngineInterface, call: ItemCall): Promise<ToolAnswer> {
  switch (call.input.action) {
    case 'edit':
      return edit($, call)
    case 'note':
      return note($, call)
    case 'move':
      return move($, call)
    default: {
      const status = STATUS_OF.get(call.input.action)

      return status ? setStatus($, call, status) : { deny: `Unknown action "${call.input.action}".` }
    }
  }
}

/** Answers a call of the ledger tool. */
export async function act($: EngineInterface, input: Input, list: LedgerItem[]): Promise<ToolAnswer> {
  if (input.action === 'list') {
    return listOpen(list)
  }
  if (input.action === 'brief') {
    return brief($, input)
  }
  const parent = input.parent ? list.find(i => i.id === input.parent) : undefined
  if (input.parent && !parent) {
    return { deny: `No ledger item ${input.parent} to nest under.` }
  }
  if (input.action === 'add') {
    return add($, { input, list, parent })
  }
  const target = list.find(i => i.id === input.id)

  return target ? changeItem($, { input, list, parent, target }) : { deny: `No ledger item ${input.id}.` }
}
