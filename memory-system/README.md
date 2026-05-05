# memory-system

A structured cross-project memory layer for Claude Code. Adds:

- **Global memory** at `~/.claude/memory/` — knowledge that follows you across every project (an index `MEMORY.md` plus topic files: `general.md` for cross-cutting conventions, `tools/{name}.md` for tool/library notes, `domain/{topic}.md` for cross-tool knowledge areas)
- **Per-project memory** at `~/.claude/project-memory/{slug}/` — starts as a single `MEMORY.md` and graduates into an index + topic-file tree as the project's knowledge grows
- **Auto-injection** of memory into every session (including subagent sessions) via a PreToolUse hook with session-based dedup + Agent-tool-boundary detection + mtime-based re-injection on mid-session writes
- **Auto-write** of memo-worthy turns via a Stop hook: a detached worker spawns `claude -p` to audit the recent turn and persist gotchas, preferences, project state, and decisions automatically — using the user's existing Claude Code auth (no API key required)
- **Lazy initialization** — structure is created on demand the first time memory is written, not at session start
- **Plan-mode reorganization** — `/memory-system:reorganize-memory` audits the entire memory tree (global + project) and presents one consolidated approval covering dedupes, splits, merges, project-mode graduation, and index hygiene
- **Lifecycle promotion** — when a memory file matures, `/memory-system:promote-memory` scaffolds a standalone plugin from it and replaces the source with a pointer

## Why this exists

Native Claude Code memory (`CLAUDE.md`) is great but project-scoped. This plugin adds a global layer for tool/library knowledge that persists across projects, plus structure and lifecycle for managing it as it grows.

