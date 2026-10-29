import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerExport, LedgerItem, LedgerKind, LedgerNote, LedgerOrigin, LedgerSave, LedgerStatus } from '../types'

const PANE = 'ledger'
const TOOL = 'mcp__ledger__ledger'
const FORMAT = 'ledger/1'
const SAVES_KEPT = 30
const items = atom({ plugin: 'ledger', key: 'items' } as const, [])
const folded = atom({ plugin: 'ledger', key: 'folded' } as const, [])
const hideDone = atom({ plugin: 'ledger', key: 'hideDone' } as const, false)
/** The session the last ledger was offered to, so the offer comes once. */
const offeredFor = atom({ plugin: 'ledger', key: 'offeredFor' } as const, '')

const KINDS: { kind: LedgerKind; title: string }[] = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'bug', title: 'Bugs' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'smell', title: 'Smells' },
]
const STATUSES: LedgerStatus[] = ['open', 'in-progress', 'resolved', 'obsolete']

/** One item of a batch "add": "ref" names it for "under" in later entries of the same batch. */
type NewItem = {
  ref?: string
  under?: string
  parent?: number
  kind?: LedgerKind
  title?: string
  detail?: string
  where?: string
  url?: string
}

type Input = {
  action: 'add' | 'start' | 'resolve' | 'obsolete' | 'reopen' | 'move' | 'edit' | 'note' | 'list' | 'brief'
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

const lastNote = (i: LedgerItem) => i.notes?.[i.notes.length - 1]

const describe = (i: LedgerItem) => {
  const note = lastNote(i)

  return `${i.id} [${i.kind}]${i.status === 'in-progress' ? ' (in progress)' : ''} ${i.title}${i.where ? ` (${i.where})` : ''}${i.parent ? ` under ${i.parent}` : ''}${note ? ` | last note ${note.at.slice(0, 10)}: ${note.text.slice(0, 160)}` : ''}`
}

const RULES = `The ledger is a numbered list the person keeps in a side panel of open decisions, bugs, gaps and code smells found during this session. Use the ${TOOL} tool:
- add: when you find a confirmed bug, a spec or documentation gap, a code smell worth tracking, or a decision the person must make that you cannot settle yourself. Log it as soon as you find it, with a short title and, when known, "where" (file:line), "detail" (for a decision, the options) and "url" (an issue or page it tracks; the panel makes the title a link). Give "parent" (an item number) to nest it under another item, as an issue under its epic. Do not log trivia or things you will simply do as part of the task.
- add with "items" (instead of one item's fields) logs several at once, as when mapping a roadmap: each entry takes the same fields plus "ref" (a name for it) and "under" (the ref of an earlier entry to nest under) or "parent" (an existing number). All are logged or none.
- start: when you begin working on an item; it shows as in progress until resolved.
- note: append a dated line of progress to an item ("note"): what was done, what is left, where you stopped. Prefer notes over rewriting the title, so the next session can pick up the item.
- edit: fix an item's "title", "kind", "detail", "where" or "url" without changing its number; an empty string clears detail, where or url.
- resolve: when the person decides or the item is dealt with; put what was done in "outcome".
- obsolete: when a finding stops mattering (for example the code was removed or the premise was wrong); say why in "outcome". Check the open items whenever your work could invalidate one.
- move: set an item's "parent", or 0 to make it top-level.
- brief: only when asked to write the briefing of an export, with its "path" and the "briefing".
- When the person says "add them to the ledger", log everything open from the conversation that is not on the list yet.
A number followed by "(ledger)" (e.g. "13 (ledger)") or written "L13" refers to the ledger item with that number. Numbers are never reused.`

const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+/

const linkOf = (i: LedgerItem) => i.url ?? i.detail?.match(/https?:\/\/[^\s|<>()[\]]+/)?.[0]

/** Not finished yet: open or in progress. */
const isOpen = (i: LedgerItem) => i.status === 'open' || i.status === 'in-progress'

/** In progress first, then open, then finished, each in the order logged. */
const openFirst = (list: LedgerItem[]) => [
  ...list.filter(i => i.status === 'in-progress'),
  ...list.filter(i => i.status === 'open'),
  ...list.filter(i => !isOpen(i)),
]

const GLYPHS: Record<LedgerStatus, string> = { open: '☐', 'in-progress': '◐', resolved: '✓', obsolete: '–' }

/** The item's parent, unless it is missing or its chain loops back. */
function parentOf(i: LedgerItem, byId: Map<number, LedgerItem>): LedgerItem | undefined {
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

/**
 * A drawn item: its depth and tree guide, its children's progress (finished of
 * all, obsolete ones left out), and how many items beneath it a fold hides.
 */
type Row = {
  item: LedgerItem
  depth: number
  guide: string
  kids: number
  progress?: { done: number; total: number }
  hidden: number
}

/** What the pane leaves out: folded parents' subtrees, and finished items when asked. */
type View = { folded?: readonly number[]; hideDone?: boolean }

/**
 * The ledger as drawn: top-level items grouped by kind, each followed by its
 * children (whatever their kind), open before closed within every group.
 */
function sections(list: LedgerItem[], view: View = {}): { kind: LedgerKind; title: string; rows: Row[] }[] {
  const byId = new Map(list.map(i => [i.id, i]))
  const children = new Map<number, LedgerItem[]>()
  const roots: LedgerItem[] = []
  for (const i of list) {
    const parent = parentOf(i, byId)
    if (parent) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), i])
    } else {
      roots.push(i)
    }
  }
  const below = (id: number): LedgerItem[] =>
    (children.get(id) ?? []).flatMap(kid => [kid, ...below(kid.id)])
  // A finished item stays while anything beneath it is unfinished.
  const shown = (i: LedgerItem) => !view.hideDone || isOpen(i) || below(i.id).some(isOpen)
  const walk = (item: LedgerItem, depth: number, guide: string, lead: string): Row[] => {
    const all = children.get(item.id) ?? []
    const counted = all.filter(k => k.status !== 'obsolete')
    const progress = counted.length
      ? { done: counted.filter(k => k.status === 'resolved').length, total: counted.length }
      : undefined
    const isFolded = view.folded?.includes(item.id) ?? false
    const kids = isFolded ? [] : openFirst(all.filter(shown))

    return [
      { item, depth, guide, kids: all.length, progress, hidden: isFolded ? below(item.id).length : 0 },
      ...kids.flatMap((kid, n) => {
        const isLast = n === kids.length - 1

        return walk(kid, depth + 1, `${lead}${isLast ? '└─ ' : '├─ '}`, `${lead}${isLast ? '   ' : '│  '}`)
      }),
    ]
  }

  return KINDS.map(({ kind, title }) => ({
    kind,
    title,
    rows: openFirst(roots.filter(i => i.kind === kind && shown(i))).flatMap(i => walk(i, 0, '', '')),
  })).filter(s => s.rows.length > 0)
}

