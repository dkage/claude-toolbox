import type { EngineInterface, Register, Timer } from 'claude-code'

// The engine has no title getter, so the name is read from the session's transcript,
// where it is stored as `ai-title` (generated) and `custom-title` (/rename) lines.
const TITLE_LINE = '"type":"(custom-title|ai-title)"'

// Titles are generated after the first prompt, in the background, so they are polled.
const POLL_MS = 15000

type TitleLine = { type?: string; aiTitle?: string; customTitle?: string }

let poller: Timer | undefined
let transcript: string | undefined
let shown: string | undefined

const findTranscript = async ($: EngineInterface) => {
  const id = (await $.session.id()).replace(/\.jsonl$/, '')
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const { stdout } = await $.process.run([
    'find', `${configDir}/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`,
  ])

  return stdout.split('\n').find(line => line !== '')
}

// A rename wins over a generated title; within each, the latest line wins.
export const latestTitle = (lines: string) => {
  let ai: string | undefined
  let custom: string | undefined

  for (const line of lines.split('\n')) {
    if (line === '') continue

    try {
      const entry = JSON.parse(line) as TitleLine

      if (entry.type === 'ai-title' && entry.aiTitle) ai = entry.aiTitle
      if (entry.type === 'custom-title' && entry.customTitle) custom = entry.customTitle
    } catch {
      // a line that is not whole JSON is skipped
    }
  }

  return custom ?? ai
}

const refresh = async ($: EngineInterface) => {
  transcript ??= await findTranscript($).catch(() => undefined)

  if (transcript === undefined) return

  const { stdout } = await $.process
    .run(['grep', '-E', TITLE_LINE, transcript])
    .catch(() => ({ stdout: '' }))
  const title = latestTitle(stdout)

  if (title !== undefined && title !== shown) {
    shown = title
    $.ui.status(`◆ ${title}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    transcript = undefined
    shown = undefined
    await refresh($)
    poller ??= $.clock.every(POLL_MS, () => void refresh($))

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    void refresh($)

    return result
  })
}
