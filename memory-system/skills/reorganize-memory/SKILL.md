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

**Project memory mode graduation** (three levels)

Projects evolve through three layouts as their memory grows:

1. **Single-file mode** — `MEMORY.md` is prose with `## H2` topics. Default for fresh / small projects.
2. **Flat-index mode** — `MEMORY.md` is the `| File | ... |` index table. Topic files (`{topic}.md`) live alongside it at the project root. Default after first GRADUATE.
3. **Categorized-index mode** — `MEMORY.md` is the index table with category-prefixed paths. Topic files live in category subfolders (`{category}/{topic}.md`). For projects past ~30 topic files where flat layout is overwhelming.

**GRADUATE (single-file → flat-index)**
- Trigger: project `MEMORY.md` (single-file mode, prose content) exceeds ~150 lines or 3+ distinct topics
- Detection: single-file mode = no `| File | ... |` index table header in `MEMORY.md`
- Plan: split each `## H2` into a topic file (named after a slug of the heading), rewrite `MEMORY.md` as the flat-index template plus a `## Quick context` section curated from the original intro

**GRADUATE-LEVEL-2 (flat-index → categorized-index)**
- Trigger: flat-index project has 30+ topic files at root, or topics naturally cluster into 3+ distinct domains
- Detection: count `.md` files (excluding MEMORY.md) at the project root; check whether their topic names suggest natural clustering (architecture/ui/data/auth/etc.)
- Plan: propose category subfolders (`architecture/`, `ui/`, `data/`, etc. — chosen by inspecting the topic content, NOT a fixed taxonomy), assign each existing topic file to a category, rewrite `MEMORY.md` index with nested paths
- Categories are project-specific. The agent proposes; the user approves/edits in plan mode.

**MIGRATE-LEGACY-PROJECT** (pre-memory-system layout → modern)
- Trigger: project memory dir contains files matching `^(feedback|project|reference)_.*\.md$` OR topic files with YAML frontmatter `type: (feedback|project|reference)`
- Detection: glob the project dir for legacy-named files; parse frontmatter on each topic file
- Plan: per file:
  1. Rename: strip prefix + kebab-case the rest (`project_page_chrome.md` → `page-chrome.md`, `feedback_admin_tenant_scope.md` → `admin-tenant-scope.md`)
  2. Strip frontmatter: drop `type` and `originSessionId`; preserve `name` + `description`
  3. Add canonical header: `# {name}` H1 + `*{file mtime YYYY-MM-DD}*` italic date line under it
  4. If frontmatter `description` adds context not in the body, insert as intro paragraph between the date and existing content
- Per slug:
  5. Rewrite `MEMORY.md` as the canonical flat-index table format (or categorized-index if there are 30+ files) with `description` from frontmatter and mtime as `Last updated`
