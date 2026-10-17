import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__ledger__ledger'

test('numbers items, resolves one, and keeps numbers stable', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ledger__${e.name}` } }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: {} }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const a = await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'first' })
  const b = await $.tool.call({ tool: TOOL, action: 'add', kind: 'decision', title: 'second' })
  expect(String(a.result)).toContain('1 (ledger)')
  expect(String(b.result)).toContain('2 (ledger)')

  await $.tool.call({ tool: TOOL, action: 'obsolete', id: 1, outcome: 'method removed' })
  const c = await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'third' })
  expect(String(c.result)).toContain('3 (ledger)')

  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toContain('2 [decision] second')
  expect(String(list.result)).not.toContain('first')
})
