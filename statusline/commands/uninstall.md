---
description: Remove this plugin's statusline configuration. Restores any prior statusline from backup if /statusline:install made one.
---

You are running the uninstall routine for the statusline plugin. The user invoked this via `/statusline:uninstall`. Be brief.

## Steps

1. **Read `~/.claude/settings.json`.** If it doesn't exist, report "no settings.json — nothing to uninstall" and exit.

2. **Check `statusLine.command`:**

   - **Not set** → report "not installed; nothing to do".
   - **Doesn't point at this plugin** (command is something other than `node <this-plugin-root>/statusline.mjs`) → report "settings.json statusLine doesn't point at this plugin — leaving it alone" and exit. Do not modify.
   - **Points at this plugin** → proceed.

3. **Check for a backup at `~/.claude/settings.status-line-backup.json`:**

   - **If the backup exists:** read it (JSON). Replace the `statusLine` key in settings.json with the backup's contents. Delete the backup file. Use `Edit` for settings.json.
   - **If no backup:** remove the `statusLine` key from settings.json entirely. Use `Edit`.

4. **Confirm.** One line: either "restored prior statusline from backup" or "statusLine key removed". Tell the user: "Restart your session for the change to take effect."

## Constraints

- Never delete or rewrite keys other than `statusLine` in settings.json.
- If you can't read the backup (corrupt JSON, etc.), report the error and stop — don't fall back to removing the key (that loses the prior config silently).