- Collisions: if two legacy files map to the same target name (e.g. `feedback_caching.md` + `project_caching.md` → `caching.md`), surface during plan mode — user picks merge or disambiguates with `-feedback`/`-project` suffix
- Orphans: files not referenced in legacy `MEMORY.md` are still migrated, flagged separately. Backlinks in legacy `MEMORY.md` pointing to missing files are flagged as dead links and dropped from the new index.

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
- GRADUATE-LEVEL-2 project-memory/{slug}/ (42 flat topic files) → categorized: architecture/, ui/, data/, auth/, permissions/, features/; reorganize MEMORY.md index with nested paths
- MIGRATE  project-memory/adapta-crm/ (42 legacy `feedback_*`/`project_*` files) → strip prefix + kebab-case rename, strip frontmatter, add canonical headers + date lines, rewrite MEMORY.md as flat-index (or categorized-index if files cluster naturally)
```

Format: `ACTION  target  — rationale`. No prose, no nested bullets, no preamble. The list must be scannable and approvable in one pass.

### 4. Enter plan mode

Call `EnterPlanMode` with the bullet list as the plan. The user reviews and either approves, rejects, or asks for adjustments. Do not modify any file before the plan is approved.

If the audit produced zero issues, skip plan mode and report "Memory is clean — no changes proposed."

### 5. Apply changes after approval

**Pre-apply consistency check (REQUIRED — guards against parallel-write content loss):**

Before any destructive operation (delete, rename, MIGRATE, GRADUATE), re-scan the affected directories and compare against the audit-phase snapshot. Apply behavior depends on what changed:

- **An audited file was modified since the audit** (mtime newer than audit start) → ABORT. Someone edited a file we planned to change; can't safely proceed without re-auditing. Message: `"File modified during planning: {path}. Re-run /memory-system:reorganize-memory to refresh the plan."`
- **A new file matching the migration's source patterns appeared** (e.g. a new `feedback_*`/`project_*`/`reference_*` file during MIGRATE-LEGACY-PROJECT) → PRESERVE the new file (do NOT delete or sweep it). Append to a "preserved" list to report after apply completes. No content loss — file stays at its original location for manual handling next reorganize pass.
- **An audited file disappeared since the audit** (someone deleted it) → SKIP that file's planned operations, append to a "skipped" list with reason. Do not abort the whole apply.
- **A new file that does NOT match any migration source pattern appeared** → IGNORE entirely. It's irrelevant to the planned ops.

Why these rules: the v0.3.4 no-cooldown auditor fires on every Stop event, so during a multi-minute reorganize apply, parallel writes to the same project memory directory are EXPECTED. A blanket abort-on-any-change would prevent reorganize from ever completing on active projects. The targeted approach: hard-abort only on the one case where we'd lose work (concurrent edit of an in-flight file), preserve new appearances rather than sweeping them.

Real bug this guards against (v0.3.4 dev): during adapta-crm reorganize, parallel auditor wrote two new `project_*` files between inventory and apply. They matched the legacy-cleanup pattern, got swept by the apply's delete sweep, and weren't in the migration plan — content lost. Under the new rules, those two files would be PRESERVED at root and reported at the end.

Once the consistency check completes (with possible PRESERVE/SKIP additions to the plan), proceed with the file-by-file apply:
- Apply changes file by file
- For DEDUPE/MOVE/MERGE that modify or remove existing entries: trust the approved plan, apply directly (the plan was the confirmation)
- For GRADUATE: split the prose `MEMORY.md` into topic files using the project topic template, then rewrite `MEMORY.md` using the project index template (preserving relevant intro content under `## Quick context`)
- For GRADUATE-LEVEL-2: create category subfolders, move topic files into them, rewrite `MEMORY.md` index with nested paths (`{category}/{topic}.md` rows)
- For MIGRATE: rename legacy files in lockstep — old path → new path, strip frontmatter, prepend `# {name}` + `*{date}*` header. After all topic files are migrated, rewrite `MEMORY.md` from scratch as the canonical index. Preserve any orphaned content from the legacy `MEMORY.md` body under `## Quick context`.
- Update affected indexes after all file changes are done — global `~/.claude/memory/MEMORY.md`, and project `MEMORY.md` when the project is in index mode
- Refresh `Last updated` on every modified file

### 6. Final report

After applying, output a one-paragraph summary:
- Count of dedupes, splits, merges, moves, sort fixes, index updates
- Any items skipped or partially applied (with reason)
- Any files PRESERVED from the pre-apply consistency check (new files that appeared during apply) — list paths so the user can re-run reorganize to fold them in

## Edge Cases

- **Empty memory directory** — exit early with "No memory to reorganize"
- **Index missing** — generate it from disk before proposing changes (still as part of the plan)
- **Pointer files** (memory promoted to plugins) — leave pointer files untouched; do not propose changes to them
- **File modified or appeared mid-task** — handled by the pre-apply consistency check in step 5. Abort and ask user to re-run /memory-system:reorganize-memory.

## Notes

- Promotion of memory to plugins is handled separately by the `promote-memory` skill — do not propose promotion as part of reorganization
- The audit phase is read-only. Writes happen only after plan approval.
