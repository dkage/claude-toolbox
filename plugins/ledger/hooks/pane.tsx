import type { EngineInterface, RenderElement } from 'claude-code'

import type { LedgerItem, LedgerKind } from '../types'
import { GLYPHS, isOpen, linkOf, stamp, when } from './model'
import { readItems, readFolded, toggleFolded, readHideDone, toggleHideDone } from './state'
import { sections, type Row, type Section } from './tree'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

/** What drawing a row needs besides the row: the elements and the folded parents. */
type Draw = { ui: Elements; folded: number[] }

/** A parent's guide and fold arrow, kept whole: shrunk by a long title they would wrap onto lines of their own. */
function lead($: EngineInterface, { ui, folded }: Draw, { item, guide, hidden }: Row): RenderElement {
  const { Box, Button, Text } = ui
  const isFolded = hidden > 0 || folded.includes(item.id)

  return (
    <Box key={`lead-${item.id}`} flexDirection="row" flexShrink={0}>
      {guide ? <Text dimColor={!isOpen(item)}>{guide}</Text> : null}
      <Button key={`fold-${item.id}`} plain label={isFolded ? '▸' : '▾'} onPress={() => void toggleFolded($, item.id)} />
    </Box>
  )
}

/** The row's line, cut to the pane. Only the number is a link, so the title stays text the pointer can hover. */
function line({ ui }: Draw, { item: i, depth, guide, kids, progress, hidden }: Row, kind: LedgerKind): RenderElement {
  const { Link, Text } = ui
  const link = linkOf(i)
  const number = `${i.id}.`

  return (
    <Text dimColor={!isOpen(i)} wrap="truncate-end">
      {kids > 0 ? ' ' : guide}
      {GLYPHS[i.status]}{' '}
      {link ? <Link href={link}>{number}</Link> : number} {i.title}
      {progress ? ` (${progress.done}/${progress.total})` : ''}
      {when(hidden, ` +${hidden} folded`)}
      {when(depth > 0 && i.kind !== kind, ` [${i.kind}]`)}
      {when(i.status === 'obsolete', ' (obsolete)')}
      {when(i.outcome && !isOpen(i), ` → ${i.outcome}`)}
    </Text>
  )
}

const statusText = (i: LedgerItem) =>
  [i.kind, i.status === 'in-progress' ? 'in progress' : i.status, when(i.parent, `under ${i.parent}`), when(i.github, `GitHub: ${i.github}`)]
    .filter(Boolean)
    .join(', ')

/** The whole item, hidden until its row is hovered, then opened beneath it, pushing the rows below down. */
function card({ ui }: Draw, i: LedgerItem): RenderElement {
  const { Box, Link, Text } = ui
  const link = linkOf(i)

  return (
    <Box display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round">
      <Text bold>
        {i.id}. {i.title}
      </Text>
      <Text dimColor>{statusText(i)}</Text>
      {i.where ? <Text>{i.where}</Text> : null}
      {i.detail ? <Text>{i.detail}</Text> : null}
      {link ? <Link href={link}>{link}</Link> : null}
      {(i.notes ?? []).map(n => (
        <Text>
          <Text dimColor>{stamp(n.at)}</Text> {n.text}
        </Text>
      ))}
      {i.outcome ? <Text>→ {i.outcome}</Text> : null}
    </Box>
  )
}

function row($: EngineInterface, draw: Draw, r: Row, kind: LedgerKind): RenderElement {
  const { Box } = draw.ui

  return (
    <Box key={`item-${r.item.id}`} flexDirection="column">
      <Box flexDirection="row">
        {r.kids > 0 ? lead($, draw, r) : null}
        {line(draw, r, kind)}
      </Box>
      {card(draw, r.item)}
    </Box>
  )
}

function section($: EngineInterface, draw: Draw, { kind, title, rows }: Section): RenderElement {
  const { Box, Text } = draw.ui

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {rows.map(r => row($, draw, r, kind))}
      <Text> </Text>
    </Box>
  )
}

/** Items a view leaves out, folded or finished: all but the rows drawn and the ones folds hide. */
const unseen = (list: LedgerItem[], groups: Section[]) =>
  list.length - groups.reduce((sum, g) => sum + g.rows.reduce((n, r) => n + 1 + r.hidden, 0), 0)

/** The ledger pane: the "hide finished" toggle, then each kind's tree. */
export async function drawPane($: EngineInterface, ui: Elements): Promise<RenderElement> {
  const { Box, Button, Text } = ui
  const list: LedgerItem[] = await readItems($)
  if (list.length === 0) {
    return <Text dimColor>Ledger is empty.</Text>
  }
  const view = { folded: await readFolded($), hideDone: await readHideDone($) }
  const groups = sections(list, view)
  const draw = { ui, folded: view.folded }

  return (
    <Box flexDirection="column">
      {list.some(i => !isOpen(i)) ? (
        <Button
          key="toggle-done"
          plain
          dimColor
          label={view.hideDone ? `show ${unseen(list, groups)} finished` : 'hide finished'}
          onPress={() => void toggleHideDone($)}
        />
      ) : null}
      {groups.map(g => section($, draw, g))}
    </Box>
  )
}
