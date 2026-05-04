---
name: promote-memory
description: This skill should be used when memory accumulates enough mature knowledge to package as a plugin/skill — triggered automatically by `memory-system` after writes when promotion criteria are met, or manually when the user runs `/memory-system:promote-memory`, or asks to "promote this to a plugin", "turn this memory into a skill", "scaffold a plugin from my memory", or "extract this memory into its own plugin". Drafts plugin scaffolding from a memory file's content and replaces the source memory file with a pointer.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
argument-hint: [memory-file-path]
---

# Promote Memory

Convert a mature memory file (or subfolder) into a Claude Code plugin. Scaffold the plugin directory, draft an initial skill from the memory entries, and replace the source memory with a pointer file.

## When to Promote

Promote when at least one is true:
- File exceeds ~150 lines of substantive content (excluding headers/index rows)
- Topic has spawned a subfolder under `tools/{name}/` with 3+ sub-topic files
- Knowledge has been referenced repeatedly across recent sessions
- User explicitly requests promotion

If criteria are borderline, use `AskUserQuestion` to confirm before scaffolding.

## Steps

### 1. Identify the source

Resolve the source from the argument or context:
- Single file: `~/.claude/memory/tools/{name}.md`
- Subfolder: `~/.claude/memory/tools/{name}/`

If the argument is missing, ask the user which memory to promote.

### 2. Confirm with user

Use `AskUserQuestion` with three options:
- **Promote now** — proceed with scaffolding
- **Show me the plan first** — output proposed plugin structure, plugin.json fields, skill description, and rough skill outline; pause for approval before creating files
- **Not yet** — leave a `<!-- promotion-candidate: YYYY-MM-DD -->` HTML comment at the top of the source file and exit

### 3. Choose plugin location

Default: `~/.claude/dev/plugins/{plugin-name}/`. Ask user to override if they want a different parent dir (e.g., a Projects folder).

The location must be:
- Outside `~/.claude/memory/` (memory will be replaced by the plugin)
- A directory the user can later push to git for distribution

### 4. Scaffold plugin structure

Create:

```
{plugin-name}/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── {plugin-name}/
│       ├── SKILL.md
│       └── references/      (only if the source memory has detailed sections)
├── README.md
└── .gitignore
```

Generate `plugin.json`:
- `name` — derived from source filename (e.g., `tools/heroui-v3.md` → `heroui-v3`)
- `version` — `0.1.0`
- `description` — synthesize a one-paragraph summary from the memory's intro or first 3–5 entries
- `author` — pull from `git config user.name` / `user.email`, or ask user
- `license` — `MIT` by default; ask user if they want different
- `keywords` — derive 3–5 keywords from entry topics

### 5. Draft the skill from memory content

Convert the memory file into `skills/{plugin-name}/SKILL.md`:

**Frontmatter description** — third-person with concrete trigger phrases derived from the topic and entries. Example for `heroui-v3.md`: `"This skill should be used when the user works with HeroUI v3 components, asks about Modal/Tooltip/ComboBox patterns, or hits compound component issues..."`

**Body** — convert memory's prose sections into structured procedural guidance:
- Promote `## H2` topics to skill headings or merge related ones
- Convert prose + `**Symptom/Fix/Why/Apply:**` tags into imperative instructions: *"Wrap Modal content with `<ModalContent>` because compound children cannot render outside the wrapper"*
- Preserve code snippets and command examples verbatim
- Use imperative form throughout (no second person)

Target length: ≤2,000 words. If the source memory has more substantive content, move detail into `references/{topic}.md` and reference from SKILL.md.

### 6. Generate README

Minimal README:

```markdown
# {plugin-name}

{one-line description}

## Install

`/plugin marketplace add <repo-url>` then `/plugin install {plugin-name}@<marketplace>`

## What it does

{paragraph describing the skill and when it triggers}

## Origin

Promoted from a memory file on YYYY-MM-DD.
```

### 7. Replace source memory with a pointer

Overwrite the source file (or `tools/{name}/overview.md` for a subfolder) with the pointer template from `memory-system`'s `references/templates.md`:

```markdown
# {Topic}

Promoted to plugin: `{plugin-path}` on YYYY-MM-DD.

When this knowledge needs an update, propose changes in the plugin repo.
Do not edit this pointer file.
```

For a subfolder source: keep the sub-topic files but add this pointer at `tools/{name}/overview.md`. If the user prefers a clean slate, ask whether to delete the sub-topic files.

Update `~/.claude/memory/memory.md`:
- Update the description column to mark the file as a pointer (e.g., `→ promoted to plugin {name}`)
- Refresh `Last updated`
- Do not remove the row — future sessions need to know the topic exists

### 8. Validate the new plugin

If the `plugin-validator` agent is available (ships with the `plugin-dev` plugin), run it on the scaffolded plugin to catch structural issues. If unavailable, perform a manual sanity check: verify `plugin.json` parses, `SKILL.md` has frontmatter, and the directory structure matches the plugin spec.

### 9. Final report

Output:
- Plugin location
- Skill word count
- Number of memory entries converted
- Validator result
- Next steps: review SKILL.md, `git init` the plugin dir, add to a marketplace for distribution

## Edge Cases

- **Source has both stable and in-flux entries** — promote the stable ones into the plugin, leave in-flux entries in a slimmed-down memory file (don't fully replace with a pointer)
- **Topic spans multiple memory files** — ask the user whether to promote them as one combined plugin or as separate plugins
- **No git config available** — leave `author` blank with a `// TODO` comment; user fills in before publishing
- **User has no homepage yet** — leave `homepage` field out of plugin.json; can be added later
