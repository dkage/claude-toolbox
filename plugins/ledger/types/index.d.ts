export type LedgerKind = 'decision' | 'bug' | 'gap' | 'smell'
export type LedgerStatus = 'open' | 'resolved' | 'obsolete'

export type LedgerItem = {
  id: number
  kind: LedgerKind
  title: string
  detail?: string
  where?: string
  status: LedgerStatus
  outcome?: string
}

declare module 'claude-code' {
  interface PluginState {
    ledger: { items: LedgerItem[] }
  }
}
