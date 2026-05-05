---
disabled: false
---

# memory-system per-project config

Drop this file at `.claude/memory-system.local.md` in any project to override default plugin behavior in that project.

## Fields

- `disabled` (boolean, default `false`) — when `true`, the PreToolUse hook skips memory injection in this project. Useful for sandbox repos where global memory context isn't relevant.
- `project_slug` (string, default auto-detected) — pin the project memory slug for this folder regardless of cwd or repo layout. Auto-detection (the 5-step chain — see README) works for most layouts; this override is for cases where you want explicit control (e.g. forcing a sub-project to scope into the parent's memory, or two folders that should share memory under a custom name).

## Notes

- This file is project-local. Add `.claude/*.local.md` to the project's `.gitignore` to keep it out of version control.
- Changes take effect on the next tool call (no session restart needed — the hook reads this file fresh each invocation).
