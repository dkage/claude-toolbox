import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const BAND = {
  plugin: 'usage-bars',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const measure = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) => ({
  context: { window: 200000 },
  rateLimits,
  changed: ['rateLimits' as const],
})

const measureContext = (percent: number) => ({
  context: { window: 200000, percent },
  rateLimits: [],
  changed: ['context' as const],
})

// What the engine answers beneath the plugin: echo a measurement, draw an empty band.
const engine = (on: On) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}

// The harness has no `$.session.model()`, so the test answers it, with the usage and the
// start the plugin's `session.start` hook reads. Register before the test first calls `$`.
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const sessionModel = (on: On) => {
  let id = ''

  on('session.model', () => ({ value: id }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  return (next: string) => {
    id = next
  }
}

describe('usage-bars', () => {
  test('draws no rate-limit windows while none has a reading', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /5h|Week/ })).toBeUndefined()
    await ui.unmount()
  })

  test('draws a bar, a percentage and the reset time per window', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(
      measure([
        { kind: 'five_hour', percentUsed: 50, resetsAt: '2026-10-03T14:13:00Z' },
        { kind: 'seven_day', percentUsed: 21.4, resetsAt: '2026-10-07T18:00:00Z' },
      ]),
    )

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })

      expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '██████░░░░░░' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻2h13m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Week/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /21%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻4d6h/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('colors the bar by how full the window is', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(
      measure([
        { kind: 'five_hour', percentUsed: 69 },
        { kind: 'seven_day', percentUsed: 75 },
        { kind: 'spend_limit', percentUsed: 100 },
      ]),
    )

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = JSON.stringify(await ui.drawn())
    const painted = (color: string, bar: string) =>
      `{"type":"Text","props":{"color":"${color}"},"children":["${bar}"]}`

    expect(drawn).toContain(painted('green', '████████░░░░'))
    expect(drawn).toContain(painted('yellow', '█████████░░░'))
    expect(drawn).toContain(painted('red', '████████████'))
    await ui.unmount()
  })

  test('ignores a measurement where no rate-limit window moved', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 10 }]))
    await $.session.measure({
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 90 }],
      changed: ['context'],
    })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /10%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /90%/ })).toBeUndefined()
    await ui.unmount()
  })

  test('yields the band to a survey', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 40 }]))

    const ui = await $.ui.mount({
      ...BAND,
      surface: 'terminal',
      props: { ...BAND.props, hasSurvey: true },
    })

    expect(await ui.find({ type: 'Text', text: /40%/ })).toBeUndefined()
    await ui.unmount()
  })

  test('draws the context bar in amber, shifting to pale yellow from 80%', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measureContext(30))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const painted = (color: string, bar: string) =>
      `{"type":"Text","props":{"color":"${color}"},"children":["${bar}"]}`

    expect(await ui.find({ type: 'Text', text: /Ctx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /30%/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain(painted('#FFB000', '████░░░░░░░░'))

    await $.session.measure(measureContext(85))
    await ui.redraw()

    expect(JSON.stringify(await ui.drawn())).toContain(painted('#FFE14D', '██████████░░'))
    await ui.unmount()
  })

  test('draws the context bar before any rate-limit window has a reading', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measureContext(10))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /10%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeUndefined()
    await ui.unmount()
  })

  test('shows an empty context placeholder until a response reports a fill', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 40 }]))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /Ctx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /--%/ })).toBeDefined()
    await ui.unmount()
  })

  test('nudges toward /compact from 90% context and not before', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })

    await $.session.measure(measureContext(89))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /compact soon/ })).toBeUndefined()

    await $.session.measure(measureContext(90))
    await ui.redraw()

    expect(await ui.find({ type: 'Text', text: /compact soon/ })).toBeDefined()
    await ui.unmount()
  })

  test('shows the model by its short name, or as given when it has none', async ($, on) => {
    engine(on)
    const clock = mock.clock(on, { now: NOW })
    const switchTo = sessionModel(on)

    switchTo('claude-opus-5-5')
    await $.session.start(START)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()

    switchTo('claude-sonnet-5-5[1m]')
    await clock.advance(2000)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5[1m]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeUndefined()

    switchTo('my-gateway-model')
    await clock.advance(2000)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'my-gateway-model' })).toBeDefined()
    await ui.unmount()
  })

  test('draws no model label while the model is unknown', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })
    sessionModel(on)

    await $.session.start(START)
    await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 40 }]))

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await ui.find({ type: 'Text', text: /40%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus|Sonnet|Haiku/ })).toBeUndefined()
    await ui.unmount()
  })

  test('drops the least important pieces first as the terminal narrows', async ($, on) => {
    engine(on)
    mock.clock(on, { now: NOW })
    sessionModel(on)('claude-opus-5-5')

    await $.session.start(START)
    await $.session.measure({
      context: { window: 200000, percent: 92 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 50, resetsAt: '2026-10-03T14:13:00Z' },
        { kind: 'seven_day', percentUsed: 21.4, resetsAt: '2026-10-07T18:00:00Z' },
      ],
      changed: ['context', 'rateLimits'],
    })

    const at = async (bodyColumns: number) => {
      const ui = await $.ui.mount({
        ...BAND,
        surface: 'terminal',
        props: { ...BAND.props, bodyColumns },
      })
      const has = async (text: string | RegExp) =>
        (await ui.find({ type: 'Text', text })) !== undefined
      const drawn = {
        hint: await has(/compact soon/),
        model: await has('Opus 5.5'),
        resets: await has(/↻/),
        week: await has(/Week/),
        fiveHour: await has(/5h/),
      }

      await ui.unmount()

      return drawn
    }

    expect(await at(120)).toEqual({ hint: true, model: true, resets: true, week: true, fiveHour: true })
    expect(await at(100)).toEqual({ hint: false, model: true, resets: true, week: true, fiveHour: true })
    expect(await at(90)).toEqual({ hint: false, model: false, resets: true, week: true, fiveHour: true })
    expect(await at(75)).toEqual({ hint: false, model: false, resets: false, week: true, fiveHour: true })
    expect(await at(60)).toEqual({ hint: false, model: false, resets: false, week: false, fiveHour: true })
  })
})
