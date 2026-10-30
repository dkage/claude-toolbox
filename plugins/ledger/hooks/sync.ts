import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'
import { GITHUB, errorText, isOpen, linkOf, when } from './model'
import { readItems, updateItems } from './state'
import { persist } from './storage'

/** An item linking a GitHub issue or pull request. */
type Tracked = { item: LedgerItem; url: string; what: 'issue' | 'pr' }

/** A link's state on GitHub, lower case: open, closed or merged. */
type Found = { state: string; what: Tracked['what'] }

const isClosed = (state = '') => state === 'closed' || state === 'merged'

function trackedIn(list: LedgerItem[]): Tracked[] {
  return list.flatMap(item => {
    const match = linkOf(item)?.match(GITHUB)

    return match ? [{ item, url: match[0], what: match[1] === 'pull' ? ('pr' as const) : ('issue' as const) }] : []
  })
}

/** Asks gh for each link's state; links it cannot check go to `failed`, with the reason. */
async function fetchStates($: EngineInterface, tracked: Tracked[]) {
  const states = new Map<number, Found>()
  const failed: string[] = []
  for (const { item, url, what } of tracked) {
    try {
      const gh = await $.process.run(['gh', what, 'view', url, '--json', 'state'], { timeoutMs: 15000 })
      if (gh.exitCode === 0) {
        states.set(item.id, { state: String(JSON.parse(gh.stdout).state).toLowerCase(), what })
      } else {
        const reason = gh.stderr.trim().split('\n')[0] || 'gh exited ' + gh.exitCode
        failed.push(`${item.id} (${reason})`)
      }
    } catch (error) {
      failed.push(`${item.id} (${errorText(error)})`)
    }
  }

  return { states, failed }
}

/** The item with its GitHub state, resolved with a dated note when the link closed while it was open. */
function synced(i: LedgerItem, found: Found | undefined, at: string): LedgerItem {
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
    status: 'resolved',
    outcome: i.outcome ?? `The ${kind} is ${found.state} on GitHub.`,
    notes: [...(i.notes ?? []), { at, text: `Resolved by /ledger-sync: the ${kind} is ${found.state}.` }],
  }
}

const ids = (list: LedgerItem[]) => list.map(i => i.id).join(', ')

/** /ledger-sync: resolves items whose GitHub issue or pull request closed, and reports the rest. */
export async function syncLedger($: EngineInterface) {
  const list: LedgerItem[] = await readItems($)
  const tracked = trackedIn(list)
  if (tracked.length === 0) {
    return { text: 'No ledger items link a GitHub issue or pull request.' }
  }
  const { states, failed } = await fetchStates($, tracked)
  const closing = list.filter(i => isOpen(i) && isClosed(states.get(i.id)?.state))
  const stale = list.filter(i => !isOpen(i) && states.get(i.id)?.state === 'open')
  const at = new Date().toISOString()
  await updateItems($, (current: LedgerItem[]) => current.map(i => synced(i, states.get(i.id), at)))
  await persist($)
  const report = [
    `Checked ${states.size} of ${tracked.length} GitHub links.`,
    closing.length ? `Resolved, closed on GitHub: ${ids(closing)}.` : 'Nothing to resolve.',
    when(stale.length, `Finished here but open on GitHub: ${ids(stale)}.`),
    when(failed.length, `Could not check: ${failed.join('; ')}.`),
  ]

  return { text: report.filter(Boolean).join('\n') }
}
