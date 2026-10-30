import type { Register } from 'claude-code'

import type { LedgerItem } from '../types'
import { act, type Input } from './actions'
import { exportLedger } from './exporting'
import { importLedger, offer } from './importing'
import { PANE, TOOL, background } from './model'
import { drawPane } from './pane'
import { referencedIds, rulesWith, spelledOut } from './prompt'
import { registerAll } from './setup'
import { readItems, toggleHideDone } from './state'
import { save, saveIfNew } from './storage'
import { syncLedger } from './sync'

/** Wires the ledger's hooks; each one's work lives in its own module. */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerAll($)
    background($.ui.open({ id: PANE, title: 'Ledger' }))
    background(saveIfNew($))
    $.clock.after(500, () => void offer($))

    return next(e)
  })

  // /clear and /new empty the session's state: keep the ledger as it ends.
  on('session.end', async ($, e, next) => {
    await save($, e.sessionId)
    if (e.reason === 'clear') {
      // The process goes on as a new, empty session: offer the ledger just saved.
      $.clock.after(500, () => void offer($))
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'ledger' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Ledger' })
    if (e.args.trim() !== 'done') {
      return { text: 'Ledger panel opened.' }
    }
    const hidden = await toggleHideDone($)

    return { text: hidden ? 'Finished ledger items are hidden.' : 'Finished ledger items are shown.' }
  })

  on('command.run', { command: 'ledger-export' }, ($, e) => exportLedger($, e.args))

  on('command.run', { command: 'ledger-import' }, ($, e) => importLedger($, e.args))

  on('command.run', { command: 'ledger-sync' }, $ => syncLedger($))

  on('tool.call', { tool: TOOL }, async ($, e) => act($, e as unknown as Input, await readItems($)))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = rulesWith(await readItems($))

    return { sections: [...composed.sections, { id: 'ledger:rules', text, scope: 'session' as const }] }
  })

  // "13 (ledger)" or "L13" in a prompt: the item, spelled out beneath it.
  on('prompt.submit', async ($, e, next) => {
    const ids = referencedIds(e.text)
    if (ids.size === 0) {
      return next(e)
    }
    const list: LedgerItem[] = await readItems($)
    const found = list.filter(i => ids.has(i.id)).map(spelledOut)

    return next(found.length ? { ...e, text: `${e.text}\n\n${found.join('\n')}` } : e)
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, $.ui.resolve(e)))
}
