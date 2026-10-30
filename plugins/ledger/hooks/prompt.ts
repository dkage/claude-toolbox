import type { LedgerItem } from '../types'
import { TOOL, describe, isOpen, stamp, when } from './model'

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

const OPEN_SHOWN = 40

/** The system prompt section: how to use the ledger, and the open items now. */
export function rulesWith(list: LedgerItem[]): string {
  const shown = list.filter(isOpen).slice(-OPEN_SHOWN).map(describe)

  return `${RULES}\n\nOpen ledger items now:\n${shown.length ? shown.join('\n') : '(none)'}`
}

/** The item numbers a prompt refers to, as "13 (ledger)" or "L13". */
export function referencedIds(text: string): Set<number> {
  const ids = new Set<number>()
  for (const m of text.matchAll(/\b(\d+)\s*\(ledger\)|\bL(\d+)\b/gi)) {
    ids.add(Number(m[1] ?? m[2]))
  }

  return ids
}

/** An item spelled out for a prompt that refers to it, its notes beneath. */
export function spelledOut(i: LedgerItem): string {
  const head = [
    `Ledger ${i.id} (${i.status}): ${i.title}`,
    when(i.detail, ` | ${i.detail}`),
    when(i.where, ` | ${i.where}`),
    when(i.url, ` | ${i.url}`),
  ]
  const notes = (i.notes ?? []).map(n => `\n  ${stamp(n.at)}: ${n.text}`)

  return head.join('') + notes.join('')
}
