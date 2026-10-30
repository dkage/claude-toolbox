import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'

// The engine lists a module's state from the atoms each file reads and writes,
// so every read and write of the session's state lives here, beside them.
const items = atom({ plugin: 'ledger', key: 'items' } as const, [])
const folded = atom({ plugin: 'ledger', key: 'folded' } as const, [])
const hideDone = atom({ plugin: 'ledger', key: 'hideDone' } as const, false)
/** The session the last ledger was offered to, so the offer comes once. */
const offeredFor = atom({ plugin: 'ledger', key: 'offeredFor' } as const, '')

export async function readItems($: EngineInterface): Promise<LedgerItem[]> {
  return read($, items)
}

export async function updateItems($: EngineInterface, fn: (current: LedgerItem[]) => LedgerItem[]) {
  await update($, items, fn)
}

/** Replaces one item with what `fn` makes of it. */
export async function updateItem($: EngineInterface, id: number, fn: (i: LedgerItem) => LedgerItem) {
  await update($, items, (current: LedgerItem[]) => current.map(i => (i.id === id ? fn(i) : i)))
}

export async function readFolded($: EngineInterface): Promise<number[]> {
  return read($, folded)
}

export async function toggleFolded($: EngineInterface, id: number) {
  await update($, folded, (ids: number[]) => (ids.includes(id) ? ids.filter(f => f !== id) : [...ids, id]))
}

export async function readHideDone($: EngineInterface): Promise<boolean> {
  return read($, hideDone)
}

/** Flips whether finished items are hidden, and says whether they now are. */
export async function toggleHideDone($: EngineInterface): Promise<boolean> {
  return update($, hideDone, (v: boolean) => !v)
}

export async function readOfferedFor($: EngineInterface): Promise<string> {
  return read($, offeredFor)
}

export async function setOfferedFor($: EngineInterface, sessionId: string) {
  await update($, offeredFor, () => sessionId)
}
