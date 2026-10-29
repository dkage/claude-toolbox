import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerExport, LedgerItem, LedgerKind, LedgerOrigin, LedgerSave, LedgerStatus } from '../types'

const PANE = 'ledger'
const TOOL = 'mcp__ledger__ledger'
const FORMAT = 'ledger/1'
const SAVES_KEPT = 30
const items = atom({ plugin: 'ledger', key: 'items' } as const, [])

const KINDS: { kind: LedgerKind; title: string }[] = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'bug', title: 'Bugs' },
  { kind: 'gap', title: 'Gaps' },
  { kind: 'smell', title: 'Smells' },
]
const STATUSES: LedgerStatus[] = ['open', 'resolved', 'obsolete']

type Input = {
  action: 'add' | 'resolve' | 'obsolete' | 'reopen' | 'move' | 'list' | 'brief'
  kind?: LedgerKind
  title?: string
  detail?: string
  where?: string
  url?: string
  parent?: number
  id?: number
  outcome?: string
  path?: string
  briefing?: string
}

const describe = (i: LedgerItem) =>
  `${i.id} [${i.kind}] ${i.title}${i.where ? ` (${i.where})` : ''}${i.parent ? ` under ${i.parent}` : ''}`

const RULES = `The ledger is a numbered list the person keeps in a side panel of open decisions, bugs, gaps and code smells found during this session. Use the ${TOOL} tool:
- add: when you find a confirmed bug, a spec or documentation gap, a code smell worth tracking, or a decision the person must make that you cannot settle yourself. Log it as soon as you find it, with a short title and, when known, "where" (file:line), "detail" (for a decision, the options) and "url" (an issue or page it tracks; the panel makes the title a link). Give "parent" (an item number) to nest it under another item, as an issue under its epic. Do not log trivia or things you will simply do as part of the task.
- resolve: when the person decides or the item is dealt with; put what was done in "outcome".
- obsolete: when a finding stops mattering (for example the code was removed or the premise was wrong); say why in "outcome". Check the open items whenever your work could invalidate one.
- move: set an item's "parent", or 0 to make it top-level.
- brief: only when asked to write the briefing of an export, with its "path" and the "briefing".
- When the person says "add them to the ledger", log everything open from the conversation that is not on the list yet.
A number followed by "(ledger)" (e.g. "13 (ledger)") or written "L13" refers to the ledger item with that number. Numbers are never reused.`

const linkOf = (i: LedgerItem) => i.url ?? i.detail?.match(/https?:\/\/[^\s|<>()[\]]+/)?.[0]

const isOpen = (i: LedgerItem) => i.status === 'open'

const openFirst = (list: LedgerItem[]) => [...list.filter(isOpen), ...list.filter(i => !isOpen(i))]

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

type Row = { item: LedgerItem; depth: number; guide: string }

/**
 * The ledger as drawn: top-level items grouped by kind, each followed by its
 * children (whatever their kind), open before closed within every group.
 */