function descendants(id: number, list: LedgerItem[]): LedgerItem[] {
  const kids = list.filter(i => i.parent === id && i.id !== id)

  return kids.flatMap(k => [k, ...descendants(k.id, list.filter(i => i.id !== k.id))])
}

function sanitize(raw: unknown): LedgerItem[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.flatMap((r): LedgerItem[] => {
    if (!r || typeof r !== 'object') {
      return []
    }
    const i = r as Record<string, unknown>
    const kind = KINDS.find(k => k.kind === i.kind)?.kind
    if (typeof i.id !== 'number' || !kind || typeof i.title !== 'string') {
      return []
    }
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
    const notes = Array.isArray(i.notes)
      ? i.notes.filter(
          (n): n is LedgerNote => !!n && typeof n.at === 'string' && typeof n.text === 'string' && n.text !== '',
        )
      : []

    return [
      {
        id: i.id,
        kind,
        title: i.title,
        detail: text(i.detail),
        where: text(i.where),
        url: text(i.url),
        parent: typeof i.parent === 'number' ? i.parent : undefined,
        status: STATUSES.find(s => s === i.status) ?? 'open',
        outcome: text(i.outcome),
        notes: notes.length ? notes : undefined,
        github: text(i.github),
      },
    ]
  })
}

const isExport = (v: unknown): v is LedgerExport =>
  !!v && typeof v === 'object' && (v as LedgerExport).format === FORMAT && Array.isArray((v as LedgerExport).items)

const mdPathOf = (json: string) => json.replace(/\.json$/, '') + '.md'

const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'ledger'

