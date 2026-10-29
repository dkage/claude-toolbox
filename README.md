# claude-toolbox

Personal Claude Code plugins: mods, and later skills. Each folder under `plugins/` is one
plugin, listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| `usage-bars` | A band above the prompt: context bar, 5h and weekly usage bars with reset countdowns, a `compact soon` hint from 90% context, and the active model on the right. Drops pieces as the terminal narrows. |
| `ledger` | A side panel that numbers the decisions, bugs, gaps and smells Claude finds during a session. Claude logs them (one at a time or a whole roadmap in one call), starts them, edits them, adds dated notes, ticks them off as they are decided and retires the ones that stop mattering. Items nest under one another as a tree (an issue under its epic) with each parent's progress, a parent's subtree folds, and hovering a row opens its full card; an item's number links to its URL. Write `13 (ledger)` in a prompt to point at item 13. `/ledger` reopens the panel and `/ledger done` hides or shows finished items. The ledger is auto-saved across sessions, and a new or cleared session is offered the last one; `/ledger-export [dir]` writes it as JSON and Markdown with a briefing Claude writes for the next session, `/ledger-import [file.json \| list] [--replace \| --merge]` loads an export or the latest auto-save of the project, and `/ledger-sync` resolves items whose GitHub issue or pull request closed. |

## Install

At the prompt of a terminal session:

```
/plugin install usage-bars --marketplace <owner>/<repo>
```

From a shell:

```
claude plugin install usage-bars --marketplace <owner>/<repo>
```

For a private repo, GitHub must be set up on that machine (`gh auth login`).

To run a plugin straight from a clone, without installing:

```
claude --plugin-dir plugins/usage-bars
claude --plugin-dir plugins/ledger
```

## Develop

```
claude plugin validate .
claude plugin test plugins/usage-bars
claude plugin test plugins/ledger
```
