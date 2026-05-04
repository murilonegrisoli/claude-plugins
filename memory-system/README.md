# memory-system

A structured cross-project memory layer for Claude Code. Adds:

- **Global memory** at `~/.claude/memory/` — knowledge that follows you across every project
- **Per-project memory** at `MEMORY.md` — project-specific notes
- **Auto-injection** of memory into every session (including subagent sessions) via a PreToolUse hook with session-based dedup + Agent-tool-boundary detection (so subagents get their own injection)
- **Lazy initialization** — structure is created on demand the first time memory is written, not at session start
- **Plan-mode reorganization** — `/memory-system:reorganize-memory` audits the entire memory tree and presents one consolidated approval
- **Lifecycle promotion** — when a memory file matures, `/memory-system:promote-memory` scaffolds a standalone plugin from it and replaces the source with a pointer

## Why this exists

Native Claude Code memory (`CLAUDE.md`) is great but project-scoped. This plugin adds a global layer for tool/library knowledge that persists across projects, plus structure and lifecycle for managing it as it grows.

## Prerequisites

- Python 3.8+ on PATH (the PreToolUse hook is a tiny python script). Pre-installed on macOS and every Linux distro. On Windows, install from python.org or use the `py` launcher — note that the `python` command may resolve to a Microsoft Store stub if Python isn't actually installed.

## Install

From a marketplace:

```
/plugin marketplace add <repo-url>
/plugin install memory-system
/reload-plugins
```

For local development:

```
/plugin marketplace add /path/to/this/repo
/plugin install memory-system@<marketplace-name>
/reload-plugins
```

## What gets injected

On the first tool call of every session (including subagents):

```
=== Project MEMORY.md (`<slug>`) ===
<contents of ~/.claude/project-memory/<slug>/MEMORY.md if it exists>

=== Global Memory Index ===
<contents of ~/.claude/memory/MEMORY.md>
```

Subsequent tool calls in the same session stay silent — state is tracked at `~/.claude/cache/memory-system/state.json`. Sessions older than 7 days are pruned automatically.

## How memory gets written

v0.1 ships **read-side automation** (the PreToolUse hook above). Writes are still claude-driven via the `memory-system` skill, which triggers when:

- The user explicitly asks ("remember X", "save this", "write this down")
- Claude recognizes non-obvious knowledge worth persisting (gotchas, workarounds, debugging insights, user preferences)

The skill handles classification, lazy structure init, dedup checks, format enforcement, and index maintenance. See `skills/memory-system/SKILL.md` for the full rule set.

> **Why no auto-write hook in v0.1?** Prompt-based `Stop` hooks suffer from transcript context bleed — the sub-evaluation that decides whether to block can be corrupted by prior hook outputs visible in the conversation, leading to unreliable decisions. A v0.2 candidate would use a command-type `Stop` hook that calls the Anthropic API directly with a clean isolated context (similar to how claude-mem's worker pattern operates).

> **Note on the project slug**: the slug is the basename of the current working directory. If two projects share the same folder name (e.g. two repos both called `frontend`), they currently share the same project memory file. If this matters for you, keep distinct folder names or scope project memory to one of them.

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `memory-system` | "remember X", "save to memory", non-obvious knowledge | Core meta-skill: classify, init, dedupe, write, evaluate promotion |
| `reorganize-memory` | `/memory-system:reorganize-memory` | Audit full memory tree, propose changes via plan mode, apply on approval |
| `promote-memory` | `/memory-system:promote-memory <file>`, mature memory file detected | Scaffold a plugin from a memory file, replace source with a pointer |

## Per-project config

Drop `.claude/memory-system.local.md` in any project to override behavior:

```yaml
---
disabled: true
---
```

Currently supported fields:

- `disabled` (default `false`) — skip memory injection in this project

See `examples/memory-system.local.md` for the template.

## File layout

```
~/.claude/memory/
├── MEMORY.md           # global index
├── general.md          # cross-project conventions
└── tools/
    ├── {name}.md       # narrow notes per tool/library
    └── {name}/         # subfolder when a topic outgrows one file
        ├── overview.md
        └── {sub-topic}.md

~/.claude/project-memory/
└── <project-slug>/
    └── MEMORY.md       # per-project memory

~/.claude/cache/memory-system/
└── state.json          # session dedup state (auto-managed)
```

## Troubleshooting

**Memory not injecting?**

- Confirm `python --version` works on PATH
- Run the hook manually: `echo '{"session_id":"test","cwd":"."}' | python <plugin-root>/hooks/inject-memory.py`
- Check `~/.claude/cache/memory-system/state.json` — if your current `session_id` is in there, dedup is working as intended (already injected this session)
- Check for a project-local `.claude/memory-system.local.md` with `disabled: true`

**Subagent sessions not seeing memory?**

That's exactly the case this plugin solves — the PreToolUse hook fires in subagent sessions and injects on the first tool call. If a subagent doesn't see memory, verify the plugin's `/reload-plugins` succeeded and the hook count went up.

**Want to wipe state?**

```
rm ~/.claude/cache/memory-system/state.json
```

Memory will re-inject on the next tool call of every active session.

## License

MIT — see the [root LICENSE](../LICENSE).
