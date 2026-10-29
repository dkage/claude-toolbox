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
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
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
    // A parent's guide and fold button sit before its text.
    expect(rows).toEqual([
      ' ☐ 1. Initiative (0/1)',
      ' ☐ 2. Epic A (1/2)',
      '   ├─ ☐ 4. Issue open [bug]',
      '   └─ ✓ 3. Issue done → shipped',
      '☐ 5. Loose',
    ])
    expect((await ui.find({ key: 'fold-2' }))?.props.label).toBe('▾')
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
  expect((await ui.find({ type: 'Link', text: /1\.$/ }))?.props.href).toBe('https://example.com/1')
  expect((await ui.find({ type: 'Link', text: /2\.$/ }))?.props.href).toBe('https://example.com/2')
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

test('a session that ends saves its ledger under its own id', async ($, on) => {
  const { store } = engine(on, 'NEXT')
  on('state.get', () => ({
    value: { value: [{ id: 4, kind: 'gap', title: 'Untouched', status: 'open' }], version: 1 },
  }))

  await $.session.end({ reason: 'clear', sessionId: 'ENDING', resume: {} } as never)

  const saved = store.get('session:ENDING') as { items: { title: string }[] }
  expect(saved.items.map(i => i.title)).toEqual(['Untouched'])
  expect(store.has('session:NEXT')).toBe(false)
})

test('a reload saves a ledger the store has not seen', async ($, on) => {
  const { store } = engine(on)
  const clock = mock.clock(on)
  on('state.get', () => ({
    value: { value: [{ id: 2, kind: 'bug', title: 'From before', status: 'open' }], version: 1 },
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const saved = store.get('session:S1') as { items: { title: string }[] }
  expect(saved.items.map(i => i.title)).toEqual(['From before'])
})

test('an empty ledger is never saved', async ($, on) => {
  const { store } = engine(on)
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: {} } as never)

  expect(store.size).toBe(0)
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

test('a row is cut to one line and its card holds the whole item', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    action: 'add',
    kind: 'gap',
    title: 'A title long enough to be cut',
    detail: 'The whole story.',
    where: 'src/a.ts:3',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ type: 'Text', text: /☐ 1\./ })
    expect(row?.props.wrap).toBe('truncate-end')
    expect((await ui.find({ type: 'Text', text: /The whole story/ }))?.text).toBe('The whole story.')
    expect((await ui.find({ type: 'Text', text: /src\/a\.ts:3/ }))?.text).toBe('src/a.ts:3')
    await ui.unmount()
  }
})

test('only the number is a link, and the card opens in the flow', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Linked', url: 'https://example.com/9' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const link = await ui.find({ type: 'Link', text: /1\.$/ })
  expect(link?.props.href).toBe('https://example.com/9')
  expect((await ui.find({ type: 'Link', text: /Linked/ }))).toBeUndefined()
  const row = await ui.find({ key: 'item-1' })
  const card = row?.children[1] as { props: Record<string, unknown> } | undefined
  expect(card?.props.display).toBe('none')
  expect(card?.props.position).toBeUndefined()
  await ui.unmount()
})

test('a started item is in progress, drawn first and still open', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Waiting' })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Working' })

  const started = await $.tool.call({ tool: TOOL, action: 'start', id: 2 })
  expect(String(started.result)).toContain('2 (ledger) is now in-progress')
  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toContain('2 [gap] (in progress) Working')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = await ui.find({ type: 'Text', text: /^[☐◐]/ })
  expect(first?.text).toBe('◐ 2. Working')
  await ui.unmount()
})

test('edit changes fields and keeps the number; an empty string clears', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'Tpyo', where: 'a.ts:1', detail: 'old' })

  await $.tool.call({ tool: TOOL, action: 'edit', id: 1, title: 'Typo', kind: 'smell', detail: '', url: 'https://example.com/x' })
  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toBe('1 [smell] Typo (a.ts:1)')

  const refused = await $.tool.call({ tool: TOOL, action: 'edit', id: 1, title: '' })
  expect(String(refused.deny)).toContain('needs a title')
})

test('notes are dated, shown in the card and in the context', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Step work' })
  await $.tool.call({ tool: TOOL, action: 'note', id: 1, note: 'Steps 1-4 done' })
  await $.tool.call({ tool: TOOL, action: 'note', id: 1, note: 'Step 5 pending' })

  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toMatch(/last note \d{4}-\d\d-\d\d: Step 5 pending$/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Steps 1-4 done/ }))?.text).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d Steps 1-4 done$/)
  await ui.unmount()
  const empty = await $.tool.call({ tool: TOOL, action: 'note', id: 1 })
  expect(String(empty.deny)).toContain('needs "note"')
})

test('an unknown action is refused and changes nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Safe' })

  const odd = await $.tool.call({ tool: TOOL, action: 'frobnicate', id: 1 })
  expect(String(odd.deny)).toContain('Unknown action')
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toBe('1 [gap] Safe')
})

