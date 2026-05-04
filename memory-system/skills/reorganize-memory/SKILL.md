---
name: reorganize-memory
description: This skill should be used when the user runs `/memory-system:reorganize-memory` or asks to "reorganize memory", "clean up memory", "dedupe memory", "audit memory files", or "consolidate memory entries". Audits all memory files (`~/.claude/memory/` and the active project's full memory tree under `~/.claude/project-memory/{slug}/`), identifies duplicates, outdated entries, misclassified entries, files needing split or merge, project memory mode graduation, and stale index rows. Presents a single consolidated reorganization plan in plan mode for one-shot approval before any file is modified.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, EnterPlanMode, ExitPlanMode, AskUserQuestion
argument-hint: (no arguments)
---

# Reorganize Memory

Audit and reorganize the structured memory layer. Produce a single plan-mode proposal covering every change. Apply changes only after the plan is approved.

## Scope

Files in scope:
- `~/.claude/memory/MEMORY.md` (the global memory index)
- `~/.claude/memory/general.md`
- `~/.claude/memory/tools/**/*.md`
- The active project's full memory tree: `~/.claude/project-memory/{slug}/**/*.md` (the `MEMORY.md` plus any sibling topic files and subfolders)

## Steps

### 1. Read all memory files

Use Glob to enumerate, then Read each file. Do not rely solely on the index — the index may be stale relative to the disk.

### 2. Build the audit list

Identify these issues. For each, record file paths, line ranges, and a one-line rationale.

**Duplicates**
- Same fact repeated across multiple files
- Near-duplicates where one entry can subsume another

**Outdated entries**
- Entries referencing tool/library versions superseded by newer entries
- Entries describing bugs/limitations that have been resolved

**Misclassified entries**
- Tool-specific knowledge sitting in `general.md` that belongs in `tools/`
- Cross-project knowledge in a project `MEMORY.md` that should promote to global

**Files that should split** (uniform across global + project scope)
- Any leaf topic file exceeding ~150 lines or covering 3+ distinct sub-topics
- Global: `tools/{name}.md` → `tools/{name}/{sub-topic}.md`
- Project: `{topic}.md` → `{topic}/{sub-topic}.md`

**Project memory mode graduation** (single-file → index mode)
- Project `MEMORY.md` (single-file mode, prose content) exceeding ~150 lines or 3+ distinct topics
- Plan: split each `## H2` into a topic file (named after a slug of the heading), rewrite `MEMORY.md` as the index format from `references/templates.md` plus a `## Quick context` section curated from the original intro
- Detection: single-file mode = no `| File | ... |` index table header in `MEMORY.md`

**Files that should merge**
- Two small files covering the same topic from different angles

**Index issues** (apply to global `MEMORY.md` and project `MEMORY.md` when in index mode)
- Files present on disk but missing from the index
- Index rows pointing to deleted files
- Stale `Last updated` dates

**Sort issues**
- Entries within a file out of chronological order (oldest first → newest last)

### 3. Compose the reorganization plan

Build a single plain bullet list — one line per proposed change. Use this format:

```
- DEDUPE   general.md L42-44 ↔ tools/react.md L7-9 — same React 19 ref fact → keep tools/react.md, remove general.md entry
- SPLIT    tools/supabase.md (180 lines) → tools/supabase/migrations.md, tools/supabase/auth.md, tools/supabase/local-dev.md
- MERGE    tools/css-stacking.md + tools/css-isolation.md → tools/css.md
- MOVE     general.md L60-62 (zod gotcha) → tools/zod.md
- SORT     tools/react.md — entries out of chronological order
- INDEX    add row for tools/zod.md (file exists, not in index)
- INDEX    remove row for tools/old-tool.md (file deleted)
- INDEX    refresh `Last updated` for tools/supabase.md
- GRADUATE project-memory/{slug}/MEMORY.md (210 lines, single-file mode) → index mode: split H2 sections into architecture.md, conventions.md, gotchas.md; rewrite MEMORY.md as index + quick-context
- SPLIT    project-memory/{slug}/gotchas.md (160 lines) → gotchas/auth.md, gotchas/perf.md
- INDEX    project-memory/{slug}/MEMORY.md — add row for gotchas/auth.md
```

Format: `ACTION  target  — rationale`. No prose, no nested bullets, no preamble. The list must be scannable and approvable in one pass.

### 4. Enter plan mode

Call `EnterPlanMode` with the bullet list as the plan. The user reviews and either approves, rejects, or asks for adjustments. Do not modify any file before the plan is approved.

If the audit produced zero issues, skip plan mode and report "Memory is clean — no changes proposed."

### 5. Apply changes after approval

Once the plan is approved (`ExitPlanMode` succeeds):
- Apply changes file by file
- For DEDUPE/MOVE/MERGE that modify or remove existing entries: trust the approved plan, apply directly (the plan was the confirmation)
- For GRADUATE: split the prose `MEMORY.md` into topic files using the project topic template, then rewrite `MEMORY.md` using the project index template (preserving relevant intro content under `## Quick context`)
- Update affected indexes after all file changes are done — global `~/.claude/memory/MEMORY.md`, and project `MEMORY.md` when the project is in index mode
- Refresh `Last updated` on every modified file

### 6. Final report

After applying, output a one-paragraph summary:
- Count of dedupes, splits, merges, moves, sort fixes, index updates
- Any items skipped or partially applied (with reason)

## Edge Cases

- **Empty memory directory** — exit early with "No memory to reorganize"
- **Index missing** — generate it from disk before proposing changes (still as part of the plan)
- **Pointer files** (memory promoted to plugins) — leave pointer files untouched; do not propose changes to them
- **File modified mid-task** — if a file's mtime is newer than the audit start, abort and ask user to re-run

## Notes

- Promotion of memory to plugins is handled separately by the `promote-memory` skill — do not propose promotion as part of reorganization
- The audit phase is read-only. Writes happen only after plan approval.
