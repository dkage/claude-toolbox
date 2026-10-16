export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': { limits: Limit[]; context: number | null; model: string }
  }
}
