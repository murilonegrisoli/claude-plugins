# Memory File Templates

Use these templates when lazy-init creates a missing memory file. Replace `{placeholders}` with concrete values.

---

## Global memory index — `~/.claude/memory/MEMORY.md`

```markdown
# Memory Index

Read this file at session start. Load specific topic files only when relevant.

| File | Description | Last updated |
|------|-------------|--------------|
| `general.md` | Cross-project conventions, environment facts, miscellaneous | YYYY-MM-DD |

## How this works

This index plus topic files in `tools/` are auto-injected on the first tool call of every session (including subagents) by the `memory-system` plugin's PreToolUse hook. Don't re-Read these files mid-session — they're already in context.

## Update rule

Whenever a global memory file is created, modified, or removed:
- Add, update, or remove the corresponding row above
- Update the `Last updated` column on edits
```

---

## General memory — `~/.claude/memory/general.md`

```markdown
# General — Cross-Project Conventions

Cross-project conventions, environment facts, and miscellaneous rules that don't belong to a specific tool/library. Each rule is a `## H2` section with prose explanation and (when useful) `**Why:**` and `**Apply:**` tags.

## Example Rule

(Populated as conventions accumulate)
```

---

## Tool memory — `~/.claude/memory/tools/{name}.md`

```markdown
# {Tool Name} — {short scope description}

Notes for working with {Tool Name}. Each topic is a `## H2` section with an italic date line (`*YYYY-MM-DD*`) directly under the heading, prose explanation, optional code blocks, and structured tags (`**Symptom:**`, `**Fix:**`, `**Why:**`, `**Apply:**`). Include version/scope tags in headings when relevant — e.g. "(React 19)", "(HeroUI v3)".

## Example Topic ({version/scope})
*YYYY-MM-DD*

(Populated as knowledge accumulates)
```

When the file grows beyond ~150 lines or accumulates 3+ distinct sub-topics, split into a subfolder:

```
tools/{name}/
├── overview.md      # high-level summary, points to sub-topic files
├── {sub-topic-1}.md
└── {sub-topic-2}.md
```

---

## Tool subfolder overview — `~/.claude/memory/tools/{name}/overview.md`

```markdown
# {Tool Name}

This tool's memory has been split into sub-topic files. See:

- `{sub-topic-1}.md` — one-line description
- `{sub-topic-2}.md` — one-line description

Add new sub-topic files as the knowledge accumulates.
```

---

## Project memory — single-file mode

The slug is the basename of the project's working directory. The `memory-system` plugin's PreToolUse hook resolves this path automatically and lazy-creates the directory + file when the first project memory write happens.

`~/.claude/project-memory/{slug}/MEMORY.md`:

```markdown
# {Project Name} — Project Memory

Project-specific knowledge: state, decisions, conventions, references. For cross-project knowledge see `~/.claude/memory/`.

Each topic is a `## H2` section with prose explanation, optional code, and structured tags (`**Why:**`, `**Apply:**`). For project state notes, dates can be useful — include them inline in the body when they matter.

## Example Topic

(Populated as work in this project produces non-obvious knowledge)
```

When this file crosses ~150 lines or accumulates 3+ distinct topics, `reorganize-memory` graduates it to **index mode** — see below.

---

## Project memory — index mode

After graduation, `MEMORY.md` becomes the index plus a brief quick-context intro. Topic files live alongside it.

`~/.claude/project-memory/{slug}/MEMORY.md` (index):

```markdown
# {Project Name} — Project Memory

| File | Description | Last updated |
|------|-------------|--------------|
| `architecture.md` | Tech stack, layout, key decisions | YYYY-MM-DD |
| `gotchas.md` | Project-specific footguns | YYYY-MM-DD |

## Quick context

(One short paragraph: repo URL, current state, what makes this project distinct. Keep it under ~10 lines — anything longer belongs in a topic file.)

## Update rule

Whenever a project memory file is created, modified, or removed:
- Add, update, or remove the corresponding row above
- Update the `Last updated` column on edits
```

---

## Project topic file — `~/.claude/project-memory/{slug}/{topic}.md`

```markdown
# {Project Name} — {topic}

{One-line scope description.}

Each topic is a `## H2` section with prose explanation, optional code blocks, and structured tags (`**Symptom:**`, `**Fix:**`, `**Why:**`, `**Apply:**`). Italic date line `*YYYY-MM-DD*` directly under each heading.

## Example Topic
*YYYY-MM-DD*

(Populated as knowledge accumulates)
```

When this file crosses ~150 lines or accumulates 3+ distinct sub-topics, split into a subfolder under `{topic}/` (same rule as global tool files).

---

## Pointer file (after promotion to plugin)

When a memory file is promoted to a plugin via the `promote-memory` skill, replace its contents with:

```markdown
# {Topic}

Promoted to plugin: `{plugin-path}` on YYYY-MM-DD.

When this knowledge needs an update, propose changes in the plugin repo.
Do not edit this pointer file.
```

The row in `memory.md` should remain (so future sessions know the topic still exists), but its description column should indicate it's now a pointer.
