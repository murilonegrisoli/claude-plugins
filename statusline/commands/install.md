---
description: Configure ~/.claude/settings.json to use this plugin's statusline. Backs up any existing statusline command.
---

You are running the install routine for the statusline plugin. The user invoked this via `/statusline:install`. Be brief — confirm actions, don't lecture.

## Steps

1. **Determine the renderer command.** The plugin lives at `${CLAUDE_PLUGIN_ROOT}`. The renderer is `${CLAUDE_PLUGIN_ROOT}/statusline.mjs`. The full command we want to install is exactly:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/statusline.mjs
   ```

   Resolve `${CLAUDE_PLUGIN_ROOT}` to its absolute value before writing settings.json (use `Bash` with `echo "$CLAUDE_PLUGIN_ROOT"` if you need the literal string). settings.json takes a literal path, not a variable.

2. **Read `~/.claude/settings.json`.** If the file doesn't exist, treat it as `{}`.

3. **Decide the action based on the existing `statusLine` config:**

   - **Not configured** (no `statusLine` key, or `statusLine.command` unset) → install fresh. Skip to step 5.
   - **Already pointing at this plugin** (command is `node <plugin-root>/statusline.mjs` for the same plugin root) → report "already installed" and exit.
   - **Pointing at something else** → ask the user via `AskUserQuestion`. Present:
     - Their current command: `<current value>`
     - Proposed new command: `node <resolved-plugin-root>/statusline.mjs`
     - Three options:
       - `Backup and replace` — save current `statusLine` config to `~/.claude/settings.status-line-backup.json`, then install ours (recommended)
       - `Replace without backup` — overwrite, lose the existing config
       - `Skip` — leave settings.json unchanged

4. **If the user picked Skip**, exit without writing anything. Report "left unchanged".

5. **If the user picked Backup and replace** (or this is a fresh install with no prior config), write the full prior `statusLine` object to `~/.claude/settings.status-line-backup.json` as JSON. (For fresh installs there's nothing to back up — skip this.)

6. **Write the updated settings.json:** preserve all other keys, set `statusLine.command` to the resolved absolute command. Use `Edit` if the file exists; `Write` if creating it fresh.

7. **Confirm.** One line per action you took. Then tell the user: "Restart your Claude Code session to see the new statusline render."

## Constraints

- Never delete or rewrite keys other than `statusLine` in settings.json.
- Never invent values — if the user has a non-standard `statusLine.padding` or `statusLine.type`, preserve those untouched.
- If something fails (e.g. permission error writing settings.json), report the error directly and stop.
