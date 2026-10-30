import type { EngineInterface } from 'claude-code'

import type { LedgerItem, LedgerOrigin } from '../types'
import { FORMAT, TOOL, background, trimEnd } from './model'
import { readItems } from './state'
import { absolute, ledgersDir, mdPathOf, originOf, slug, writeExport } from './storage'

/** Where an export goes: the project's ledgers folder, a folder given, or a .json file given. */
async function exportPath($: EngineInterface, arg: string, origin: LedgerOrigin, exportedAt: string) {
  const name = `${exportedAt.slice(0, 16).replace(/[:T]/g, '-')}-${slug(origin.branch ?? 'no-branch')}.json`
  if (!arg) {
    return `${await ledgersDir($, origin.project)}/${name}`
  }
  const path = await absolute($, arg)

  return path.endsWith('.json') ? path : `${trimEnd(path, '/')}/${name}`
}

const briefingAsk = (path: string) =>
  `The ledger was exported to ${path}. Write a briefing for the next session that will import it: the goal of this session, where the work stopped, what is in progress, the next steps, and pointers (branch, files, commands, issues). Keep it short Markdown and do not repeat the ledger items. Then call the ${TOOL} tool with action "brief", path "${path}" and the briefing.`

/** /ledger-export: writes the ledger as JSON and Markdown, then asks Claude for the briefing. */
export async function exportLedger($: EngineInterface, args: string) {
  const list: LedgerItem[] = await readItems($)
  if (list.length === 0) {
    return { text: 'The ledger is empty: nothing to export.' }
  }
  const origin = await originOf($)
  const exportedAt = new Date().toISOString()
  const path = await exportPath($, args.trim(), origin, exportedAt)
  try {
    await writeExport($, path, { format: FORMAT, ...origin, exportedAt, briefing: null, items: list })
  } catch (error) {
    return { text: `Could not write the export to ${path}: ${String(error)}` }
  }
  // Submitting from the command's own hook would wait on the turn it holds.
  $.clock.after(1, () => background($.prompt.submit({ text: briefingAsk(path) })))

  return {
    text: `Ledger exported (${list.length} items) to ${path} and ${mdPathOf(path)}. Asking Claude for the session briefing.`,
  }
}
