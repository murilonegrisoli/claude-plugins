# statusline

A Claude Code statusline renderer that ships a useful baseline (context window + 5h/7d rate-limit progress bars) and aggregates signals from any other plugin that follows the file-based signal convention.

## Install

```
/plugin marketplace add https://github.com/murilonegrisoli/claude-plugins
/plugin install statusline@negrisoli
/reload-plugins
/statusline:install
```

`/statusline:install` configures `~/.claude/settings.json` for you. If you already have a custom `statusLine.command`, it asks via `AskUserQuestion` whether to skip, replace, or backup-and-replace. If you pick backup, your prior config is saved to `~/.claude/settings.status-line-backup.json` and `/statusline:uninstall` will restore it later.

Restart your Claude Code session after install to see the new line render.

## What gets rendered

```
Ctx ████░░░░░░ 41%  5h ██░░░░░░░░ 22%  7d █░░░░░░░░░ 12%  🧠 wrote tools/postgres.md
```

Three baseline segments (always rendered when Claude Code provides the data):

- `Ctx` — context window used %
- `5h` — 5-hour rate limit used %
- `7d` — 7-day rate limit used %

After the baseline, any plugin signals collected from `~/.claude/cache/*/statusline.txt`.

## Signal convention (for plugin authors)

If you're building a Claude Code plugin and want to surface a status indicator, drop a single-line text file at:

```
~/.claude/cache/<your-plugin-name>/statusline.txt
```

Rules:

- **Plain text, single line.** Multi-line content is collapsed to one line on display.
- **UTF-8.** ANSI escape codes for colors/styling are allowed and passed through.
- **Atomic write.** Use `fs.renameSync(tmp, target)` (`os.replace` in Python) to avoid torn reads. The renderer reads on every tick.
- **Stale TTL: 60 seconds.** If the file's mtime is older than 60s, the renderer drops it. Touch it on every relevant event to keep it visible; let it go stale to make it disappear (e.g. when a long-running task finishes).
- **Length budget: ~200 chars.** Longer signals get truncated with an ellipsis to protect the line layout.
- **Ordering:** signals render alphabetically by plugin folder name. (Configurable per-project ordering is planned.)

Missing files are skipped silently — there's no registration step. To remove your signal, either delete the file or let it go stale.

### Example: writing a signal from a plugin hook

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".claude", "cache", "my-plugin");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "statusline.txt");
const tmp = file + ".tmp";
fs.writeFileSync(tmp, "🚀 deploying to staging");
fs.renameSync(tmp, file);
```

## Uninstall

```
/statusline:uninstall
```

If `/statusline:install` made a backup, this restores it. Otherwise it removes the `statusLine` key from `~/.claude/settings.json`.

## Prerequisites

- Node 18+ on PATH. The renderer is a pure-stdlib `.mjs` file (no dependencies, no build step).

## License

MIT — see the [root LICENSE](../LICENSE).
