/**
 * @file memory-system statusline signal helpers.
 *
 * One signal file at `~/.claude/cache/memory-system/statusline.txt`, three
 * writers contribute:
 *
 *   1. SessionStart (`inject-on-session-start.mjs`) — writes `🧠 [<slug>]`
 *      once at session boot so the bar shows the active project slug from
 *      turn 1.
 *   2. PreToolUse (`inject-memory.mjs`) — calls `ensureSlugSignal` on every
 *      tool call. No-op if the existing signal is fresh AND already shows
 *      the current slug (preserves the auditor's `wrote` line, which itself
 *      contains `[<slug>]`). Otherwise refreshes to `🧠 [<slug>]`.
 *   3. Auditor (`memory_auditor/worker.mjs`) — writes
 *      `🧠 [<slug>] wrote <path>` after a successful audit. That line
 *      eclipses the slug-only one until the statusline's 60s TTL drops it,
 *      at which point the next PreToolUse refreshes back to slug-only.
 *
 * Skip outcomes from the auditor leave the file alone — the slug-only
 * signal stays visible.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, ".claude");
const STATE_DIR = path.join(CLAUDE_HOME, "cache", "memory-system");
export const STATUSLINE_FILE = path.join(STATE_DIR, "statusline.txt");
export const MEMORY_ROOT = path.join(CLAUDE_HOME, "memory");
export const PROJECT_MEMORY_ROOT = path.join(CLAUDE_HOME, "project-memory");

// Match statusline plugin's TTL so "fresh and showing slug" lines up with
// "fresh enough that the consumer is still rendering it".
const SIGNAL_TTL_SECONDS = 60;

/**
 * Atomic write of the statusline signal file. Best-effort — never throws.
 * @param {string} text
 * @param {string} [target]
 */
export function writeStatuslineSignal(text, target = STATUSLINE_FILE) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

/**
 * Convert an auditor `wrote:` action line into a short statusline-friendly
 * signal — e.g. `🧠 [claude-plugins] wrote tools/postgres.md`.
 *
 * The bracketed slug tells the reader which session/project triggered the
 * audit. For global writes (`tools/x.md`) the path alone doesn't reveal
 * the active project, so the prefix carries the context. For project-memory
 * writes the slug also appears inside the path — the prefix is mildly
 * redundant there but worth the consistency.
 *
 * Returns null for any non-`wrote:` action (skip lines, blank, malformed)
 * so the caller leaves the existing signal file alone.
 *
 * @param {string} actionLine
 * @param {string} slug
 * @param {{ memoryRoot?: string, projectMemoryRoot?: string }} [opts]
 * @returns {string | null}
 */
export function formatStatuslineSignal(actionLine, slug, opts = {}) {
  if (!actionLine) return null;
  const memoryRoot = opts.memoryRoot ?? MEMORY_ROOT;
  const projectMemoryRoot = opts.projectMemoryRoot ?? PROJECT_MEMORY_ROOT;

  const m = actionLine.match(/^wrote:\s+([^\s,]+)/);
  if (!m) return null;
  const fullPath = m[1];

  /** @param {string} root */
  const stripPrefix = (root) => {
    for (const sep of [path.sep, "/"]) {
      const prefix = root + sep;
      if (fullPath.startsWith(prefix)) return fullPath.slice(prefix.length);
    }
    return null;
  };

  const display =
    stripPrefix(memoryRoot) ?? stripPrefix(projectMemoryRoot) ?? path.basename(fullPath);
  // Normalize to forward slashes so the statusline reads the same on Windows.
  const pretty = display.replace(/\\/g, "/");
  const prefix = slug ? `[${slug}] ` : "";
  return `🧠 ${prefix}wrote ${pretty}`;
}

/**
 * Render the slug-only signal: `🧠 [<slug>]`. Returns null when slug is
 * empty so callers can skip writing a meaningless `🧠 []`.
 *
 * @param {string} slug
 * @returns {string | null}
 */
export function formatSlugOnlySignal(slug) {
  if (!slug) return null;
  return `🧠 [${slug}]`;
}

/**
 * Decide whether a slug-only refresh should overwrite the existing signal.
 *
 * Pure function: takes the current file's content + age, returns true if
 * the caller should write `🧠 [<slug>]`. Refresh when:
 *   - File is absent or unreadable (content === null)
 *   - File is older than the statusline's TTL (already invisible)
 *   - File doesn't reference the current slug (project switched, or the
 *     signal came from a stale concurrent session)
 *
 * Skip when the file is fresh AND already mentions the current slug — that
 * covers both "already shows slug-only" and "shows the auditor's `wrote`
 * line, which contains the same `[<slug>]`".
 *
 * @param {{ content: string | null, ageSeconds: number, slug: string }} args
 * @returns {boolean}
 */
export function shouldRefreshSlugSignal({ content, ageSeconds, slug }) {
  if (!slug) return false;
  if (content === null) return true;
  if (ageSeconds > SIGNAL_TTL_SECONDS) return true;
  return !content.includes(`[${slug}]`);
}

/**
 * Refresh the slug-only signal if needed. Preserves recent auditor `wrote`
 * lines (they contain `[<slug>]`, so the freshness + slug-match guard
 * leaves them alone).
 *
 * @param {string} slug
 * @param {{ target?: string, now?: number }} [opts]
 */
export function ensureSlugSignal(slug, opts = {}) {
  if (!slug) return;
  const target = opts.target ?? STATUSLINE_FILE;
  const now = opts.now ?? Date.now();

  /** @type {string | null} */
  let content = null;
  let ageSeconds = Infinity;
  try {
    const stat = fs.statSync(target);
    ageSeconds = (now - stat.mtimeMs) / 1000;
    content = fs.readFileSync(target, "utf-8");
  } catch {
    // missing/unreadable — content stays null, age stays Infinity
  }

  if (!shouldRefreshSlugSignal({ content, ageSeconds, slug })) return;
  const text = formatSlugOnlySignal(slug);
  if (text) writeStatuslineSignal(text, target);
}
