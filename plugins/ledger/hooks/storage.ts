import type { EngineInterface } from 'claude-code'

import type { LedgerExport, LedgerItem, LedgerOrigin, LedgerSave } from '../types'
import { markdown } from './markdown'
import { FORMAT, isOpen, trimEnd, trimStart, when } from './model'
import { readItems } from './state'

const SAVES_KEPT = 30

export const mdPathOf = (json: string) => json.replace(/\.json$/, '') + '.md'

export const slug = (s: string) => trimEnd(trimStart(s.replace(/[^\w.-]+/g, '-'), '-'), '-') || 'ledger'

const isExport = (v: unknown): v is LedgerExport =>
  !!v && typeof v === 'object' && (v as LedgerExport).format === FORMAT && Array.isArray((v as LedgerExport).items)

async function home($: EngineInterface) {
  return (await $.env.get('HOME')) ?? '~'
}

export async function writeExport($: EngineInterface, path: string, data: LedgerExport) {
  await $.fs.write(path, `${JSON.stringify(data, null, 2)}\n`)
  await $.fs.write(mdPathOf(path), markdown(data))
}

export async function loadExport($: EngineInterface, path: string): Promise<LedgerExport> {
  const data: unknown = JSON.parse(String(await $.fs.read(path)))
  if (!isExport(data)) {
    throw new Error(`${path} is not a ledger export (${FORMAT}).`)
  }

  return data
}

async function branchOf($: EngineInterface, root: string): Promise<string | null> {
  try {
    const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })

    return git.exitCode === 0 ? git.stdout.trim() || null : null
  } catch {
    return null
  }
}

export async function originOf($: EngineInterface): Promise<LedgerOrigin> {
  const [sessionId, root] = await Promise.all([$.session.id(), $.session.root()])

  return {
    sessionId,
    project: root.split('/').filter(Boolean).pop() ?? 'ledger',
    root,
    branch: await branchOf($, root),
  }
}

export async function ledgersDir($: EngineInterface, project: string) {
  return `${await home($)}/.claude/ledgers/${slug(project)}`
}

/** A path as typed: "~/" is the home folder, and a relative one starts at the session's folder. */
export async function absolute($: EngineInterface, path: string) {
  if (path.startsWith('~/')) {
    return (await home($)) + path.slice(1)
  }

  return path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
}

/** Every auto-saved ledger, newest first. */
export async function storedSaves($: EngineInterface): Promise<LedgerSave[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('session:'))
  const saves = await Promise.all(keys.map(k => $.store.get(k)))

  return (saves.filter(s => s && typeof s === 'object') as LedgerSave[]).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )
}

/**
 * Mirrors the session's ledger to the store, so a restart or /clear can bring
 * it back. `sessionId` names the session it belongs to when the engine may
 * already answer the next one's (at session.end).
 */
export async function save($: EngineInterface, sessionId?: string) {
  try {
    const origin = { ...(await originOf($)), ...(sessionId ? { sessionId } : {}) }
    const list: LedgerItem[] = await readItems($)
    if (list.length === 0) {
      return
    }
    const entry: LedgerSave = { ...origin, updatedAt: new Date().toISOString(), items: list }
    await $.store.set(`session:${origin.sessionId}`, entry)
    for (const old of (await storedSaves($)).slice(SAVES_KEPT)) {
      await $.store.delete(`session:${old.sessionId}`)
    }
  } catch (error) {
    $.ui.log(`ledger: auto-save failed: ${String(error)}`, { to: 'debug' })
  }
}

/** After a reload into a live session: saves a ledger the store has not seen yet. */
export async function saveIfNew($: EngineInterface) {
  if ((await $.store.get(`session:${await $.session.id()}`)) === undefined) {
    await save($)
  }
}

/** Shows the open count in the status line. */
export async function refresh($: EngineInterface) {
  const list: LedgerItem[] = await readItems($)
  const open = list.filter(isOpen).length
  const active = list.filter(i => i.status === 'in-progress').length
  $.ui.status(open > 0 ? `ledger: ${open} open` + when(active, `, ${active} in progress`) : undefined)
}

/** After every change: the auto-save and the status line. */
export async function persist($: EngineInterface) {
  await save($)
  await refresh($)
}

export type Source = { label: string; at: string; load: () => Promise<LedgerExport> }

function savedSource(s: LedgerSave): Source {
  return {
    label: `auto-save of session ${s.sessionId}` + when(s.branch, ` (${s.branch})`) + `, ${s.items.length} items`,
    at: s.updatedAt,
    load: async () => ({ ...s, format: FORMAT, exportedAt: s.updatedAt, briefing: null }),
  }
}

async function exportedSources($: EngineInterface, dir: string): Promise<Source[]> {
  const files = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []

  return files
    .filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    .map(f => ({
      label: `${dir}/${f.name}`,
      at: new Date(f.mtimeMs).toISOString(),
      load: () => loadExport($, `${dir}/${f.name}`),
    }))
}

/** Ledgers this session could import, newest first: other sessions' auto-saves of this project, and its exports. */
export async function sources($: EngineInterface): Promise<Source[]> {
  const origin = await originOf($)
  const saved = (await storedSaves($))
    .filter(s => s.root === origin.root && s.sessionId !== origin.sessionId && s.items.length > 0)
    .map(savedSource)
  const exported = await exportedSources($, await ledgersDir($, origin.project))

  return [...saved, ...exported].sort((a, b) => b.at.localeCompare(a.at))
}
