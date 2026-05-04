# memory-system

A structured cross-project memory layer for Claude Code. Adds:

- **Global memory** at `~/.claude/memory/` — knowledge that follows you across every project (an index `MEMORY.md` plus topic files under `general.md` and `tools/`)
- **Per-project memory** at `~/.claude/project-memory/{slug}/` — starts as a single `MEMORY.md` and graduates into an index + topic-file tree as the project's knowledge grows
- **Auto-injection** of memory into every session (including subagent sessions) via a PreToolUse hook with session-based dedup + Agent-tool-boundary detection + mtime-based re-injection on mid-session writes
- **Lazy initialization** — structure is created on demand the first time memory is written, not at session start
- **Plan-mode reorganization** — `/memory-system:reorganize-memory` audits the entire memory tree (global + project) and presents one consolidated approval covering dedupes, splits, merges, project-mode graduation, and index hygiene
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

The hook also re-injects mid-session if any watched memory file has been modified since the last injection. The watch covers the entire global memory tree (`~/.claude/memory/**/*.md`) and the entire active project's memory tree (`~/.claude/project-memory/{slug}/**/*.md`). This covers concurrent sessions writing to memory, the user editing a memory file by hand, and Claude itself writing memory mid-flow — the next tool call sees the fresh content rather than the stale snapshot from session start.

## How memory gets written

The plugin currently ships **read-side automation** (the PreToolUse hook above). Writes are claude-driven via the `memory-system` skill, which triggers when:

- The user explicitly asks ("remember X", "save this", "write this down")
- Claude recognizes non-obvious knowledge worth persisting (gotchas, workarounds, debugging insights, user preferences)

The skill handles classification, lazy structure init, dedup checks, format enforcement, mode detection (single-file vs index for project memory), and index maintenance. New entries route to the right file automatically — to a topic file in index mode, or appended as a `## H2` to `MEMORY.md` in single-file mode. See `skills/memory-system/SKILL.md` for the full rule set.

> **Auto-write hook (planned).** Prompt-based `Stop` hooks suffer from transcript context bleed — the sub-evaluation that decides whether to block can be corrupted by prior hook outputs visible in the conversation, leading to unreliable decisions. A planned future release will use a command-type `Stop` hook that calls the Anthropic API directly with a clean isolated context (similar to how claude-mem's worker pattern operates).

> **Note on the project slug**: the slug is the basename of the current working directory. If two projects share the same folder name (e.g. two repos both called `frontend`), they currently share the same project memory file. If this matters for you, keep distinct folder names or scope project memory to one of them.

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `memory-system` | "remember X", "save to memory", non-obvious knowledge | Core meta-skill: classify, detect project mode, init, dedupe, write to the right file, maintain index |
| `reorganize-memory` | `/memory-system:reorganize-memory` | Audit full memory tree (global + active project), propose dedupes / splits / merges / mode graduation / index fixes via plan mode, apply on approval |
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
    ├── MEMORY.md       # single-file mode (small project) OR index mode (after graduation)
    ├── {topic}.md      # topic file (index mode only)
    └── {topic}/        # subfolder when a topic outgrows one file
        └── {sub-topic}.md

~/.claude/cache/memory-system/
└── state.json          # session dedup state (auto-managed)
```

**Project memory has two modes:**

- **Single-file** — `MEMORY.md` is prose with `## H2` topics. Default for fresh projects.
- **Index** — `MEMORY.md` is a table of topic files plus a brief `## Quick context` intro. Topic files (and topic subfolders) live alongside it.

Projects graduate from single-file → index via `/memory-system:reorganize-memory` once `MEMORY.md` crosses ~150 lines or 3+ distinct topics. The PreToolUse hook always injects only `MEMORY.md` — in single-file mode that's the content; in index mode it's the table that tells the agent which topic files to load on demand.

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
