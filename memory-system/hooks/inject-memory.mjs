#!/usr/bin/env node
/**
 * @file memory-system PreToolUse hook.
 *
 * Inject project MEMORY.md and the global memory index into the session
 * context at session-relevant boundaries:
 *
 *   1. The very first tool call of a session (covers the main session).
 *   2. Any tool call that immediately follows an `Agent` tool call (covers
 *      subagent sessions, which inherit the parent's session_id and so
 *      can't be distinguished by id alone — we use the `Agent` boundary
 *      as a proxy).
 *   3. Any tool call where the resolved slug changed mid-session (e.g.
 *      cd into a plugin subfolder, or recent file activity shifted focus).
 *   4. Any tool call where a watched memory file's mtime is newer than the
 *      session's last inject — covers the case where memory was written
 *      mid-session (by this session, a concurrent session, or the user)
 *      and would otherwise stay stale until the next session.
 *
 * Subsequent tool calls in the same flow stay silent so the additionalContext
 * isn't re-emitted on every Read/Bash/Edit.
 *
 * Output: JSON with `hookSpecificOutput.additionalContext` on stdout. Always
 * exits 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSlug } from "./slug.mjs";
import { ensureSlugSignal } from "./statusline-signal.mjs";

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, ".claude");
const GLOBAL_INDEX = path.join(CLAUDE_HOME, "memory", "MEMORY.md");
const PROJECT_MEMORY_ROOT = path.join(CLAUDE_HOME, "project-memory");
const STATE_DIR = path.join(CLAUDE_HOME, "cache", "memory-system");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export const SESSION_TTL_SECONDS = 7 * 86400;

/** @returns {Record<string, unknown>} */
function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
function readTextSafe(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** @param {string} cwd */
export function isDisabledForProject(cwd) {
  const config = path.join(cwd, ".claude", "memory-system.local.md");
  if (!isFile(config)) return false;
  const content = readTextSafe(config);
  if (content === null) return false;
  let inFm = false;
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (s === "---") {
      if (inFm) break;
      inFm = true;
      continue;
    }
    if (inFm && s.startsWith("disabled:")) {
      const val = s.split(":", 2)[1]?.trim().toLowerCase();
      return val === "true" || val === "yes" || val === "1";
    }
  }
  return false;
}

/**
 * @typedef {{
 *   first_seen?: string,
 *   first_seen_epoch?: number,
 *   last_seen_epoch?: number,
 *   last_inject_epoch?: number,
 *   pending_inject_epoch?: number,
 *   last_was_agent?: boolean,
 *   last_slug?: string,
 * }} SessionInfo
 * @typedef {{ sessions: Record<string, SessionInfo> }} State
 *
 * Two-phase inject state (v0.4.1+):
 * - `pending_inject_epoch` is set in PreToolUse when we emit additionalContext
 * - `last_inject_epoch` is set in PostToolUse (`confirm-inject.mjs`) once
 *   the tool actually ran. PostToolUse does not fire when the user rejects
 *   the tool at the permission prompt, so a rejected tool leaves the state
 *   "unconfirmed" and the next PreToolUse re-injects.
 */

/**
 * @param {string} [stateFile]
 * @returns {State}
 */
export function loadState(stateFile = STATE_FILE) {
  if (!isFile(stateFile)) return { sessions: {} };
  const raw = readTextSafe(stateFile);
  if (raw === null) return { sessions: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
    return { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

/**
 * @param {State} state
 * @param {string} [stateFile]
 */
export function saveState(state, stateFile = STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, stateFile);
  } catch {
    // best-effort; never block the hook
  }
}

/**
 * @param {State} state
 * @param {number} [nowEpoch] for testability; defaults to current time
 * @returns {State}
 */
export function pruneOldSessions(state, nowEpoch = Date.now() / 1000) {
  const cutoff = nowEpoch - SESSION_TTL_SECONDS;
  /** @type {Record<string, SessionInfo>} */
  const kept = {};
  for (const [sid, info] of Object.entries(state.sessions)) {
    const seen = info.last_seen_epoch ?? info.first_seen_epoch ?? 0;
    if (seen >= cutoff) kept[sid] = info;
  }
  state.sessions = kept;
  return state;
}

/**
 * Recursively yield mtimes of `.md` files under `root`.
 * @param {string} root
 * @param {number} current
 * @returns {number}
 */
function maxMtimeInTree(root, current) {
  if (!isDir(root)) return current;
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return current;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      current = maxMtimeInTree(full, current);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      try {
        const m = fs.statSync(full).mtimeMs / 1000;
        if (m > current) current = m;
      } catch {
        // ignore
      }
    }
  }
  return current;
}

/**
 * Latest mtime across all watched memory files.
 *
 * @param {string} slug
 * @param {string} [claudeHome]
 * @returns {number}
 */
