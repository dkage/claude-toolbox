import type { EngineInterface } from 'claude-code'

const KIND_ENUM = { type: 'string', enum: ['decision', 'bug', 'gap', 'smell'] }

const NEW_ITEM = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'A name for this entry, for "under" in later entries.' },
    under: { type: 'string', description: 'The ref of an earlier entry in this batch to nest under.' },
    parent: { type: 'integer', description: 'An existing item number to nest under.' },
    kind: KIND_ENUM,
    title: { type: 'string' },
    detail: { type: 'string' },
    where: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['kind', 'title'],
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'start', 'note', 'edit', 'resolve', 'obsolete', 'reopen', 'move', 'list', 'brief'],
    },
    kind: KIND_ENUM,
    title: { type: 'string', description: 'Short one-line title (add, edit).' },
    detail: { type: 'string', description: 'Context or, for a decision, the options (add, edit).' },
    where: { type: 'string', description: 'file:line the item concerns (add, edit).' },
    url: { type: 'string', description: 'Link to the issue or page the item tracks (add, edit).' },
    parent: { type: 'integer', description: 'Item number to nest under (add, move); 0 makes it top-level (move).' },
    id: { type: 'integer', description: 'Item number (start, note, edit, resolve, obsolete, reopen, move).' },
    outcome: { type: 'string', description: 'What was decided or done, or why obsolete.' },
    note: { type: 'string', description: 'A line of progress to append, dated (note).' },
    path: { type: 'string', description: 'The export file the briefing belongs to (brief).' },
    briefing: { type: 'string', description: 'The session briefing, in Markdown (brief).' },
    items: {
      type: 'array',
      description: 'Several items to log at once (add), in order; nest with "under" or "parent".',
      items: NEW_ITEM,
    },
  },
  required: ['action'],
}

const COMMANDS = [
  {
    name: 'ledger',
    description: 'Open the ledger panel; "done" shows or hides finished items',
    argumentHint: '[done]',
  },
  {
    name: 'ledger-export',
    description: 'Export the ledger, with a session briefing, to JSON and Markdown',
    argumentHint: '[dir or file.json]',
  },
  {
    name: 'ledger-sync',
    description: 'Check the GitHub issues and pull requests ledger items link, and resolve the closed ones',
  },
  {
    name: 'ledger-import',
    description: "Load an exported or another session's ledger into this session",
    argumentHint: '[file.json | list] [--replace | --merge]',
  },
]

/** Registers the ledger tool and its slash commands. */
export async function registerAll($: EngineInterface) {
  await $.tool.register({
    name: 'ledger',
    description:
      'Log, track, resolve or retire numbered items (decisions, bugs, gaps, smells) in the ledger side panel the person is watching, nest them under one another, note progress on them, and write the briefing of an export. Actions: add, start, note, edit, resolve, obsolete, reopen, move, list, brief.',
    isDeferred: false,
    inputSchema: INPUT_SCHEMA,
  })
  for (const command of COMMANDS) {
    await $.command.register(command)
  }
}
