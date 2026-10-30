import type { LedgerItem, LedgerKind } from '../types'
import { KINDS, isOpen, openFirst, parentOf } from './model'

/**
 * A drawn item: its depth and tree guide, its children's progress (finished of
 * all, obsolete ones left out), and how many items beneath it a fold hides.
 */
export type Row = {
  item: LedgerItem
  depth: number
  guide: string
  kids: number
  progress?: { done: number; total: number }
  hidden: number
}

/** What the pane leaves out: folded parents' subtrees, and finished items when asked. */
export type View = { folded?: readonly number[]; hideDone?: boolean }

export type Section = { kind: LedgerKind; title: string; rows: Row[] }

/** The ledger as a tree: each item's children, and the items with no parent. */
class Tree {
  readonly roots: LedgerItem[] = []
  private readonly children = new Map<number, LedgerItem[]>()

  constructor(
    list: LedgerItem[],
    private readonly view: View,
  ) {
    const byId = new Map(list.map(i => [i.id, i]))
    for (const i of list) {
      const parent = parentOf(i, byId)
      if (parent) {
        this.children.set(parent.id, [...this.kidsOf(parent.id), i])
      } else {
        this.roots.push(i)
      }
    }
  }

  kidsOf(id: number): LedgerItem[] {
    return this.children.get(id) ?? []
  }

  below(id: number): LedgerItem[] {
    return this.kidsOf(id).flatMap(kid => [kid, ...this.below(kid.id)])
  }

  /** A finished item stays while anything beneath it is unfinished. */
  isShown(i: LedgerItem): boolean {
    return !this.view.hideDone || isOpen(i) || this.below(i.id).some(isOpen)
  }

  /** The item's row, then its shown children's, each under its guide. */
  walk(item: LedgerItem, depth: number, guide: string, lead: string): Row[] {
    const all = this.kidsOf(item.id)
    const isFolded = this.view.folded?.includes(item.id) ?? false
    const kids = isFolded ? [] : openFirst(all.filter(k => this.isShown(k)))
    const row: Row = {
      item,
      depth,
      guide,
      kids: all.length,
      progress: progressOf(all),
      hidden: isFolded ? this.below(item.id).length : 0,
    }

    return [
      row,
      ...kids.flatMap((kid, n) => {
        const isLast = n === kids.length - 1

        return this.walk(kid, depth + 1, lead + (isLast ? '└─ ' : '├─ '), lead + (isLast ? '   ' : '│  '))
      }),
    ]
  }
}

function progressOf(kids: LedgerItem[]): Row['progress'] {
  const counted = kids.filter(k => k.status !== 'obsolete')
  if (counted.length === 0) {
    return undefined
  }

  return { done: counted.filter(k => k.status === 'resolved').length, total: counted.length }
}

/**
 * The ledger as drawn: top-level items grouped by kind, each followed by its
 * children (whatever their kind), open before closed within every group.
 */
export function sections(list: LedgerItem[], view: View = {}): Section[] {
  const tree = new Tree(list, view)

  return KINDS.map(({ kind, title }) => ({
    kind,
    title,
    rows: openFirst(tree.roots.filter(i => i.kind === kind && tree.isShown(i))).flatMap(i => tree.walk(i, 0, '', '')),
  })).filter(s => s.rows.length > 0)
}