function markdown(data: LedgerExport): string {
  const lines = [
    `# Ledger: ${data.project}`,
    '',
    `Session \`${data.sessionId}\`${data.branch ? `, branch \`${data.branch}\`` : ''}, exported ${data.exportedAt}.`,
    '',
    '## Briefing',
    '',
    data.briefing ?? '_Not written yet._',
  ]
  for (const { title, kind, rows } of sections(data.items)) {
    lines.push('', `## ${title}`, '')
    for (const { item: i, depth, progress } of rows) {
      const pad = '  '.repeat(depth)
      const link = linkOf(i)
      const name = link ? `[${i.title}](${link})` : i.title
      const tag = depth > 0 && i.kind !== kind ? ` [${i.kind}]` : ''
      lines.push(
        `${pad}- [${isOpen(i) ? ' ' : 'x'}] ${i.id}. ${name}${progress ? ` (${progress.done}/${progress.total})` : ''}${tag}${i.status === 'in-progress' ? ' (in progress)' : ''}${i.status === 'obsolete' ? ' (obsolete)' : ''}${i.where ? ` (\`${i.where}\`)` : ''}`,
      )
      if (i.detail) {
        lines.push(`${pad}  - ${i.detail}`)
      }
      for (const note of i.notes ?? []) {
        lines.push(`${pad}  - ${note.at.slice(0, 16).replace('T', ' ')}: ${note.text}`)
      }
      if (i.outcome) {
        lines.push(`${pad}  - → ${i.outcome}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

async function writeExport($: EngineInterface, path: string, data: LedgerExport) {
  await $.fs.write(path, `${JSON.stringify(data, null, 2)}\n`)
  await $.fs.write(mdPathOf(path), markdown(data))
}

async function originOf($: EngineInterface): Promise<LedgerOrigin> {
  const [sessionId, root] = await Promise.all([$.session.id(), $.session.root()])
  let branch: string | null = null
  try {
    const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    branch = git.exitCode === 0 ? git.stdout.trim() || null : null
  } catch {
    branch = null
  }

  return { sessionId, project: root.split('/').filter(Boolean).pop() ?? 'ledger', root, branch }
}

async function ledgersDir($: EngineInterface, project: string) {
  return `${(await $.env.get('HOME')) ?? '~'}/.claude/ledgers/${slug(project)}`
}

/**
 * Mirrors the session's ledger to the store, so a restart or /clear can bring
 * it back. `sessionId` names the session it belongs to when the engine may
 * already answer the next one's (at session.end).
 */
async function save($: EngineInterface, sessionId?: string) {
  try {
    const origin = { ...(await originOf($)), ...(sessionId ? { sessionId } : {}) }
    const list: LedgerItem[] = await read($, items)
    if (list.length === 0) {
      return
    }
    const entry: LedgerSave = { ...origin, updatedAt: new Date().toISOString(), items: list }
    await $.store.set(`session:${origin.sessionId}`, entry)
    const saves = await storedSaves($)
    for (const old of saves.slice(SAVES_KEPT)) {
      await $.store.delete(`session:${old.sessionId}`)
    }
  } catch (error) {
    $.ui.log(`ledger: auto-save failed: ${String(error)}`, { to: 'debug' })
  }
}

/** Every auto-saved ledger, newest first. */
async function storedSaves($: EngineInterface): Promise<LedgerSave[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('session:'))
  const saves = await Promise.all(keys.map(k => $.store.get(k)))

  return (saves.filter(s => s && typeof s === 'object') as LedgerSave[]).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )
}

async function refresh($: EngineInterface) {
  const list: LedgerItem[] = await read($, items)
  const open = list.filter(isOpen).length
  const active = list.filter(i => i.status === 'in-progress').length
  $.ui.status(open > 0 ? `ledger: ${open} open${active ? `, ${active} in progress` : ''}` : undefined)
}

type Source = { label: string; at: string; load: () => Promise<LedgerExport> }

/** Ledgers this session could import: other sessions' auto-saves of this project, and its exports. */
async function sources($: EngineInterface): Promise<Source[]> {
  const origin = await originOf($)
  const saved = (await storedSaves($))
    .filter(s => s.root === origin.root && s.sessionId !== origin.sessionId && s.items.length > 0)
    .map(
      (s): Source => ({
        label: `auto-save of session ${s.sessionId}${s.branch ? ` (${s.branch})` : ''}, ${s.items.length} items`,
        at: s.updatedAt,
        load: async () => ({ ...s, format: FORMAT, exportedAt: s.updatedAt, briefing: null }),
      }),
    )
  const dir = await ledgersDir($, origin.project)
  const files = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const exported = files
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .map(
      (f): Source => ({
        label: `${dir}/${f.name}`,
        at: new Date(f.mtimeMs).toISOString(),
        load: () => loadExport($, `${dir}/${f.name}`),
      }),
    )

  return [...saved, ...exported].sort((a, b) => b.at.localeCompare(a.at))
}

async function loadExport($: EngineInterface, path: string): Promise<LedgerExport> {
  const data: unknown = JSON.parse(String(await $.fs.read(path)))
  if (!isExport(data)) {
    throw new Error(`${path} is not a ledger export (${FORMAT}).`)
  }

  return data
}

async function absolute($: EngineInterface, path: string) {
  if (path.startsWith('~/')) {
    return `${(await $.env.get('HOME')) ?? '~'}${path.slice(1)}`
  }

  return path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
}

/** Logs a batch in order, all or nothing; "under" refers to an earlier entry's "ref". */
async function addMany($: EngineInterface, list: LedgerItem[], batch: NewItem[]) {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { deny: 'add with "items" needs at least one entry.' }
  }
  const base = list.reduce((max, i) => Math.max(max, i.id), 0)
  const refs = new Map<string, number>()
  const made: LedgerItem[] = []
  for (const [n, entry] of batch.entries()) {
    const kind = KINDS.find(k => k.kind === entry.kind)?.kind
    if (!kind || !entry.title) {
      return { deny: `items[${n}] needs "kind" and "title".` }
    }
    let parent: number | undefined
    if (entry.under !== undefined) {
      parent = refs.get(entry.under)
      if (parent === undefined) {
        return { deny: `items[${n}].under "${entry.under}" names no earlier entry.` }
      }
    } else if (entry.parent) {
      if (!list.some(i => i.id === entry.parent)) {
        return { deny: `items[${n}].parent: no ledger item ${entry.parent}.` }
      }
      parent = entry.parent
    }
    const id = base + n + 1
    if (entry.ref !== undefined) {
      if (refs.has(entry.ref)) {
        return { deny: `items[${n}].ref "${entry.ref}" is used twice.` }
      }
      refs.set(entry.ref, id)
    }
    made.push({
      id,
      kind,
      title: entry.title,
      detail: entry.detail,
      where: entry.where,
      url: entry.url,
      parent,
      status: 'open',
    })
  }
  let shift = 0
  await update($, items, (current: LedgerItem[]) => {
    // Numbers taken since the list was read move the batch along with its own parents.
    shift = current.reduce((max, i) => Math.max(max, i.id), 0) - base
    const moved = (id?: number) => (id !== undefined && id > base ? id + shift : id)

    return [...current, ...made.map(i => ({ ...i, id: i.id + shift, parent: moved(i.parent) }))]
  })
  await save($)
  await refresh($)

  return {
    result: `Logged ${made.length} items:\n${made.map(i => `${i.id + shift} (ledger) ${i.title}${i.parent ? `, under ${i.parent > base ? i.parent + shift : i.parent}` : ''}`).join('\n')}`,
  }
}

