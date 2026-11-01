import type { EngineInterface } from 'claude-code'

import type { LedgerItem } from '../types'
import { GITHUB, linkOf } from './model'

export const ISSUE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/

/** An issue as the ledger needs it; `subs` is how many sub-issues GitHub says it has. */
export type Issue = { number: number; title: string; state: string; url: string; subs: number; parentUrl?: string }

/** The page URL of an API issue URL, as https://api.github.com/repos/<owner>/<repo>/issues/<n>. */
const pageOf = (apiUrl?: string) => apiUrl?.replace(/^https:\/\/api\.github\.com\/repos\//, 'https://github.com/')

export function issueOf(raw: unknown): Issue {
  const i = raw as {
    number: number
    title: string
    state: string
    html_url: string
    sub_issues_summary?: { total?: number }
    parent_issue_url?: string | null
  }

  return {
    number: i.number,
    title: i.title,
    state: String(i.state).toLowerCase(),
    url: i.html_url,
    subs: i.sub_issues_summary?.total ?? 0,
    parentUrl: pageOf(i.parent_issue_url ?? undefined),
  }
}

/** A GitHub REST call through gh; a failure throws its first line of stderr. */
export async function ghApi($: EngineInterface, path: string): Promise<unknown> {
  const gh = await $.process.run(['gh', 'api', path], { timeoutMs: 15000 })
  if (gh.exitCode !== 0) {
    throw new Error(gh.stderr.trim().split('\n')[0] || 'gh exited ' + gh.exitCode)
  }

  return JSON.parse(gh.stdout)
}

/** Item numbers by the GitHub issue or pull request they link. */
export function numbersByLink(list: LedgerItem[]): Map<string, number> {
  return new Map(
    list.flatMap(i => {
      const match = linkOf(i)?.match(GITHUB)

      return match ? [[match[0], i.id] as const] : []
    }),
  )
}

/** The repository the ledger's issue links point to, when they all point to one. */
function repoOf(list: LedgerItem[]): string | undefined {
  const repos = new Set(list.flatMap(i => i.url?.match(ISSUE)?.[1] ?? []))

  return repos.size === 1 ? [...repos][0] : undefined
}

/** The issue a new item names: its URL, or "#N" in its title read in the ledger's one repository. */
function namedIssue(title: string, url: string | undefined, list: LedgerItem[]): RegExpMatchArray | undefined {
  if (url) {
    return url.match(ISSUE) ?? undefined
  }
  const number = title.match(/#(\d+)\b/)?.[1]
  const repo = repoOf(list)

  return number && repo ? `https://github.com/${repo}/issues/${number}`.match(ISSUE) ?? undefined : undefined
}

/** What GitHub says about a new item's issue: its page, and the item of its parent issue. */
export type Found = { url: string; parent?: number }

/**
 * The GitHub issue a new item tracks, by its URL or by "#N" in its title, with the
 * ledger item of the issue it is a sub-issue of; nothing unless GitHub confirms it.
 */
export async function issueFound(
  $: EngineInterface,
  title: string,
  url: string | undefined,
  list: LedgerItem[],
): Promise<Found | undefined> {
  const match = namedIssue(title, url, list)
  if (!match) {
    return undefined
  }
  try {
    const issue = issueOf(await ghApi($, `repos/${match[1]}/issues/${match[2]}`))

    return { url: issue.url, parent: issue.parentUrl ? numbersByLink(list).get(issue.parentUrl) : undefined }
  } catch {
    return undefined
  }
}
