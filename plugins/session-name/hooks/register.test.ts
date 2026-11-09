import { expect, test } from 'claude-code/testing'

import { latestTitle } from './register'

const PATH = '/home/me/.claude/projects/-work/abc.jsonl'

const lines = (...entries: object[]) => entries.map(e => JSON.stringify(e)).join('\n')

test('a rename wins over a generated title, and the latest of each wins', () => {
  expect(
    latestTitle(
      lines(
        { type: 'ai-title', aiTitle: 'First' },
        { type: 'custom-title', customTitle: 'Mine' },
        { type: 'ai-title', aiTitle: 'Later' },
        { type: 'custom-title', customTitle: 'Mine again' },
      ),
    ),
  ).toBe('Mine again')
  expect(latestTitle(lines({ type: 'ai-title', aiTitle: 'Only' }) + '\n{broken')).toBe('Only')
  expect(latestTitle('')).toBe(undefined)
})

test('the session name is pinned in the status line at start', async ($, on) => {
  const statuses: (string | undefined)[] = []

  on('session.id', () => ({ value: 'abc' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
      stdout:
        e.argv[0] === 'find'
          ? `${PATH}\n`
          : lines({ type: 'ai-title', aiTitle: 'Session name in status bar' }),
    },
  }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(statuses).toEqual(['◆ Session name in status bar'])
})