/** Renumbers incoming items after the current ones, keeping their order and their parents. */
function renumber(incoming: LedgerItem[], current: LedgerItem[]): LedgerItem[] {
  const base = current.reduce((max, i) => Math.max(max, i.id), 0)
  const ids = new Map([...incoming].sort((a, b) => a.id - b.id).map((i, n) => [i.id, base + n + 1]))

  return incoming.map(i => ({
    ...i,
    id: ids.get(i.id) as number,
    parent: i.parent === undefined ? undefined : ids.get(i.parent),
  }))
}

/**
 * On an empty ledger, once per session: point at the newest ledger of this
 * project and put /ledger-import in an empty prompt. Nothing loads by itself.
 */
async function offer($: EngineInterface) {
  try {
    const sessionId = await $.session.id()
    if ((await read($, items)).length > 0 || (await read($, offeredFor)) === sessionId) {
      return
    }
    const [latest] = await sources($)
    if (!latest) {
      return
    }
    await update($, offeredFor, () => sessionId)
    $.ui.toast(`Ledger available: ${latest.label}. Run /ledger-import to load it.`)
    if ((await $.prompt.read()).text === '') {
      await $.prompt.fill({ text: '/ledger-import' })
    }
  } catch (error) {
    $.ui.log(`ledger: offer failed: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ledger',
      description:
        'Log, track, resolve or retire numbered items (decisions, bugs, gaps, smells) in the ledger side panel the person is watching, nest them under one another, note progress on them, and write the briefing of an export. Actions: add, start, note, edit, resolve, obsolete, reopen, move, list, brief.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'start', 'note', 'edit', 'resolve', 'obsolete', 'reopen', 'move', 'list', 'brief'],
          },
          kind: { type: 'string', enum: ['decision', 'bug', 'gap', 'smell'] },
          title: { type: 'string', description: 'Short one-line title (add, edit).' },
          detail: { type: 'string', description: 'Context or, for a decision, the options (add, edit).' },
          where: { type: 'string', description: 'file:line the item concerns (add, edit).' },
          url: { type: 'string', description: 'Link to the issue or page the item tracks (add, edit).' },
          parent: { type: 'integer', description: 'Item number to nest under (add, move); 0 makes it top-level (move).' },
          id: { type: 'integer', description: 'Item number (start, note, edit, resolve, obsolete, reopen, move).' },
          outcome: { type: 'string', description: 'What was decided or done, or why obsolete.' },
          note: { type: 'string', description: 'A line of progress to append, dated (note).' },
          path: { type: 'string', description: 'The export file the briefing belongs to (brief).' },
          briefing: { type: 'string', description: 'The session briefing, in Markdown (brief).' },
          items: {
            type: 'array',
            description: 'Several items to log at once (add), in order; nest with "under" or "parent".',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'A name for this entry, for "under" in later entries.' },
                under: { type: 'string', description: 'The ref of an earlier entry in this batch to nest under.' },
                parent: { type: 'integer', description: 'An existing item number to nest under.' },
                kind: { type: 'string', enum: ['decision', 'bug', 'gap', 'smell'] },
                title: { type: 'string' },
                detail: { type: 'string' },
                where: { type: 'string' },
                url: { type: 'string' },
              },
              required: ['kind', 'title'],
            },
          },
        },
        required: ['action'],
      },
    })
    await $.command.register({
      name: 'ledger',
      description: 'Open the ledger panel; "done" shows or hides finished items',
      argumentHint: '[done]',
    })
    await $.command.register({
      name: 'ledger-export',
      description: 'Export the ledger, with a session briefing, to JSON and Markdown',
      argumentHint: '[dir or file.json]',
    })
    await $.command.register({
      name: 'ledger-sync',
      description: 'Check the GitHub issues and pull requests ledger items link, and resolve the closed ones',
    })
    await $.command.register({
      name: 'ledger-import',
      description: "Load an exported or another session's ledger into this session",
      argumentHint: '[file.json | list] [--replace | --merge]',
    })
    void $.ui.open({ id: PANE, title: 'Ledger' })
    // A reload into a live session: save a ledger the store has not seen yet.
    void (async () => {
      if ((await $.store.get(`session:${await $.session.id()}`)) === undefined) {
        await save($)
      }
    })().catch(() => undefined)
    $.clock.after(500, () => void offer($))

    return next(e)
  })

  // /clear and /new empty the session's state: keep the ledger as it ends.
  on('session.end', async ($, e, next) => {
    await save($, e.sessionId)
    if (e.reason === 'clear') {
      // The process goes on as a new, empty session: offer the ledger just saved.
      $.clock.after(500, () => void offer($))
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'ledger' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Ledger' })
    if (e.args.trim() === 'done') {
      const hidden = await update($, hideDone, (v: boolean) => !v)

      return { text: hidden ? 'Finished ledger items are hidden.' : 'Finished ledger items are shown.' }
    }

    return { text: 'Ledger panel opened.' }
  })

  on('command.run', { command: 'ledger-export' }, async ($, e) => {
    const list: LedgerItem[] = await read($, items)
    if (list.length === 0) {
      return { text: 'The ledger is empty: nothing to export.' }
    }
    const origin = await originOf($)
    const exportedAt = new Date().toISOString()
    const name = `${exportedAt.slice(0, 16).replace(/[:T]/g, '-')}-${slug(origin.branch ?? 'no-branch')}.json`
    const arg = e.args.trim()
    const path = !arg
      ? `${await ledgersDir($, origin.project)}/${name}`
      : arg.endsWith('.json')
        ? await absolute($, arg)
        : `${(await absolute($, arg)).replace(/\/+$/, '')}/${name}`
    try {
      await writeExport($, path, { format: FORMAT, ...origin, exportedAt, briefing: null, items: list })
    } catch (error) {
      return { text: `Could not write the export to ${path}: ${String(error)}` }
    }
    // Submitting from the command's own hook would wait on the turn it holds.
    $.clock.after(1, () => {
      void $.prompt.submit({
        text: `The ledger was exported to ${path}. Write a briefing for the next session that will import it: the goal of this session, where the work stopped, what is in progress, the next steps, and pointers (branch, files, commands, issues). Keep it short Markdown and do not repeat the ledger items. Then call the ${TOOL} tool with action "brief", path "${path}" and the briefing.`,
      })
    })

    return {
      text: `Ledger exported (${list.length} items) to ${path} and ${mdPathOf(path)}. Asking Claude for the session briefing.`,
    }
  })

  on('command.run', { command: 'ledger-import' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const replace = words.includes('--replace')
    const merge = words.includes('--merge')
    const arg = words.filter(w => w !== '--replace' && w !== '--merge').join(' ')

    let label: string
    let data: LedgerExport
    try {
      if (arg === 'list') {
        const found = await sources($)

        return {
          text: found.length
            ? `Ledgers for this project, newest first:\n${found.map(s => `- ${s.at.slice(0, 16)}: ${s.label}`).join('\n')}`
            : 'No ledgers found for this project.',
        }
      }
      if (arg) {
        label = await absolute($, arg)
        data = await loadExport($, label)
      } else {
        const [latest] = await sources($)
        if (!latest) {
          return { text: 'No ledgers found for this project. Give a path: /ledger-import <file.json>.' }
        }
        label = latest.label
        data = await latest.load()
      }
    } catch (error) {
      return { text: `Could not import: ${error instanceof Error ? error.message : String(error)}` }
    }

    const incoming = sanitize(data.items)
    if (incoming.length === 0) {
      return { text: `${label} has no ledger items to import.` }
    }
    const current: LedgerItem[] = await read($, items)
    if (current.length > 0 && !replace && !merge) {
      const again = `/ledger-import ${arg ? `${arg} ` : ''}`

      return {
        text: `This session's ledger already has ${current.length} items. Run ${again}--replace to replace them with the ${incoming.length} items of ${label}, or ${again}--merge to add them after the current ones, renumbered.`,
      }
    }
    const merged = merge && current.length > 0
    await update($, items, (now: LedgerItem[]) => (merged ? [...now, ...renumber(incoming, now)] : incoming))
    await save($)
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Ledger' })

    return {
      text: `Imported ${incoming.length} ledger items from ${label}${merged ? ', renumbered after the current ones' : ''}.`,
      context: [
        `The ledger was imported from ${label} (session ${data.sessionId}${data.branch ? `, branch ${data.branch}` : ''}, ${data.exportedAt}). ${merged ? 'Its items were renumbered after the ones already here, so numbers in the briefing below are that session’s, not this ledger’s.' : 'Item numbers are those of that session.'}${data.briefing ? `\n\nBriefing from that session:\n\n${data.briefing}` : ''}`,
      ],
    }
  })

  on('command.run', { command: 'ledger-sync' }, async $ => {
    const list: LedgerItem[] = await read($, items)
    const tracked = list.flatMap(i => {
      const match = linkOf(i)?.match(GITHUB)

      return match ? [{ item: i, url: match[0], what: match[1] === 'pull' ? 'pr' : 'issue' }] : []
    })
    if (tracked.length === 0) {
      return { text: 'No ledger items link a GitHub issue or pull request.' }
    }
    const states = new Map<number, { state: string; what: string }>()
    const failed: string[] = []
    for (const { item, url, what } of tracked) {
      try {
        const gh = await $.process.run(['gh', what, 'view', url, '--json', 'state'], { timeoutMs: 15000 })
        if (gh.exitCode !== 0) {
          failed.push(`${item.id} (${gh.stderr.trim().split('\n')[0] || `gh exited ${gh.exitCode}`})`)
          continue
        }
        states.set(item.id, { state: String(JSON.parse(gh.stdout).state).toLowerCase(), what })
      } catch (error) {
        failed.push(`${item.id} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const isClosed = (state: string) => state === 'closed' || state === 'merged'
    const closing = list.filter(i => isOpen(i) && isClosed(states.get(i.id)?.state ?? ''))
    const stale = list.filter(i => !isOpen(i) && states.get(i.id)?.state === 'open')
    const at = new Date().toISOString()
    await update($, items, (current: LedgerItem[]) =>
      current.map(i => {
        const found = states.get(i.id)
        if (!found) {
          return i
        }
        if (!isOpen(i) || !isClosed(found.state)) {
          return { ...i, github: found.state }
        }
        const kind = found.what === 'pr' ? 'pull request' : 'issue'

        return {
          ...i,
          github: found.state,
          status: 'resolved' as const,
          outcome: i.outcome ?? `The ${kind} is ${found.state} on GitHub.`,
          notes: [...(i.notes ?? []), { at, text: `Resolved by /ledger-sync: the ${kind} is ${found.state}.` }],
        }
      }),
    )
    await save($)
    await refresh($)

    return {
      text: [
        `Checked ${states.size} of ${tracked.length} GitHub links.`,
        closing.length ? `Resolved, closed on GitHub: ${closing.map(i => i.id).join(', ')}.` : 'Nothing to resolve.',
        stale.length ? `Finished here but open on GitHub: ${stale.map(i => i.id).join(', ')}.` : '',
        failed.length ? `Could not check: ${failed.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Input
    const list: LedgerItem[] = await read($, items)

    if (input.action === 'list') {
      const open = list.filter(isOpen)

      return { result: open.length === 0 ? 'Ledger: nothing open.' : open.map(describe).join('\n') }
    }

    if (input.action === 'brief') {
      if (!input.path || !input.briefing) {
        return { deny: 'brief needs "path" and "briefing".' }
      }
      try {
        const data = await loadExport($, input.path)
        await writeExport($, input.path, { ...data, briefing: input.briefing })
      } catch (error) {
        return { deny: `Could not save the briefing: ${error instanceof Error ? error.message : String(error)}` }
      }

      return { result: `Briefing saved to ${input.path} and ${mdPathOf(input.path)}.` }
    }

    const parent = input.parent ? list.find(i => i.id === input.parent) : undefined
    if (input.parent && !parent) {
      return { deny: `No ledger item ${input.parent} to nest under.` }
    }

    if (input.action === 'add' && input.items) {
      return addMany($, list, input.items)
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
            url: input.url,
            parent: parent?.id,
            status: 'open' as const,
          },
        ]
      })
      await save($)
      await refresh($)

      return { result: `Logged as ${id} (ledger)${parent ? `, under ${parent.id}` : ''}.` }
    }

    const target = list.find(i => i.id === input.id)
    if (!target) {
      return { deny: `No ledger item ${input.id}.` }
    }

    if (input.action === 'edit') {
      if (input.title === '') {
        return { deny: 'An item needs a title; leave "title" out to keep it.' }
      }
      const cleared = (v: string | undefined, was: string | undefined) => (v === undefined ? was : v || undefined)
      await update($, items, (current: LedgerItem[]) =>
        current.map(i =>
          i.id === target.id
            ? {
                ...i,
                title: input.title ?? i.title,
                kind: input.kind ?? i.kind,
                detail: cleared(input.detail, i.detail),
                where: cleared(input.where, i.where),
                url: cleared(input.url, i.url),
              }
            : i,
        ),
      )
      await save($)

      return { result: `${target.id} (ledger) edited.` }
    }

    if (input.action === 'note') {
      if (!input.note) {
        return { deny: 'note needs "note".' }
      }
      const note = { at: new Date().toISOString(), text: input.note }
      await update($, items, (current: LedgerItem[]) =>
        current.map(i => (i.id === target.id ? { ...i, notes: [...(i.notes ?? []), note] } : i)),
      )
      await save($)

      return { result: `Note added to ${target.id} (ledger).` }
    }

    if (input.action === 'move') {
      if (parent && (parent.id === target.id || descendants(target.id, list).some(d => d.id === parent.id))) {
        return { deny: `${parent.id} is ${target.id} or one of its children; an item cannot sit under itself.` }
      }
      await update($, items, (current: LedgerItem[]) =>
        current.map(i => (i.id === target.id ? { ...i, parent: parent?.id } : i)),
      )
      await save($)

      return { result: `${target.id} (ledger) is now ${parent ? `under ${parent.id}` : 'top-level'}.` }
    }

    const status = { start: 'in-progress', resolve: 'resolved', obsolete: 'obsolete', reopen: 'open' }[
      input.action
    ] as LedgerStatus | undefined
    if (!status) {
      return { deny: `Unknown action "${input.action}".` }
    }
    await update($, items, (current: LedgerItem[]) =>
      current.map(i => (i.id === target.id ? { ...i, status, outcome: input.outcome ?? i.outcome } : i)),
    )
    await save($)
    await refresh($)
    const stillOpen = isOpen({ ...target, status }) ? [] : descendants(target.id, list).filter(isOpen)

    return {
      result: `${target.id} (ledger) is now ${status}.${stillOpen.length ? ` It still has open children: ${stillOpen.map(i => i.id).join(', ')}.` : ''}`,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const open = (await read($, items)).filter(isOpen)
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
      .map(
        i =>
          `Ledger ${i.id} (${i.status}): ${i.title}${i.detail ? ` | ${i.detail}` : ''}${i.where ? ` | ${i.where}` : ''}${i.url ? ` | ${i.url}` : ''}${(i.notes ?? []).map(n => `\n  ${n.at.slice(0, 16).replace('T', ' ')}: ${n.text}`).join('')}`,
      )

    return next(notes.length ? { ...e, text: `${text}\n\n${notes.join('\n')}` } : e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const list: LedgerItem[] = await read($, items)
    const view = { folded: (await read($, folded)) as number[], hideDone: (await read($, hideDone)) as boolean }

    if (list.length === 0) {
      return <Text dimColor>Ledger is empty.</Text>
    }
    const groups = sections(list, view)
    const drawn = groups.reduce((sum, g) => sum + g.rows.length + g.rows.reduce((h, r) => h + r.hidden, 0), 0)
    const finished = list.filter(i => !isOpen(i)).length

    return (
      <Box flexDirection="column">
        {finished > 0 ? (
          <Button
            key="toggle-done"
            plain
            dimColor
            label={view.hideDone ? `show ${list.length - drawn} finished` : 'hide finished'}
            onPress={() => void update($, hideDone, (v: boolean) => !v)}
          />
        ) : null}
        {groups.map(({ kind, title, rows }) => (
          <Box flexDirection="column">
            <Text bold>{title}</Text>
            {rows.map(({ item: i, depth, guide, kids, progress, hidden }) => {
              const link = linkOf(i)
              const isFolded = hidden > 0 || view.folded.includes(i.id)

              // One line per item, cut to the pane. Hovering it opens the whole item right
              // beneath, pushing the rows below down. Only the number is a link, so the
              // title stays plain text the pointer can hover.
              return (
                <Box key={`item-${i.id}`} flexDirection="column">
                  <Box flexDirection="row">
                    {kids > 0 ? (
                      // Kept whole: shrunk by the long title, guide and arrow wrap onto lines of their own.
                      <Box key={`lead-${i.id}`} flexDirection="row" flexShrink={0}>
                        {guide ? <Text dimColor={!isOpen(i)}>{guide}</Text> : null}
                        <Button
                          key={`fold-${i.id}`}
                          plain
                          label={isFolded ? '▸' : '▾'}
                          onPress={() =>
                            void update($, folded, (ids: number[]) =>
                              ids.includes(i.id) ? ids.filter(id => id !== i.id) : [...ids, i.id],
                            )
                          }
                        />
                      </Box>
                    ) : null}
                  <Text dimColor={!isOpen(i)} wrap="truncate-end">
                    {kids > 0 ? ' ' : guide}
                    {GLYPHS[i.status]}{' '}
                    {link ? <Link href={link}>{`${i.id}.`}</Link> : `${i.id}.`} {i.title}
                    {progress ? ` (${progress.done}/${progress.total})` : ''}
                    {hidden > 0 ? ` +${hidden} folded` : ''}
                    {depth > 0 && i.kind !== kind ? ` [${i.kind}]` : ''}
                    {i.status === 'obsolete' ? ' (obsolete)' : ''}
                    {i.outcome && !isOpen(i) ? ` → ${i.outcome}` : ''}
                  </Text>
                  </Box>
                  <Box display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round">
                    <Text bold>
                      {i.id}. {i.title}
                    </Text>
                    <Text dimColor>
                      {i.kind}, {i.status === 'in-progress' ? 'in progress' : i.status}
                      {i.parent ? `, under ${i.parent}` : ''}
                      {i.github ? `, GitHub: ${i.github}` : ''}
                    </Text>
                    {i.where ? <Text>{i.where}</Text> : null}
                    {i.detail ? <Text>{i.detail}</Text> : null}
                    {link ? <Link href={link}>{link}</Link> : null}
                    {(i.notes ?? []).map(n => (
                      <Text>
                        <Text dimColor>{n.at.slice(0, 16).replace('T', ' ')}</Text> {n.text}
                      </Text>
                    ))}
                    {i.outcome ? <Text>→ {i.outcome}</Text> : null}
                  </Box>
                </Box>
              )
            })}
            <Text> </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
