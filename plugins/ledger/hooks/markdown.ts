import type { LedgerExport, LedgerKind } from '../types'
import { isOpen, linkOf, stamp, when } from './model'
import { sections, type Row } from './tree'

/** An item's lines in the export: its checkbox line, then detail, notes and outcome beneath. */
function itemLines({ item: i, depth, progress }: Row, kind: LedgerKind): string[] {
  const pad = '  '.repeat(depth)
  const link = linkOf(i)
  const head = [
    `${pad}- [${isOpen(i) ? ' ' : 'x'}] ${i.id}. `,
    link ? `[${i.title}](${link})` : i.title,
    progress ? ` (${progress.done}/${progress.total})` : '',
    when(depth > 0 && i.kind !== kind, ` [${i.kind}]`),
    when(i.status === 'in-progress', ' (in progress)'),
    when(i.status === 'obsolete', ' (obsolete)'),
    when(i.where, ` (\`${i.where}\`)`),
  ]
  const below = [
    ...(i.detail ? [i.detail] : []),
    ...(i.notes ?? []).map(note => `${stamp(note.at)}: ${note.text}`),
    ...(i.outcome ? [`→ ${i.outcome}`] : []),
  ]

  return [head.join(''), ...below.map(line => `${pad}  - ${line}`)]
}

/** The Markdown twin of an export: its origin, the briefing, then the tree by kind. */
export function markdown(data: LedgerExport): string {
  const lines = [
    `# Ledger: ${data.project}`,
    '',
    `Session \`${data.sessionId}\`` + when(data.branch, `, branch \`${data.branch}\``) + `, exported ${data.exportedAt}.`,
    '',
    '## Briefing',
    '',
    data.briefing ?? '_Not written yet._',
  ]
  for (const { title, kind, rows } of sections(data.items)) {
    lines.push('', `## ${title}`, '', ...rows.flatMap(row => itemLines(row, kind)))
  }

  return `${lines.join('\n')}\n`
}
