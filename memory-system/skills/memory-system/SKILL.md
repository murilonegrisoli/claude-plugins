---
name: memory-system
description: This skill should be used when the user asks to "remember X", "save this to memory", "write this down", "I keep forgetting Y", or when Claude learns non-obvious knowledge worth persisting (gotchas, workarounds, conventions, debugging insights, user preferences). Manages the structured memory layer at `~/.claude/memory/` (global) and per-project `MEMORY.md` files. Handles lazy initialization, classification, deduplication, format enforcement, index maintenance, and post-write evaluation for plugin promotion.
---

# Memory System

Persist non-obvious knowledge to a structured memory layer that survives across sessions and projects. Global memory lives at `~/.claude/memory/`. Per-project memory lives at `~/.claude/project-memory/{slug}/MEMORY.md` where `{slug}` is the basename of the project's working directory — the active path is injected into context by the memory PreToolUse hook.

## When to Write Memory

Write memory when the knowledge meets at least one of:
- Non-obvious workaround or gotcha discovered while solving an issue
- Tool/library configuration that took effort to find or get right
- Project convention diverging from defaults (folder structure, naming, build flags)
- User preference that should persist across sessions ("always use X", "prefer Y over Z")
- Knowledge that prevents repeating a past mistake on future tasks

Do NOT write memory for:
- Restatements of well-documented framework behavior
- Information that lives clearly in the codebase (tests, types, schema files)
- One-off task details unlikely to recur

## Classification

Choose the destination by scope:

| Scope | Destination |
|-------|-------------|
| Project-specific (small project, no topic files yet) | `~/.claude/project-memory/{slug}/MEMORY.md` |
| Project-specific (topic files exist) | `~/.claude/project-memory/{slug}/{topic}.md` |
| Project topic with sub-topics accumulating | `~/.claude/project-memory/{slug}/{topic}/{sub-topic}.md` |
| Cross-project tool/library | `~/.claude/memory/tools/{name}.md` |
| Single tool with multi-file knowledge accumulating | `~/.claude/memory/tools/{name}/{sub-topic}.md` |
| Cross-cutting convention or env fact | `~/.claude/memory/general.md` |

**Split rule (uniform across scopes):** when any leaf file grows beyond ~150 lines or accumulates 3+ distinct sub-topics, split into a subfolder under the same name. Apply via the `reorganize-memory` skill — write-time logic does NOT split; it just picks the right existing target.

## Project memory modes

Project memory has two modes determined by the shape of `MEMORY.md`:

