# claude-toolbox

Personal Claude Code plugins: mods, and later skills. Each folder under `plugins/` is one
plugin, listed in `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | What it does |
| --- | --- |
| `usage-bars` | A band above the prompt: context bar, 5h and weekly usage bars with reset countdowns, a `compact soon` hint from 90% context, and the active model on the right. Drops pieces as the terminal narrows. |
| `ledger` | A side panel that numbers the decisions, bugs, gaps and smells Claude finds during a session, ticks them off as they are decided and retires the ones that stop mattering. Write `13 (ledger)` in a prompt to point at item 13. `/ledger` reopens the panel. |

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
