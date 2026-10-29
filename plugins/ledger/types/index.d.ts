export type LedgerKind = 'decision' | 'bug' | 'gap' | 'smell'
export type LedgerStatus = 'open' | 'in-progress' | 'resolved' | 'obsolete'

/** A dated line of progress on an item. */
export type LedgerNote = { at: string; text: string }

export type LedgerItem = {
  id: number
  kind: LedgerKind
  title: string
  detail?: string
  where?: string
  url?: string
  parent?: number
  status: LedgerStatus
  outcome?: string
  notes?: LedgerNote[]
}

/** Where a ledger came from: kept with every export and every auto-save. */
export type LedgerOrigin = {
  sessionId: string
  project: string
  root: string
  branch: string | null
}

/** The file /ledger-export writes and /ledger-import reads. */
export type LedgerExport = LedgerOrigin & {
  format: 'ledger/1'
  exportedAt: string
  briefing: string | null
  items: LedgerItem[]
}

/** One session's ledger as auto-saved to $.store, under `session:<id>`. */
export type LedgerSave = LedgerOrigin & {
  updatedAt: string
  items: LedgerItem[]
}

declare module 'claude-code' {
  interface PluginState {
    ledger: { items: LedgerItem[]; folded: number[]; hideDone: boolean; offeredFor: string }
  }
}
