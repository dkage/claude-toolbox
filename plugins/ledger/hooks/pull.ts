import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'
import { GITHUB, PANE, background, errorText, linkOf, topId, when } from './model'
import { readItems, updateItems } from './state'
import { persist } from './storage'

const ISSUE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/
/** A pull stops adding issues past this many, so a huge tree cannot flood the ledger. */
const MAX_PULLED = 200

/** An issue as the pull needs it; `subs` is how many sub-issues GitHub says it has. */
type Issue = { number: number; title: string; state: string; url: string; subs: number }

/** A pulled issue and the issue it is a sub-issue of, by URL. */
type Node = { issue: Issue; parentUrl?: string }

type Fetched = { nodes: Node[]; failed: string[]; isCapped: boolean }

function issueOf(raw: unknown): Issue {
  const i = raw as {
    number: number
    title: string
    state: string
    html_url: string
    sub_issues_summary?: { total?: number }
  }

  return {
    number: i.number,
    title: i.title,
    state: String(i.state).toLowerCase(),
    url: i.html_url,
    subs: i.sub_issues_summary?.total ?? 0,
  }
}

/** A GitHub REST call through gh; a failure throws its first line of stderr. */
async function ghApi($: EngineInterface, path: string): Promise<unknown> {
  const gh = await $.process.run(['gh', 'api', path], { timeoutMs: 15000 })
  if (gh.exitCode !== 0) {
    throw new Error(gh.stderr.trim().split('\n')[0] || 'gh exited ' + gh.exitCode)
  }

  return JSON.parse(gh.stdout)
}

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

/** Item numbers by the GitHub issue or pull request they link. */
function numbersByLink(list: LedgerItem[]): Map<string, number> {
  return new Map(
    list.flatMap(i => {
      const match = linkOf(i)?.match(GITHUB)

      return match ? [[match[0], i.id] as const] : []
    }),
  )
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
  await updateItems($, current => {
    added = newItems(current, fetched.nodes, args.under)

    return [...current, ...added]
  })
  await persist($)
  background($.ui.open({ id: PANE, title: 'Ledger' }))

  return { text: report(fetched.nodes[0]?.issue as Issue, fetched.nodes, added, fetched) }
}