test('a batch logs a whole tree in one call, or nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'gap', title: 'Existing' })

  const bad = await $.tool.call({
    tool: TOOL,
    action: 'add',
    items: [
      { ref: 'i', kind: 'gap', title: 'Initiative' },
      { kind: 'gap', title: 'Orphan', under: 'nope' },
    ],
  })
  expect(String(bad.deny)).toContain('items[1].under "nope"')
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toBe('1 [gap] Existing')

  const ok = await $.tool.call({
    tool: TOOL,
    action: 'add',
    items: [
      { ref: 'i', kind: 'gap', title: 'Initiative', parent: 1 },
      { ref: 'e', kind: 'gap', title: 'Epic', under: 'i' },
      { kind: 'bug', title: 'Issue', under: 'e', url: 'https://example.com/3' },
    ],
  })
  expect(String(ok.result)).toBe(
    'Logged 3 items:\n2 (ledger) Initiative, under 1\n3 (ledger) Epic, under 2\n4 (ledger) Issue, under 3',
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Issue/ }))?.text).toMatch(/└─ ☐ .*4\. Issue \[bug\]$/)
  await ui.unmount()
})

test('folding a parent hides its subtree and says how much', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    action: 'add',
    items: [
      { ref: 'e', kind: 'gap', title: 'Epic' },
      { ref: 'a', kind: 'gap', title: 'Child', under: 'e' },
      { kind: 'gap', title: 'Grandchild', under: 'a' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'fold-1' })
    expect((await ui.find({ type: 'Text', text: /Epic/ }))?.text).toBe(' ☐ 1. Epic (0/1) +2 folded')
    expect(await ui.find({ type: 'Text', text: /Child/ })).toBeUndefined()
    expect((await ui.find({ key: 'fold-1' }))?.props.label).toBe('▸')
    await ui.press({ key: 'fold-1' })
    expect((await ui.find({ type: 'Text', text: /Grandchild/ }))?.text).toContain('3. Grandchild')
    await ui.unmount()
  }
})

test('finished items hide, but a finished parent of open work stays', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    action: 'add',
    items: [
      { ref: 'e', kind: 'gap', title: 'Done epic' },
      { kind: 'gap', title: 'Open child', under: 'e' },
      { kind: 'gap', title: 'Done alone' },
    ],
  })
  await $.tool.call({ tool: TOOL, action: 'resolve', id: 1 })
  await $.tool.call({ tool: TOOL, action: 'resolve', id: 3 })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ type: 'Text', text: /Done alone/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Done epic/ })).toBeDefined()
  expect((await ui.find({ key: 'toggle-done' }))?.props.label).toBe('show 1 finished')
  await ui.unmount()

  const shown = await $.command.run(run('ledger', 'done'))
  expect(String(shown.text)).toBe('Finished ledger items are shown.')
})

test('merge renumbers the incoming items after the current ones', async ($, on) => {
  const { files } = engine(on)
  files.set(
    '/work/demo/m.json',
    JSON.stringify({
      format: 'ledger/1',
      sessionId: 'OLD',
      project: 'demo',
      root: '/work/demo',
      branch: null,
      exportedAt: '2026-01-01T00:00:00Z',
      briefing: null,
      items: [
        { id: 1, kind: 'gap', title: 'Their epic', status: 'open' },
        { id: 2, kind: 'gap', title: 'Their issue', status: 'open', parent: 1 },
      ],
    }),
  )
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'add', kind: 'bug', title: 'Mine' })

  const asked = await $.command.run(run('ledger-import', 'm.json'))
  expect(String(asked.text)).toContain('--merge')
  const out = await $.command.run(run('ledger-import', 'm.json --merge'))
  expect(String(out.text)).toContain('renumbered after the current ones')
  const list = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(list.result)).toBe('1 [bug] Mine\n2 [gap] Their epic\n3 [gap] Their issue under 2')
})

test('an empty session is offered the newest ledger once, without loading it', async ($, on) => {
  const { store } = engine(on)
  const clock = mock.clock(on)
  const toasts: string[] = []
  const fills: string[] = []
  on('ui.toast', (_$, e) => (toasts.push((e as { text: string }).text), { value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', (_$, e) => (fills.push((e as { text: string }).text), { isFilled: true }) as never)
  store.set('session:OLD', {
    sessionId: 'OLD',
    project: 'demo',
    root: '/work/demo',
    branch: 'main',
    updatedAt: '2026-01-01T00:00:00Z',
    items: [{ id: 1, kind: 'gap', title: 'Saved', status: 'open' }],
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(500)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(500)

  expect(toasts).toEqual(['Ledger available: auto-save of session OLD (main), 1 items. Run /ledger-import to load it.'])
  expect(fills).toEqual(['/ledger-import'])
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toBe('Ledger: nothing open.')
})
