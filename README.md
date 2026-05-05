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

### `memory-system`

Structured cross-project memory layer for Claude Code. Auto-injects project + global memory into every session (including subagents). Auto-writes memo-worthy turns via a detached `claude -p` audit worker at the end of each turn. Global memory organizes knowledge into `general.md` (cross-cutting conventions), `tools/{name}.md` (per-tool notes), and `domain/{topic}.md` (cross-tool problem areas). Per-project memory lives at `~/.claude/project-memory/{slug}/` and grows from a single `MEMORY.md` into an index + topic-file tree as the project accumulates knowledge. Includes lazy init, plan-mode reorganization, and lifecycle promotion of mature memory into standalone plugins.

```
/plugin install memory-system@negrisoli
/reload-plugins
```

See [`memory-system/README.md`](./memory-system/README.md) for details.

## License

MIT — see [`LICENSE`](./LICENSE).
