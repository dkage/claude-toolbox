import type { EngineInterface } from 'claude-code'

import type { LedgerExport, LedgerItem } from '../types'
import { PANE, background, errorText, renumber, sanitize, when } from './model'
import { readItems, updateItems, readOfferedFor, setOfferedFor } from './state'
import { absolute, loadExport, persist, sources } from './storage'

type Mode = { replace: boolean; merge: boolean; arg: string }

type Found = { label: string; data: LedgerExport } | { text: string }

function modeOf(args: string): Mode {
  const words = args.trim().split(/\s+/).filter(Boolean)

  return {
    replace: words.includes('--replace'),
    merge: words.includes('--merge'),
    arg: words.filter(w => w !== '--replace' && w !== '--merge').join(' '),
  }
}

async function listSources($: EngineInterface) {
  const found = await sources($)
  if (found.length === 0) {
    return 'No ledgers found for this project.'
  }

  const lines = found.map(s => `- ${s.at.slice(0, 16)}: ${s.label}`)

  return `Ledgers for this project, newest first:\n${lines.join('\n')}`
}

/** The export a path names, or the newest ledger of the project; "list" lists them instead. */
async function find($: EngineInterface, arg: string): Promise<Found> {
  try {
    if (arg === 'list') {
      return { text: await listSources($) }
    }
    if (arg) {
      const label = await absolute($, arg)

      return { label, data: await loadExport($, label) }
    }
    const [latest] = await sources($)

    return latest
      ? { label: latest.label, data: await latest.load() }
      : { text: 'No ledgers found for this project. Give a path: /ledger-import <file.json>.' }
  } catch (error) {
    return { text: `Could not import: ${errorText(error)}` }
  }
}

/** What Claude is told about the import, with the briefing of the session it came from. */
function contextOf(label: string, data: LedgerExport, merged: boolean) {
  const numbers = merged
    ? 'Its items were renumbered after the ones already here, so numbers in the briefing below are that session’s, not this ledger’s.'
    : 'Item numbers are those of that session.'
  const from = `session ${data.sessionId}` + when(data.branch, `, branch ${data.branch}`) + `, ${data.exportedAt}`

  return `The ledger was imported from ${label} (${from}). ${numbers}` + when(data.briefing, `\n\nBriefing from that session:\n\n${data.briefing}`)
}

/** /ledger-import: loads an export or an auto-save, replacing an empty ledger or, when asked, a full one. */
export async function importLedger($: EngineInterface, args: string) {
  const mode = modeOf(args)
  const found = await find($, mode.arg)
  if ('text' in found) {
    return found
  }
  const { label, data } = found
  const incoming = sanitize(data.items)
  if (incoming.length === 0) {
    return { text: `${label} has no ledger items to import.` }
  }
  const current: LedgerItem[] = await readItems($)
  if (current.length > 0 && !mode.replace && !mode.merge) {
    const again = '/ledger-import ' + when(mode.arg, `${mode.arg} `)

    return {
      text: `This session's ledger already has ${current.length} items. Run ${again}--replace to replace them with the ${incoming.length} items of ${label}, or ${again}--merge to add them after the current ones, renumbered.`,
    }
  }
  const merged = mode.merge && current.length > 0
  await updateItems($, (now: LedgerItem[]) => (merged ? [...now, ...renumber(incoming, now)] : incoming))
  await persist($)
  background($.ui.open({ id: PANE, title: 'Ledger' }))

  return {
    text: `Imported ${incoming.length} ledger items from ${label}` + when(merged, ', renumbered after the current ones') + '.',
    context: [contextOf(label, data, merged)],
  }
}

/**
 * On an empty ledger, once per session: point at the newest ledger of this
 * project and put /ledger-import in an empty prompt. Nothing loads by itself.
 */
export async function offer($: EngineInterface) {
  try {
    const sessionId = await $.session.id()
    if ((await readItems($)).length > 0 || (await readOfferedFor($)) === sessionId) {
      return
    }
    const [latest] = await sources($)
    if (!latest) {
      return
    }
    await setOfferedFor($, sessionId)
    $.ui.toast(`Ledger available: ${latest.label}. Run /ledger-import to load it.`)
    if ((await $.prompt.read()).text === '') {
      await $.prompt.fill({ text: '/ledger-import' })
    }
  } catch (error) {
    $.ui.log(`ledger: offer failed: ${String(error)}`, { to: 'debug' })
  }
}
