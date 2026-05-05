# negrisoli — Claude Code plugins by Murilo Negrisoli

A small marketplace of Claude Code plugins. Add it to your Claude Code instance, install the plugins you want.

## Install the marketplace

```
/plugin marketplace add https://github.com/murilonegrisoli/claude-plugins
```

Then list available plugins:

```
/plugin marketplace list negrisoli
```

## Plugins

### `memory-system` ⚠️ experimental

> Not production-ready. The background auditor produces noise — review what lands in `~/.claude/memory/` after sessions. Manual writes via the `memory-system` skill are reliable; the auto-write Stop hook is what to watch.

Structured cross-project memory layer for Claude Code. Auto-injects project + global memory at session start (and on relevant boundaries mid-session), including subagents. Auto-writes memo-worthy turns via a detached `claude -p` audit worker at the end of each turn. Global memory organizes knowledge into `general.md` (cross-cutting conventions), `tools/{name}.md` (per-tool notes), and `domain/{topic}.md` (cross-tool problem areas). Per-project memory lives at `~/.claude/project-memory/{slug}/` and grows from a single `MEMORY.md` into an index + topic-file tree as the project accumulates knowledge. Includes lazy init, plan-mode reorganization, and lifecycle promotion of mature memory into standalone plugins.

```
/plugin install memory-system@negrisoli
/reload-plugins
```

See [`memory-system/README.md`](./memory-system/README.md) for details.

### `statusline`

Claude Code statusline renderer that ships a useful baseline (context window + 5h/7d rate-limit progress bars) and aggregates signals from any plugin that drops a line into `~/.claude/cache/*/statusline.txt`. File-based signal convention means plugins can contribute status segments without coupling — `memory-system` already publishes its latest auditor action this way. Interactive `/statusline:install` (with backup-and-restore for any prior `statusLine.command`) and `/statusline:uninstall` commands.

```
/plugin install statusline@negrisoli
/reload-plugins
/statusline:install
```

See [`statusline/README.md`](./statusline/README.md) for details.

## License

MIT — see [`LICENSE`](./LICENSE).
