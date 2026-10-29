import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const TOOL = 'mcp__ledger__ledger'

const PANE = {
  plugin: 'ledger',
  component: 'Pane',
  requestId: 'ledger',
  props: {
    title: 'Ledger',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type On = Parameters<TestBody>[1]

/** Stands for the engine: a session in /work, a store and a file system in memory. */
function engine(on: On, session = 'S1') {
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const prompts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ledger__${e.name}` } }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('ui.status', () => ({ value: {} }) as never)
  on('ui.log', () => ({ value: {} }) as never)
  on('session.id', () => ({ value: session }) as never)
  on('session.root', () => ({ value: '/work/demo' }) as never)
  on('session.cwd', () => ({ value: '/work/demo' }) as never)
  on('env.get', () => ({ value: '/home/me' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'feat/x\n', stderr: '' } }) as never)
  on('store.get', (_$, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))

    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => (store.delete((e as { key: string }).key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('fs.write', (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    files.set(path, text)

    return { value: undefined } as never
  })
  on('fs.read', (_$, e) => {
    const text = files.get((e as { path: string }).path)
    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: text } as never
  })
  on('fs.exists', (_$, e) => {
    const path = (e as { path: string }).path

    return { value: [...files.keys()].some(f => f.startsWith(path)) } as never
  })
  on('fs.list', (_$, e) => {
    const dir = (e as { path: string }).path

    return {
      value: [...files.keys()]
        .filter(f => f.startsWith(`${dir}/`))
        .map(f => ({ name: f.slice(dir.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
    } as never
  })
  on('prompt.submit', (_$, e) => {
    prompts.push((e as { text: string }).text)

    return { drop: 'captured by the test' } as never
  })

  return { files, store, prompts }
}

const run = (command: string, args = '') =>
  ({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  }) as never

test('numbers items, resolves one, and keeps numbers stable', async ($, on) => {
  engine(on)
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

test('children sit under their parent, done ones at the bottom of that subtree', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Initiative' })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Epic A', parent: 1 })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Issue done', parent: 2 })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'Issue open', parent: 2 })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Loose' })
  await $.tool.call({ tool: TOOL, action: 'resolve', id: 3, outcome: 'shipped' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = []
    for (const title of ['Initiative', 'Epic A', 'Issue open', 'Issue done', 'Loose']) {
      rows.push((await ui.find({ type: 'Text', text: new RegExp(title) }))?.text)
    }
    expect(rows).toEqual([
      '☐ 1. Initiative',
      '└─ ☐ 2. Epic A',
      '   ├─ ☐ 4. Issue open [bug]',
      '   └─ ✓ 3. Issue done → shipped',
      '☐ 5. Loose',
    ])
    await ui.unmount()
  }
})

test('an item never moves under itself or its children', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Parent' })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Child', parent: 1 })

  const loop = await $.tool.call({ tool: TOOL, action: 'move', id: 1, parent: 2 })
  expect(String(loop.deny)).toContain('cannot sit under itself')
  const free = await $.tool.call({ tool: TOOL, action: 'move', id: 2, parent: 0 })
  expect(String(free.result)).toContain('2 (ledger) is now top-level')
})

test('resolving a parent with open children warns', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Epic' })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Issue', parent: 1 })

  const done = await $.tool.call({ tool: TOOL, action: 'resolve', id: 1 })
  expect(String(done.result)).toContain('still has open children: 2')
})

test('an item links its url, else the first URL in its detail', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'With url', url: 'https://example.com/1' })
  await $.tool.call({
    tool: TOOL,
    action: 'add',
    kind: 'gap',
    title: 'From detail',
    detail: 'https://example.com/2 | Status: open.',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Link', text: /With url/ }))?.props.href).toBe('https://example.com/1')
  expect((await ui.find({ type: 'Link', text: /From detail/ }))?.props.href).toBe('https://example.com/2')
  await ui.unmount()
})

test('every change is auto-saved under the session id', async ($, on) => {
  const { store } = engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'kept' })

  const saved = store.get('session:S1') as { branch: string; items: { title: string }[] }
  expect(saved.branch).toBe('feat/x')
  expect(saved.items.map(i => i.title)).toEqual(['kept'])
})

test('export writes JSON and Markdown, then asks for the briefing', async ($, on) => {
  const { files, prompts } = engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Epic', url: 'https://example.com/e' })

  const out = await $.command.run(run('ledger-export', 'exports/'))
  expect(String(out.text)).toContain('Ledger exported (1 items)')
  expect(prompts).toEqual([])
  await clock.advance(1)
  const json = [...files.keys()].find(f => f.endsWith('.json')) as string
  expect(json.startsWith('/work/demo/exports/')).toBe(true)
  expect(json.endsWith('-feat-x.json')).toBe(true)
  expect(files.get(json.replace(/json$/, 'md'))).toContain('- [ ] 1. [Epic](https://example.com/e)')
  expect(prompts[0]).toContain(`path "${json}"`)

  const brief = await $.tool.call({ tool: TOOL, action: 'brief', path: json, briefing: 'Stopped at step 2.' })
  expect(String(brief.result)).toContain('Briefing saved')
  expect(JSON.parse(files.get(json) as string).briefing).toBe('Stopped at step 2.')
  expect(files.get(json.replace(/json$/, 'md'))).toContain('Stopped at step 2.')
})

test('brief refuses a file that is not a ledger export', async ($, on) => {
  const { files } = engine(on)
  files.set('/work/demo/other.json', '{"name":"x"}')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const brief = await $.tool.call({ tool: TOOL, action: 'brief', path: '/work/demo/other.json', briefing: 'x' })
  expect(String(brief.deny)).toContain('not a ledger export')
  expect(files.get('/work/demo/other.json')).toBe('{"name":"x"}')
})

test('import keeps the numbers and hands over the briefing', async ($, on) => {
  const { files } = engine(on)
  files.set(
    '/work/demo/l.json',
    JSON.stringify({
      format: 'ledger/1',
      sessionId: 'OLD',
      project: 'demo',
      root: '/work/demo',
      branch: 'main',
      exportedAt: '2026-01-01T00:00:00Z',
      briefing: 'Next: write the tests.',
      items: [
        { id: 7, kind: 'gap', title: 'Epic', status: 'open' },
        { id: 9, kind: 'bug', title: 'Issue', status: 'resolved', parent: 7 },
      ],
    }),
  )
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const out = await $.command.run(run('ledger-import', 'l.json'))
  expect(String(out.text)).toContain('Imported 2 ledger items')
  expect(String(out.context?.[0])).toContain('Next: write the tests.')
  const next = await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'New' })
  expect(String(next.result)).toContain('10 (ledger)')
})

test('import asks before replacing a ledger that has items', async ($, on) => {
  const { store } = engine(on)
  store.set('session:OLD', {
    sessionId: 'OLD',
    project: 'demo',
    root: '/work/demo',
    branch: 'main',
    updatedAt: '2026-01-01T00:00:00Z',
    items: [{ id: 3, kind: 'gap', title: 'Saved', status: 'open' }],
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'Mine' })

  const asked = await $.command.run(run('ledger-import'))
  expect(String(asked.text)).toContain('--replace')
  const replaced = await $.command.run(run('ledger-import', '--replace'))
  expect(String(replaced.text)).toContain('Imported 1 ledger items from auto-save of session OLD')
  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toBe('3 [gap] Saved')
})