export function watchedMaxMtime(slug, claudeHome = CLAUDE_HOME) {
  let max = 0;
  max = maxMtimeInTree(path.join(claudeHome, "project-memory", slug), max);
  max = maxMtimeInTree(path.join(claudeHome, "memory"), max);
  return max;
}

const INJECT_DIRECTIVE = `=== HOW TO USE THE MEMORY BELOW ===

The blocks below are INDEXES — pointers to topic files, not the knowledge itself. Each description is a one-line label; the actual gotchas, conventions, and decisions live INSIDE the linked .md files.

**Before responding:** for each topic file whose description could relate to your current task (cwd, files you've touched, the user's prompt), use Read to load it. Tool files (\`tools/*.md\`) and project files (\`project-memory/<slug>/*.md\`) are highest priority — they hold knowledge you cannot derive from the code.

If you're unsure whether a file is relevant, Read it. Reading is cheap; missing a gotcha is expensive. If you respond without having Read any topic file in a session where the index pointed to relevant ones, you've probably missed something — go back and Read.`;

/**
 * @param {string} slug
 * @param {string} [claudeHome]
 */
export function composeMessage(slug, claudeHome = CLAUDE_HOME) {
  const projectPath = path.join(claudeHome, "project-memory", slug, "MEMORY.md");
  const projectContent = readTextSafe(projectPath);
  const globalIndex = path.join(claudeHome, "memory", "MEMORY.md");

  /** @type {string[]} */
  const parts = [INJECT_DIRECTIVE];

  if (projectContent !== null) {
    parts.push(`=== Project MEMORY.md (\`${slug}\`) ===\n${projectContent.trim()}`);
  } else {
    parts.push(`(no project MEMORY.md for \`${slug}\` at ${projectPath})`);
  }

  const indexContent = readTextSafe(globalIndex);
  if (indexContent !== null) {
    parts.push(`=== Global Memory Index ===\n${indexContent.trim()}`);
  }

  return parts.join("\n\n");
}

/**
 * Pure decision function: given existing session info + current tool/slug/mtime,
 * decide whether to inject and return the updated session info.
 *
 * @param {SessionInfo | undefined} info
 * @param {string} toolName
 * @param {string} slug
 * @param {number} currentMtime
 * @param {number} nowEpoch
 * @returns {{ shouldInject: boolean, info: SessionInfo }}
 */
export function decideInject(info, toolName, slug, currentMtime, nowEpoch) {
  let shouldInject = false;
  /** @type {SessionInfo} */
  let next;

  if (!info) {
    shouldInject = true;
    next = {
      first_seen: new Date(nowEpoch * 1000).toISOString(),
      first_seen_epoch: nowEpoch,
    };
  } else {
    next = { ...info };
    if (info.last_was_agent && toolName !== "Agent") {
      shouldInject = true;
    } else if (info.last_slug !== slug) {
      shouldInject = true;
    } else if (currentMtime > (info.last_inject_epoch ?? 0)) {
      shouldInject = true;
    }
  }

  next.last_was_agent = toolName === "Agent";
  next.last_seen_epoch = nowEpoch;
  next.last_slug = slug;
  if (shouldInject) next.pending_inject_epoch = nowEpoch;

  return { shouldInject, info: next };
}

/**
 * PostToolUse-side state promotion: confirm a pending inject by copying
 * `pending_inject_epoch` to `last_inject_epoch` and clearing pending.
 *
 * If no session info or no pending, this is a no-op (returns the same state).
 *
 * @param {State} state
 * @param {string} sessionId
 * @returns {{ promoted: boolean, state: State }}
 */
export function confirmInject(state, sessionId) {
  const info = state.sessions[sessionId];
  if (!info || typeof info.pending_inject_epoch !== "number") {
    return { promoted: false, state };
  }
  info.last_inject_epoch = info.pending_inject_epoch;
  delete info.pending_inject_epoch;
  return { promoted: true, state };
}

/** @param {string | null} context */
function emit(context) {
  const payload = context
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: context,
        },
      }
    : { continue: true, suppressOutput: true };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function main() {
  const data = readInput();
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
  const toolInput =
    data.tool_input && typeof data.tool_input === "object" && !Array.isArray(data.tool_input)
      ? /** @type {Record<string, unknown>} */ (data.tool_input)
      : null;

  if (!sessionId) emit(null);
  if (isDisabledForProject(cwd)) emit(null);

  const slug = resolveSlug(cwd, {
    transcriptPath: transcriptPath || null,
    currentToolInput: toolInput,
  });

  const state = loadState();
  const nowEpoch = Date.now() / 1000;
  const currentMtime = watchedMaxMtime(slug);

  const { shouldInject, info } = decideInject(
    state.sessions[sessionId],
    toolName,
    slug,
    currentMtime,
    nowEpoch,
  );
  state.sessions[sessionId] = info;
  pruneOldSessions(state, nowEpoch);
  saveState(state);

  ensureSlugSignal(slug);

  emit(shouldInject ? composeMessage(slug) : null);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
