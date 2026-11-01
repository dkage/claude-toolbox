import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'
import { ISSUE, type Issue, ghApi, issueOf, numbersByLink } from './github'
import { PANE, background, errorText, topId, when } from './model'
import { readItems, updateItems } from './state'
import { persist } from './storage'

/** A pull stops adding issues past this many, so a huge tree cannot flood the ledger. */
const MAX_PULLED = 200

/** A pulled issue and the issue it is a sub-issue of, by URL. */
type Node = { issue: Issue; parentUrl?: string }

type Fetched = { nodes: Node[]; failed: string[]; isCapped: boolean }

/** Adds the sub-issues beneath `issue`, depth first, to `into`. */
async function visit($: EngineInterface, issue: Issue, into: Fetched) {
  const match = issue.url.match(ISSUE)
  if (issue.subs === 0 || !match) {
    return
  }
  let subs: Issue[]
  try {
    subs = ((await ghApi($, `repos/${match[1]}/issues/${match[2]}/sub_issues?per_page=100`)) as unknown[]).map(issueOf)
  } catch (error) {
    into.failed.push(`#${issue.number} (${errorText(error)})`)

    return
  }
  for (const sub of subs) {
    if (into.nodes.length >= MAX_PULLED) {
      into.isCapped = true

      return
    }
    if (!into.nodes.some(n => n.issue.url === sub.url)) {
      into.nodes.push({ issue: sub, parentUrl: issue.url })
      await visit($, sub, into)
    }
  }
}

/** The issue and every sub-issue beneath it, parents before their children. */
async function fetchTree($: EngineInterface, repo: string, number: string): Promise<Fetched> {
  const root = issueOf(await ghApi($, `repos/${repo}/issues/${number}`))
  const fetched: Fetched = { nodes: [{ issue: root }], failed: [], isCapped: false }
  await visit($, root, fetched)

  return fetched
}

/**
 * The pulled issues the ledger lacks, numbered after `current`: each nests under
 * its parent issue's item, the top one under `under`; a closed issue comes resolved.
 */
export function newItems(current: LedgerItem[], nodes: Node[], under?: number): LedgerItem[] {
  const byLink = numbersByLink(current)
  const made: LedgerItem[] = []
  let id = topId(current)
  for (const { issue, parentUrl } of nodes) {
    if (byLink.has(issue.url)) {
      continue
    }
    id += 1
    byLink.set(issue.url, id)
    const isClosed = issue.state === 'closed'
    made.push({
      id,
      kind: 'gap',
      title: `#${issue.number} ${issue.title}`,
      url: issue.url,
      parent: parentUrl ? byLink.get(parentUrl) : under,
      status: isClosed ? 'resolved' : 'open',
      outcome: isClosed ? 'Closed on GitHub.' : undefined,
      github: issue.state,
    })
  }

  return made
}

const USAGE = 'Give a GitHub issue: /ledger-pull https://github.com/<owner>/<repo>/issues/<number> [--under <item>].'

type Args = { url: string; under?: number }

function argsOf(text: string): Args | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const at = words.indexOf('--under')
  const under = at === -1 ? undefined : Number(words[at + 1])
  const rest = at === -1 ? words : words.filter((_, n) => n !== at && n !== at + 1)
  if (rest.length !== 1 || (under !== undefined && !Number.isInteger(under))) {
    return undefined
  }

  return { url: rest[0] as string, under }
}

function report(root: Issue, nodes: Node[], added: LedgerItem[], fetched: Fetched): string {
  const known = nodes.length - added.length
  const lines = [
    `Pulled ${added.length} of ${nodes.length} issues from #${root.number} ${root.title}` +
      when(known, `; ${known} were already in the ledger (/ledger-sync refreshes their state)`) +
      '.',
    when(fetched.isCapped, `Stopped at ${MAX_PULLED} issues; pull a sub-issue to go deeper.`),
    when(fetched.failed.length, `Could not read the sub-issues of: ${fetched.failed.join('; ')}.`),
  ]

  return lines.filter(Boolean).join('\n')
}

/** /ledger-pull: logs a GitHub issue and its sub-issues as a tree, skipping the ones already logged. */
export async function pullLedger($: EngineInterface, text: string) {
  const args = argsOf(text)
  const match = args?.url.match(ISSUE)
  if (!args || !match) {
    return { text: USAGE }
  }
  const list = await readItems($)
  if (args.under !== undefined && !list.some(i => i.id === args.under)) {
    return { text: `No ledger item ${args.under} to nest under.` }
  }
  let fetched: Fetched
  try {
    fetched = await fetchTree($, match[1] as string, match[2] as string)
  } catch (error) {
    return { text: `Could not read ${args.url}: ${errorText(error)}` }
  }
  let added: LedgerItem[] = []
  const root = fetched.nodes[0]?.issue as Issue
  await updateItems($, current => {
    // Without --under, the issue nests under its parent issue's item when that is logged.
    const under = args.under ?? (root.parentUrl ? numbersByLink(current).get(root.parentUrl) : undefined)
    added = newItems(current, fetched.nodes, under)

    return [...current, ...added]
  })
  await persist($)
  background($.ui.open({ id: PANE, title: 'Ledger' }))

  return { text: report(root, fetched.nodes, added, fetched) }
}
