import type { LedgerItem, LedgerKind, LedgerNote, LedgerStatus } from '../types'

export const PANE = 'ledger'
export const TOOL = 'mcp__ledger__ledger'
export const FORMAT = 'ledger/1'

export const KINDS: { kind: LedgerKind; title: string }[] = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'bug', title: 'Bugs' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'smell', title: 'Smells' },
]
export const STATUSES: LedgerStatus[] = ['open', 'in-progress', 'resolved', 'obsolete']
export const GLYPHS: Record<LedgerStatus, string> = { open: '☐', 'in-progress': '◐', resolved: '✓', obsolete: '–' }

export const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/

export const kindOf = (v: unknown) => KINDS.find(k => k.kind === v)?.kind

/** Not finished yet: open or in progress. */
export const isOpen = (i: LedgerItem) => i.status === 'open' || i.status === 'in-progress'

/** In progress first, then open, then finished, each in the order logged. */
export const openFirst = (list: LedgerItem[]) => [
  ...list.filter(i => i.status === 'in-progress'),
  ...list.filter(i => i.status === 'open'),
  ...list.filter(i => !isOpen(i)),
]

export const linkOf = (i: LedgerItem) => i.url ?? i.detail?.match(/https?:\/\/[^\s|<>()[\]]+/)?.[0]

export const lastNote = (i: LedgerItem) => i.notes?.[i.notes.length - 1]

/** A timestamp as "YYYY-MM-DD HH:MM". */
export const stamp = (at: string) => at.slice(0, 16).replace('T', ' ')

export const topId = (list: LedgerItem[]) => list.reduce((max, i) => Math.max(max, i.id), 0)

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The text without `c` repeated at its start. */
export function trimStart(s: string, c: string) {
  let start = 0
  while (start < s.length && s[start] === c) {
    start++
  }

  return s.slice(start)
}

/** The text without `c` repeated at its end. */
export function trimEnd(s: string, c: string) {
  let end = s.length
  while (end > 0 && s[end - 1] === c) {
    end--
  }

  return s.slice(0, end)
}

/** Lets a promise run on its own: what it opens or sends is a courtesy, and its failure no error. */
export function background(work: Promise<unknown>) {
  work.catch(() => undefined)
}

/** "text" when there is a value, nothing otherwise: for optional parts of a line. */
export const when = (value: unknown, text: string) => (value ? text : '')

/** The item's parent, unless it is missing or its chain loops back. */
export function parentOf(i: LedgerItem, byId: Map<number, LedgerItem>): LedgerItem | undefined {
  const parent = i.parent === undefined ? undefined : byId.get(i.parent)
  let at = parent
  for (let steps = 0; at && steps <= byId.size; steps++) {
    if (at.id === i.id) {
      return undefined
    }
    at = at.parent === undefined ? undefined : byId.get(at.parent)
  }

  return parent
}

export function descendants(id: number, list: LedgerItem[]): LedgerItem[] {
  const kids = list.filter(i => i.parent === id && i.id !== id)

  return kids.flatMap(k => [k, ...descendants(k.id, list.filter(i => i.id !== k.id))])
}

/** One line per item, as the system prompt and the "list" action show it. */
export function describe(i: LedgerItem): string {
  const note = lastNote(i)
  const parts = [
    `${i.id} [${i.kind}]`,
    when(i.status === 'in-progress', ' (in progress)'),
    ` ${i.title}`,
    when(i.where, ` (${i.where})`),
    when(i.parent, ` under ${i.parent}`),
    note ? ` | last note ${note.at.slice(0, 10)}: ${note.text.slice(0, 160)}` : '',
  ]

  return parts.join('')
}

const textOf = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

const isNote = (n: unknown): n is LedgerNote => {
  const note = n as LedgerNote | null

  return !!note && typeof note.at === 'string' && typeof note.text === 'string' && note.text !== ''
}

function itemOf(raw: unknown): LedgerItem | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const i = raw as Record<string, unknown>
  const kind = kindOf(i.kind)
  if (typeof i.id !== 'number' || !kind || typeof i.title !== 'string') {
    return undefined
  }
  const notes = Array.isArray(i.notes) ? i.notes.filter(isNote) : []

  return {
    id: i.id,
    kind,
    title: i.title,
    detail: textOf(i.detail),
    where: textOf(i.where),
    url: textOf(i.url),
    parent: typeof i.parent === 'number' ? i.parent : undefined,
    status: STATUSES.find(s => s === i.status) ?? 'open',
    outcome: textOf(i.outcome),
    notes: notes.length ? notes : undefined,
    github: textOf(i.github),
  }
}

/** The well-formed items of an imported list, the rest dropped. */
export function sanitize(raw: unknown): LedgerItem[] {
  return Array.isArray(raw) ? raw.flatMap(r => itemOf(r) ?? []) : []
}

/** Renumbers incoming items after the current ones, keeping their order and their parents. */
export function renumber(incoming: LedgerItem[], current: LedgerItem[]): LedgerItem[] {
  const base = topId(current)
  const ids = new Map([...incoming].sort((a, b) => a.id - b.id).map((i, n) => [i.id, base + n + 1]))

  return incoming.map(i => ({
    ...i,
    id: ids.get(i.id) as number,
    parent: i.parent === undefined ? undefined : ids.get(i.parent),
  }))
}
