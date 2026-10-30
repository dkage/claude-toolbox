import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'
import { kindOf, topId, when } from './model'
import { updateItems } from './state'
import { persist } from './storage'

/** One item of a batch "add": "ref" names it for "under" in later entries of the same batch. */
export type NewItem = {
  ref?: string
  under?: string
  parent?: number
  kind?: string
  title?: string
  detail?: string
  where?: string
  url?: string
}

export type ToolAnswer = { result: string } | { deny: string }

/** A batch checked and numbered after `base`, or the reason it was refused. */
type Plan = { made: LedgerItem[] } | { deny: string }

/** The parent an entry nests under: an earlier entry's number by "ref", or an existing item. */
function parentOfEntry(
  entry: NewItem,
  n: number,
  refs: Map<string, number>,
  list: LedgerItem[],
): { parent?: number } | { deny: string } {
  if (entry.under !== undefined) {
    const parent = refs.get(entry.under)

    return parent === undefined ? { deny: `items[${n}].under "${entry.under}" names no earlier entry.` } : { parent }
  }
  if (!entry.parent) {
    return { parent: undefined }
  }

  return list.some(i => i.id === entry.parent)
    ? { parent: entry.parent }
    : { deny: `items[${n}].parent: no ledger item ${entry.parent}.` }
}

function plan(list: LedgerItem[], batch: NewItem[], base: number): Plan {
  const refs = new Map<string, number>()
  const made: LedgerItem[] = []
  for (const [n, entry] of batch.entries()) {
    const kind = kindOf(entry.kind)
    if (!kind || !entry.title) {
      return { deny: `items[${n}] needs "kind" and "title".` }
    }
    const nesting = parentOfEntry(entry, n, refs, list)
    if ('deny' in nesting) {
      return nesting
    }
    const id = base + n + 1
    if (entry.ref !== undefined && refs.has(entry.ref)) {
      return { deny: `items[${n}].ref "${entry.ref}" is used twice.` }
    }
    if (entry.ref !== undefined) {
      refs.set(entry.ref, id)
    }
    const { detail, where, url, title } = entry
    made.push({ id, kind, title, detail, where, url, parent: nesting.parent, status: 'open' })
  }

  return { made }
}

/** Logs a batch in order, all or nothing; "under" refers to an earlier entry's "ref". */
export async function addMany($: EngineInterface, list: LedgerItem[], batch: NewItem[]): Promise<ToolAnswer> {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { deny: 'add with "items" needs at least one entry.' }
  }
  const base = topId(list)
  const planned = plan(list, batch, base)
  if ('deny' in planned) {
    return planned
  }
  let shift = 0
  // Numbers taken since the list was read move the batch along with its own parents.
  const moved = (id?: number) => (id !== undefined && id > base ? id + shift : id)
  await updateItems($, (current: LedgerItem[]) => {
    shift = topId(current) - base

    return [...current, ...planned.made.map(i => ({ ...i, id: i.id + shift, parent: moved(i.parent) }))]
  })
  await persist($)
  const lines = planned.made.map(i => `${i.id + shift} (ledger) ${i.title}` + when(i.parent, `, under ${moved(i.parent)}`))

  return { result: `Logged ${planned.made.length} items:\n${lines.join('\n')}` }
}
