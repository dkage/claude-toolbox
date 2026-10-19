# claude-toolbox — agent guide

Personal Claude Code plugins (mods, later skills), published as one marketplace. This
repo is the only source of truth: edit here, never in a copy elsewhere.

## Layout

- `.claude-plugin/marketplace.json` lists every plugin; each entry's `source` is
  `./plugins/<name>`. Keep it in sync when a plugin is added, renamed or removed.
- `plugins/<name>/` is one plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`,
  `hooks/register.tsx` (+ `register.test.tsx`), and `types/index.d.ts` when the mod keeps
  `$.state` values.
- `.claude-plugin/types/` inside a plugin is written by the engine on every load and is
  gitignored. Do not edit or commit it.

## How the plugins load on this machine

`~/.claude/plugins-local/<name>` is a symlink to `plugins/<name>` here, and
`CLAUDE_CODE_PLUGIN_DIRS` in `~/.zshrc` lists those symlink paths. So:

- Editing a plugin here reloads it live in a session that already loaded it.
- A new plugin needs its symlink and its path added to that variable, and shows up from
  the next session. Removing a plugin means removing the folder, its marketplace entry,
  the symlink and its path in the variable.
- Never create mod folders under `~/.claude/dev-mods`, and never edit `*.bak-*` copies.

## Checking a change

```bash
claude plugin validate .
claude plugin test plugins/<name>
```

Every behaviour change gets a test. The test harness has no implementation for some
engine calls (for example `$.session.model()`); a test answers them with an `on(...)` hook
registered before the test first uses `$`.

## Commits

Personal git identity (the repo's global config), Conventional Commits, no AI attribution
of any kind (no `Co-Authored-By`, no session link, no "Generated with"). Show the exact
message and wait for an explicit "yes" before `git commit`. Never `git push` unless asked.

## Keep out of this repo

Work material: anything from Repertório or Aiorus (code, names, hosts, skills, data), and
skills or plugins installed from other marketplaces. Only my own plugins belong here.
