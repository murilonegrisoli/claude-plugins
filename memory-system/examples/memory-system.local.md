---
disabled: false
---

# memory-system per-project config

Drop this file at `.claude/memory-system.local.md` in any project to override default plugin behavior in that project.

## Fields

- `disabled` (boolean, default `false`) — when `true`, the PreToolUse hook skips memory injection in this project. Useful for sandbox repos where global memory context isn't relevant.

## Notes

- This file is project-local. Add `.claude/*.local.md` to the project's `.gitignore` to keep it out of version control.
- Changes take effect on the next tool call (no session restart needed — the hook reads this file fresh each invocation).
