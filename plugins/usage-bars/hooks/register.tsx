import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'usage-bars', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'usage-bars', key: 'context' } as const, null as number | null)
const model = atom({ plugin: 'usage-bars', key: 'model' } as const, '')

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  spend_limit: 'Spend',
}
const WIDTH = 12

const bar = (percent: number) => {
  const filled = Math.round((Math.min(percent, 100) / 100) * WIDTH)

  return '█'.repeat(filled) + '░'.repeat(WIDTH - filled)
}

const tone = (percent: number) =>
  percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'

// The context bar has its own palette: amber, shifting to a pale yellow as it fills.
const AMBER = '#FFB000'
const PALE_YELLOW = '#FFE14D'
const contextTone = (percent: number) => (percent >= 80 ? PALE_YELLOW : AMBER)

// From this fill the band nudges toward /compact.
const COMPACT_AT = 90
const COMPACT_HINT = '⚠ compact soon'

// The engine has no event for /model, so the label is polled and redrawn on change.
const MODEL_POLL_MS = 2000

const until = (iso: string | undefined, now: number) => {
  if (iso === undefined) return ''

  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) return ` ↻${days}d${hours}h`
  if (hours > 0) return ` ↻${hours}h${minutes % 60}m`

  return ` ↻${minutes}m`
}

// `claude-opus-5-5[1m]` reads `Opus 5.5[1m]`; any other spelling is shown as given.
const shortModel = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[[^\]]*\])?$/.exec(id)

  if (match === null) return id

  const [, family = '', major = '', minor, suffix = ''] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)

  return `${name} ${major}${minor === undefined ? '' : `.${minor}`}${suffix}`
}

// Cells each piece takes, mirroring what the band draws.
const MODEL_GAP = 2

const contextWidth = (fill: number | null) =>
  4 + WIDTH + (fill === null ? 4 : 2 + String(Math.round(fill)).length)

const windowWidth = (row: Limit, hasReset: boolean, now: number) =>
  5 +
  (LABELS[row.kind] ?? row.kind).length +
  1 +
  WIDTH +
  2 +
  String(Math.round(row.percentUsed)).length +
  (hasReset ? until(row.resetsAt, now).length : 0)

// What fits in `columns`. The least important piece goes first: the compact hint,
// the model, the reset countdowns, then the windows from the last backwards.
const fit = (columns: number, fill: number | null, rows: Limit[], label: string, now: number) => {
  let hasHint = fill !== null && fill >= COMPACT_AT
  let hasModel = label !== ''
  let hasResets = true
  let count = rows.length

  const width = () =>
    contextWidth(fill) +
    (hasHint ? COMPACT_HINT.length + 2 : 0) +
    rows.slice(0, count).reduce((sum, row) => sum + windowWidth(row, hasResets, now), 0) +
    (hasModel ? MODEL_GAP + label.length : 0)

  if (width() > columns) hasHint = false
  if (width() > columns) hasModel = false
  if (width() > columns) hasResets = false

  while (count > 1 && width() > columns) count -= 1

  return { hasHint, hasModel, hasResets, count }
}

export const register: Register = on => {
  let poller: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const refreshModel = async () => {
      const current = await $.session.model().catch(() => '')

      if (current !== (await read($, model))) {
        await update($, model, () => current)
      }
    }

    await refreshModel()

    if (poller === undefined) {
      poller = $.clock.every(MODEL_POLL_MS, refreshModel)
    }

    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => usage.context.percent ?? null)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => e.rateLimits)
    }

    if (e.changed.includes('context')) {
      await update($, context, () => e.context.percent ?? null)
    }

    return next(e)
  })

  on('session.end', ($, e, next) => {
    poller?.cancel()
    poller = undefined

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, limits)
    const fill = await read($, context)
    const id = await read($, model)

    if (e.props.hasSurvey) {
      return next(e)
    }

    const now = await $.clock.now()
    const label = shortModel(id)
    const { Box, Text } = $.ui.resolve(e)
    const shown = fit(e.props.bodyColumns, fill, rows, label, now)

    return (
      <Box justifyContent="space-between">
        <Box>
          <Text key="context">
            <Text dimColor>Ctx </Text>
            <Text {...(fill === null ? { dimColor: true } : { color: contextTone(fill) })}>
              {bar(fill ?? 0)}
            </Text>
            {fill === null ? <Text dimColor> --%</Text> : <Text> {Math.round(fill)}%</Text>}
            {shown.hasHint ? <Text color="red">{`  ${COMPACT_HINT}`}</Text> : null}
          </Text>
          {rows.slice(0, shown.count).map(row => (
            <Text key={row.kind}>
              <Text dimColor>{'  │  '}</Text>
              <Text dimColor>{LABELS[row.kind] ?? row.kind} </Text>
              <Text color={tone(row.percentUsed)}>{bar(row.percentUsed)}</Text>
              <Text> {Math.round(row.percentUsed)}%</Text>
              <Text dimColor>{shown.hasResets ? until(row.resetsAt, now) : ''}</Text>
            </Text>
          ))}
        </Box>
        {shown.hasModel ? (
          <Box flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