- **Single-file mode** — `MEMORY.md` contains prose `## H2` sections directly. No sibling topic files exist (or they don't matter yet). New writes append a `## H2` section to `MEMORY.md`.
- **Index mode** — `MEMORY.md` is an index table (`| File | Description | Last updated |`) plus a brief `## Quick context` intro. Topic files (`{topic}.md`) live alongside it. New writes go to the matching topic file (or create a new one); `MEMORY.md` only tracks the index.

**Detect the mode** by reading `MEMORY.md` and looking for a header row matching `| File |` and `|---|`. If present → index mode. Otherwise → single-file mode.

Default for fresh projects: single-file mode. The file graduates to index mode via `reorganize-memory` when it crosses the ~150 line / 3+ sub-topics threshold.

## Lazy Initialization

Before writing, ensure the target structure exists. Create only what's missing.

**Global init** (when writing to `~/.claude/memory/`):
1. Create `~/.claude/memory/` directory if missing
2. Create `~/.claude/memory/MEMORY.md` index from the template if missing
3. Create `~/.claude/memory/general.md` from the template if missing
4. Create `~/.claude/memory/tools/` directory if writing a tool entry

**Project init** (when writing project-scoped memory):
1. Resolve the slug: basename of `$CLAUDE_PROJECT_DIR` (or fallback to `cwd`)
2. Build the path: `~/.claude/project-memory/{slug}/`
3. Create the directory if missing
4. Create `MEMORY.md` inside it from the single-file project template if missing
5. If the project is in **index mode** and the destination is a topic file that doesn't exist yet, create it from the project topic template and add a row to the `MEMORY.md` index

All templates live in `references/templates.md`.

## Review Before Write

Search for similar existing entries before adding a new one:

1. Extract 2–3 keywords from the new entry
2. Grep `~/.claude/memory/**/*.md` (and the active project `MEMORY.md`) for those keywords
3. If a similar entry exists:
   - If outdated, propose replacement (requires confirmation — see below)
   - If still accurate, update wording or skip the new write
4. If no match found, proceed to write

## Write Format

Use richer prose with topical sections — each entry is a `## H2` heading with explanation, optional code blocks, and structured tags. This format preserves context (versions, code examples, reproduction steps) better than terse one-liners.

Example (from `tools/react.md`):

```markdown
## Compound components break Fast Refresh
*2026-05-04*

Don't attach sub-components as static properties (`Component.SubComponent = function...`). React Fast Refresh doesn't track them as proper components, so on HMR the static property gets stale while the function gets refreshed.

**Symptom:** context-consumer sub-components throw "must be used inside <Parent>" errors on HMR (parent provides new-identity context, sub still references old).

**Fix:** Use plain named exports for compound APIs:
```tsx
export function FormTabs(...) { ... }       // provider
export function FormTabsHeader(...) { ... } // not FormTabs.Header
```

**Apply:** any compound component API where HMR matters.
```

Rules:
- Use `## H2` per topic — not bullet lines or terse one-liners
- Right under each H2, include an italic date line: `*YYYY-MM-DD*` — updated whenever the section is meaningfully edited
- Include version/scope tag in heading when relevant: "(React 19)", "(HeroUI v3)", "(Supabase CLI 2.x)"
- Include code blocks for any non-trivial example or reproduction
- Use bolded structured tags as needed: `**Symptom:**`, `**Fix:**`, `**Why:**`, `**Apply:**`
- End with `**Apply:**` when the rule has a clear "use this when X" trigger — helps future reads find it fast
- The section-level date is for tracking entry recency; the file-level `Last updated` in `~/.claude/memory/MEMORY.md` covers file-level temporal tracking

## Modify Existing Entries — Confirmation Required

Before removing or modifying any existing memory entry, use the `AskUserQuestion` tool. Show:
- Current content of the entry
- Proposed change
- One-sentence rationale

Wait for explicit user confirmation before applying. This applies to:
- Editing existing entries
- Removing entries
- Renaming or moving files
- Merging entries during deduplication

Adding a brand-new entry does NOT require confirmation.

## Index Maintenance

Whenever a memory file is created, modified, or removed, update the relevant index:

- **Global** — `~/.claude/memory/MEMORY.md`
- **Project (index mode only)** — `~/.claude/project-memory/{slug}/MEMORY.md`

For each affected index:
- Add a row for new files: `| relative/path.md | one-line description | YYYY-MM-DD |`
- Update the `Last updated` column on edits
- Remove rows for deleted files

Index paths are relative to the index file's directory (e.g. `tools/zod.md` for global, `gotchas/auth.md` for project). The PreToolUse hook injects each index into every session — they must stay accurate.

In project **single-file mode** there is no index to maintain — `MEMORY.md` is the content itself.

## After-Write Promotion Eval

After completing a memory write, briefly evaluate maturity:

**Suggest `reorganize-memory`** when:
- A file just crossed ~150 lines (worth splitting into a subfolder)
- A project's `MEMORY.md` (single-file mode) has accumulated 3+ distinct topics (worth graduating to index mode)
- The index is suspected stale (rows missing or dates out of sync)

**Suggest `promote-memory`** when:
- A global `tools/{name}.md` (or `tools/{name}/`) is mature enough to ship as its own plugin/skill
- File exceeds ~150 lines of substantive content, OR has spawned a subfolder with 3+ files, OR knowledge has been referenced repeatedly across multiple sessions

Always confirm via `AskUserQuestion` before invoking either. Do not promote or reorganize without user approval.

## Workflow Summary

To write a new memory entry:

1. Classify scope (global vs project) → choose target file
2. For project writes, detect mode (single-file vs index) → route to correct file
3. Run lazy init → create missing structure (and add index row if creating a new topic file in index mode)
4. Grep for similar existing entries → dedupe, update, or skip
5. Write the entry as a `## H2` section with prose, code, and `**Apply:**` (see Write Format above)
6. Update the relevant index (global, and project if in index mode)
7. Evaluate maturity → optionally suggest `reorganize-memory` or `promote-memory`

## Additional Resources

### Reference Files

- **`references/templates.md`** — File templates for `memory.md` (global index), `general.md`, `tools/{name}.md`, and project `MEMORY.md`