**vs [claude-mem](https://github.com/thedotmack/claude-mem):** different goals, different shapes. claude-mem is session-replay memory — every tool call captured, compressed via `claude-agent-sdk`, stored in SQLite + vector search, retrieved at session start. Optimized for "what did I do in this repo last week" recall. This plugin is a curated knowledge layer — classified markdown topic files you read, edit, grep, and version-control yourself. Optimized for gotchas, conventions, decisions, and tool/library knowledge you'd document anyway. The two solve adjacent problems and run fine alongside each other; pick this one if you want a knowledge graph you own as plain text, not a vector index.

## Prerequisites

- Node 18+ on PATH. The hooks ship as `.mjs` (no build step, no dependencies — pure stdlib). Type-checked via `tsc --checkJs` in CI.

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

Two paths:

**1. In-session writes via the `memory-system` skill** (synchronous, claude-driven). Triggers when:

- The user explicitly asks ("remember X", "save this", "write this down")
- Claude recognizes non-obvious knowledge worth persisting (gotchas, workarounds, debugging insights, user preferences)

The skill handles classification, lazy structure init, dedup checks, format enforcement, mode detection (single-file vs index for project memory), and index maintenance. New entries route to the right file automatically — to a topic file in index mode, or appended as a `## H2` to `MEMORY.md` in single-file mode. See `skills/memory-system/SKILL.md` for the full rule set.

**2. Auto-write via the Stop hook** (asynchronous, autonomous). At the end of every turn, a Stop hook fires `audit-memory.mjs`. After heuristic gates (transcript exists, recursion guard, per-project disable), it spawns a detached worker that runs `claude -p` with an isolated audit prompt. The auditor reviews a semantic excerpt of the recent conversation (last 15 user/assistant messages from the session jsonl, with `tool_use` / `tool_result` blobs collapsed to one-liner summaries so most of the audit budget is spent on real conversation rather than tool noise), decides if anything is memo-worthy across four categories (gotchas, user preferences/corrections, project state changes, non-obvious choices), and writes via Read/Write/Edit (with explicit dedup-then-write ordering enforced in the prompt). The dedup gate (`last_audited_turn_id`) prevents re-auditing the same content; per-turn audits let approvals land in the next audit window quickly. Loop prevention via the `MEMORY_SYSTEM_AUDITOR=1` env var — any nested Stop hook bails immediately.

**Auditor safety (v0.3.3+):**

- **Tool allowlist** — invoked with `--allowed-tools "Read,Write,Edit,Glob,Grep"`. The auditor literally cannot run `Bash`, spawn `Task` subagents, or call any other tool. Even if the transcript contains "delete X" or "rm Y" instructions, the auditor cannot execute destructive ops — the tools aren't available.
- **Confirmation filter** — the auditor only crystallizes claims that were user-stated as fact, code-visible (in a tool result), or confirmed through repro. Hedged claims ("I think", "probably", "might") and unconfirmed speculation are skipped, regardless of the "bias toward writing" instruction.
- **Routing self-check** — before any global memory write, the auditor performs a self-test: replace project/plugin/version names with `<other-project>` and ask "would a developer on a totally different project benefit from this?" If no, route to `~/.claude/project-memory/{slug}/` instead. Prevents project-specific roadmaps from leaking into `~/.claude/memory/domain/`.
- **Output post-processing** — the worker logs only the auditor's first `wrote:` / `skip:` action line and discards any surrounding commentary. Defensive against output bleed where the auditor mimics structured chat content from the transcript.

**Slug resolution (v0.3.4+):**

Memory routes to `~/.claude/project-memory/{slug}/`. The slug is resolved via a 5-step lookup chain (first match wins):

1. **Explicit override** — `.claude/memory-system.local.md` frontmatter `project_slug:` value
2. **Plugin marker walk-up** — first directory above cwd containing `.claude-plugin/plugin.json` → use that dir's name (handles "user cd'd into a plugin folder")
3. **Recent file activity** — if cwd is at or above a repo root containing plugin subfolders, check the about-to-fire tool call's `file_path` (PreToolUse) or recent transcript tool_use events (Stop hook) for matches inside a plugin subfolder → use that plugin's name (handles "user is at repo root but actively editing files in one plugin")
4. **Repo root via .git/** — walk up from cwd to find the repo's `.git/` directory → use the repo's dir name
5. **Fallback** — `cwd.name` (preserves pre-v0.3.4 behavior for layouts where no marker exists)

For most repos (single-project, no plugin marker subfolders), step 4 fires and slug = repo name — no behavior change from v0.3.3. For multi-plugin marketplaces (like `claude-plugins` itself), steps 2-3 handle scoping automatically without requiring `cd` between plugin folders.

The worker invokes `claude -p` with `--permission-mode bypassPermissions`, `--add-dir ~/.claude/memory`, `--add-dir ~/.claude/project-memory`, and `--no-session-persistence` (audit sessions don't clutter your `/resume` picker). It logs every fire to `~/.claude/cache/memory-system/audit.log` and tracks per-session state in `~/.claude/cache/memory-system/audit-state.json`. The auditor runs in non-interactive mode: it cannot use `AskUserQuestion` and is forbidden from modifying or removing existing memory entries — it only adds new ones. Existing entries that need updating still require an interactive session with the `memory-system` skill.

Wall-clock per audit is roughly 20–60 seconds depending on transcript size and model. The worker is detached, so you're never blocked — just check `audit.log` if you're curious what landed.

> **No API key needed.** The worker shells out to the user's existing `claude` binary, inheriting whatever auth Claude Code itself uses (subscription, API key, Bedrock, Vertex). Plug-and-play for any Claude Code user. The auditor uses `haiku` by default for cost; override via `MEMORY_SYSTEM_AUDIT_MODEL` env var (e.g. `sonnet` for sharper decisions at higher cost).

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

- `disabled` (default `false`) — skip both memory injection AND auto-write auditing in this project

See `examples/memory-system.local.md` for the template.

## Auto-write env vars

| Env var | Effect |
|---------|--------|
| `MEMORY_SYSTEM_AUDIT_MODEL` | Override the auditor model. Default: `haiku`. Try `sonnet` for sharper decisions at higher cost. |
| `MEMORY_SYSTEM_AUDITOR=1` | Internal: set by the worker on its `claude -p` subprocess. Any Stop hook seeing this var bails (loop prevention). Don't set manually unless you want to disable auto-write globally. |

## File layout

```
~/.claude/memory/
├── MEMORY.md           # global index
├── general.md          # cross-project conventions
├── tools/
│   ├── {name}.md       # narrow notes per tool/library
│   └── {name}/         # subfolder when a topic outgrows one file
│       ├── overview.md
│       └── {sub-topic}.md
└── domain/
    ├── {topic}.md      # cross-tool knowledge area (problem space spanning multiple tools)
    └── {topic}/        # subfolder when a topic outgrows one file
        ├── overview.md
        └── {sub-topic}.md

~/.claude/project-memory/
└── <project-slug>/
    ├── MEMORY.md       # single-file mode (small project) OR index mode (after graduation)
    ├── {topic}.md      # topic file (index mode only)
    └── {topic}/        # subfolder when a topic outgrows one file
        └── {sub-topic}.md

~/.claude/cache/memory-system/
├── state.json          # PreToolUse session dedup state (auto-managed)
├── audit-state.json    # Stop hook audit dedup state (auto-managed)
└── audit.log           # auto-write worker activity log (tail to debug)
```

**Project memory has two modes:**

- **Single-file** — `MEMORY.md` is prose with `## H2` topics. Default for fresh projects.
- **Index** — `MEMORY.md` is a table of topic files plus a brief `## Quick context` intro. Topic files (and topic subfolders) live alongside it.

Projects graduate from single-file → index via `/memory-system:reorganize-memory` once `MEMORY.md` crosses ~150 lines or 3+ distinct topics. The PreToolUse hook always injects only `MEMORY.md` — in single-file mode that's the content; in index mode it's the table that tells the agent which topic files to load on demand.

## Troubleshooting

**Memory not injecting?**

- Confirm `node --version` reports 18+ on PATH
- Run the hook manually: `echo '{"session_id":"test","cwd":"."}' | node <plugin-root>/hooks/inject-memory.mjs`
- Check `~/.claude/cache/memory-system/state.json` — if your current `session_id` is in there, dedup is working as intended (already injected this session)
- Check for a project-local `.claude/memory-system.local.md` with `disabled: true`

**Subagent sessions not seeing memory?**

That's exactly the case this plugin solves — the PreToolUse hook fires in subagent sessions and injects on the first tool call. If a subagent doesn't see memory, verify the plugin's `/reload-plugins` succeeded and the hook count went up.

**Want to wipe state?**

```
rm ~/.claude/cache/memory-system/state.json
rm ~/.claude/cache/memory-system/audit-state.json
```

Memory will re-inject on the next tool call of every active session, and auto-write will treat all sessions as fresh.

**Auto-write isn't running?**

- Check `~/.claude/cache/memory-system/audit.log` — every Stop hook fire (that gets past the gates) leaves a trace
- Confirm `claude` is on PATH: `which claude` (it must be resolvable from a non-interactive subprocess — try `node -e "console.log(require('child_process').spawnSync(process.platform==='win32'?'where':'which',['claude']).stdout.toString())"`)
- Audit fires on every Stop hook event (per-turn). If the same turn hasn't progressed (no new messages since `last_audited_turn_id`), the worker bails on the dedup check
- Check for a project-local `.claude/memory-system.local.md` with `disabled: true`

**Auto-write writing too much?**

- Tail recent `audit.log` entries to see what's being written and where
- Disable per-project via `.claude/memory-system.local.md` (`disabled: true`)
- For a global kill switch, set `MEMORY_SYSTEM_AUDITOR=1` in your shell env — the Stop hook treats this as "we're recursing" and skips
- If a specific entry shouldn't have landed, just delete it from the relevant `.md` file. The auditor won't re-add it because the dedup pass during the next audit will see it's already there (until you delete it again — at which point you may want a per-project disable)

**Auto-write writing too little?**

- Check `audit.log` for `skip:` entries with reasons
- The default model is `haiku`. For sharper decisions, run `MEMORY_SYSTEM_AUDIT_MODEL=sonnet` in your shell before the audit fires
- The audit window is the last 15 user/assistant messages from the session jsonl (tool blobs are summarized, not counted). If a memo-worthy item was earlier in the session, it may be outside the window — surface it explicitly via the `memory-system` skill ("remember X"). Smaller window vs v0.3.3 (was 30) is offset by per-turn audit firing — content cycles through multiple sequential audits as the window slides forward.

## License

MIT — see the [root LICENSE](../LICENSE).