function sections(list: LedgerItem[]): { kind: LedgerKind; title: string; rows: Row[] }[] {
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
  const walk = (item: LedgerItem, depth: number, guide: string, lead: string): Row[] => {
    const kids = openFirst(children.get(item.id) ?? [])

    return [
      { item, depth, guide },
      ...kids.flatMap((kid, n) => {
        const isLast = n === kids.length - 1

        return walk(kid, depth + 1, `${lead}${isLast ? '└─ ' : '├─ '}`, `${lead}${isLast ? '   ' : '│  '}`)
      }),
    ]
  }

  return KINDS.map(({ kind, title }) => ({
    kind,
    title,
    rows: openFirst(roots.filter(i => i.kind === kind)).flatMap(i => walk(i, 0, '', '')),
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
    for (const { item: i, depth } of rows) {
      const pad = '  '.repeat(depth)
      const link = linkOf(i)
      const name = link ? `[${i.title}](${link})` : i.title
      const tag = depth > 0 && i.kind !== kind ? ` [${i.kind}]` : ''
      lines.push(
        `${pad}- [${isOpen(i) ? ' ' : 'x'}] ${i.id}. ${name}${tag}${i.status === 'obsolete' ? ' (obsolete)' : ''}${i.where ? ` (\`${i.where}\`)` : ''}`,
      )
      if (i.detail) {
        lines.push(`${pad}  - ${i.detail}`)
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
  const open = (await read($, items)).filter(isOpen).length
  $.ui.status(open > 0 ? `ledger: ${open} open` : undefined)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ledger',
      description:
        'Log, resolve or retire numbered items (decisions, bugs, gaps, smells) in the ledger side panel the person is watching, nest them under one another, and write the briefing of an export. Actions: add, resolve, obsolete, reopen, move, list, brief.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'resolve', 'obsolete', 'reopen', 'move', 'list', 'brief'] },
          kind: { type: 'string', enum: ['decision', 'bug', 'gap', 'smell'] },
          title: { type: 'string', description: 'Short one-line title (add).' },
          detail: { type: 'string', description: 'Context or, for a decision, the options (add).' },
          where: { type: 'string', description: 'file:line the item concerns (add).' },
          url: { type: 'string', description: 'Link to the issue or page the item tracks (add).' },
          parent: { type: 'integer', description: 'Item number to nest under (add, move); 0 makes it top-level (move).' },
          id: { type: 'integer', description: 'Item number (resolve, obsolete, reopen, move).' },
          outcome: { type: 'string', description: 'What was decided or done, or why obsolete.' },
          path: { type: 'string', description: 'The export file the briefing belongs to (brief).' },
          briefing: { type: 'string', description: 'The session briefing, in Markdown (brief).' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'ledger', description: 'Open the ledger panel' })
    await $.command.register({
      name: 'ledger-export',
      description: 'Export the ledger, with a session briefing, to JSON and Markdown',
      argumentHint: '[dir or file.json]',
    })
    await $.command.register({
      name: 'ledger-import',
      description: "Load an exported or another session's ledger into this session",
      argumentHint: '[file.json | list] [--replace]',
    })
    void $.ui.open({ id: PANE, title: 'Ledger' })
    // A reload into a live session: save a ledger the store has not seen yet.
    void (async () => {
      if ((await $.store.get(`session:${await $.session.id()}`)) === undefined) {
        await save($)
      }
    })().catch(() => undefined)

    return next(e)
  })

  // /clear and /new empty the session's state: keep the ledger as it ends.
  on('session.end', async ($, e, next) => {
    await save($, e.sessionId)

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'ledger' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Ledger' })

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
    const arg = words.filter(w => w !== '--replace').join(' ')

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
    if (current.length > 0 && !replace) {
      return {
        text: `This session's ledger already has ${current.length} items. Run /ledger-import ${arg ? `${arg} ` : ''}--replace to replace them with the ${incoming.length} items of ${label}.`,
      }
    }
    await update($, items, () => incoming)
    await save($)
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Ledger' })

    return {
      text: `Imported ${incoming.length} ledger items from ${label}.`,
      context: [
        `The ledger was imported from ${label} (session ${data.sessionId}${data.branch ? `, branch ${data.branch}` : ''}, ${data.exportedAt}). Item numbers are those of that session.${data.briefing ? `\n\nBriefing from that session:\n\n${data.briefing}` : ''}`,
      ],
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

    const status = { resolve: 'resolved', obsolete: 'obsolete', reopen: 'open' }[input.action] as LedgerStatus
    await update($, items, (current: LedgerItem[]) =>
      current.map(i => (i.id === target.id ? { ...i, status, outcome: input.outcome ?? i.outcome } : i)),
    )
    await save($)
    await refresh($)
    const stillOpen = status === 'open' ? [] : descendants(target.id, list).filter(isOpen)

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
          `Ledger ${i.id} (${i.status}): ${i.title}${i.detail ? ` | ${i.detail}` : ''}${i.where ? ` | ${i.where}` : ''}${i.url ? ` | ${i.url}` : ''}`,
      )

    return next(notes.length ? { ...e, text: `${text}\n\n${notes.join('\n')}` } : e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Link, Text } = $.ui.resolve(e)
    const list: LedgerItem[] = await read($, items)

    if (list.length === 0) {
      return <Text dimColor>Ledger is empty.</Text>
    }

    return (
      <Box flexDirection="column">
        {sections(list).map(({ kind, title, rows }) => (
          <Box flexDirection="column">
            <Text bold>{title}</Text>
            {rows.map(({ item: i, depth, guide }) => {
              const link = linkOf(i)

              // One line per item, cut to the pane. Hovering it opens the whole item right
              // beneath, pushing the rows below down. Only the number is a link, so the
              // title stays plain text the pointer can hover.
              return (
                <Box key={`item-${i.id}`} flexDirection="column">
                  <Text dimColor={!isOpen(i)} wrap="truncate-end">
                    {guide}
                    {isOpen(i) ? '☐' : i.status === 'resolved' ? '✓' : '–'}{' '}
                    {link ? <Link href={link}>{`${i.id}.`}</Link> : `${i.id}.`} {i.title}
                    {depth > 0 && i.kind !== kind ? ` [${i.kind}]` : ''}
                    {i.status === 'obsolete' ? ' (obsolete)' : ''}
                    {i.outcome && !isOpen(i) ? ` → ${i.outcome}` : ''}
                  </Text>
                  <Box display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round">
                    <Text bold>
                      {i.id}. {i.title}
                    </Text>
                    <Text dimColor>
                      {i.kind}, {i.status}
                      {i.parent ? `, under ${i.parent}` : ''}
                    </Text>
                    {i.where ? <Text>{i.where}</Text> : null}
                    {i.detail ? <Text>{i.detail}</Text> : null}
                    {link ? <Link href={link}>{link}</Link> : null}
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
