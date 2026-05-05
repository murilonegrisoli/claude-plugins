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

import { resolveSlug } from "./slug.mjs";

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, ".claude");
const GLOBAL_INDEX = path.join(CLAUDE_HOME, "memory", "MEMORY.md");
const PROJECT_MEMORY_ROOT = path.join(CLAUDE_HOME, "project-memory");
const STATE_DIR = path.join(CLAUDE_HOME, "cache", "memory-system");
const STATE_FILE = path.join(STATE_DIR, "state.json");

const SESSION_TTL_SECONDS = 7 * 86400;

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
function isDisabledForProject(cwd) {
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
 * @typedef {{ first_seen?: string, first_seen_epoch?: number, last_seen_epoch?: number, last_inject_epoch?: number, last_was_agent?: boolean, last_slug?: string }} SessionInfo
 * @typedef {{ sessions: Record<string, SessionInfo> }} State
 */

/** @returns {State} */
function loadState() {
  if (!isFile(STATE_FILE)) return { sessions: {} };
  const raw = readTextSafe(STATE_FILE);
  if (raw === null) return { sessions: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
    return { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

/** @param {State} state */
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // best-effort; never block the hook
  }
}

/**
 * @param {State} state
 * @returns {State}
 */
function pruneOldSessions(state) {
  const cutoff = Date.now() / 1000 - SESSION_TTL_SECONDS;
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
 * Watches the entire project memory tree (`~/.claude/project-memory/{slug}/**\/*.md`)
 * and the entire global memory tree (`~/.claude/memory/**\/*.md`). The hook
 * only injects MEMORY.md (the index), but bumping mtime on any topic file
 * typically coincides with a skill-driven index update — watching the whole
 * tree just provides safety against missed index bumps.
 *
 * @param {string} slug
 * @returns {number}
 */
function watchedMaxMtime(slug) {
  let max = 0;
  max = maxMtimeInTree(path.join(PROJECT_MEMORY_ROOT, slug), max);
  max = maxMtimeInTree(path.join(CLAUDE_HOME, "memory"), max);
  return max;
}

/** @param {string} slug */
function composeMessage(slug) {
  const projectPath = path.join(PROJECT_MEMORY_ROOT, slug, "MEMORY.md");
  const projectContent = readTextSafe(projectPath);

  /** @type {string[]} */
  const parts = [];

  if (projectContent !== null) {
    parts.push(`=== Project MEMORY.md (\`${slug}\`) ===\n${projectContent.trim()}`);
  } else {
    parts.push(`(no project MEMORY.md for \`${slug}\` at ${projectPath})`);
  }

  const indexContent = readTextSafe(GLOBAL_INDEX);
  if (indexContent !== null) {
    parts.push(`=== Global Memory Index ===\n${indexContent.trim()}`);
  }

  return parts.join("\n\n");
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
  const sessions = state.sessions;
  let info = sessions[sessionId];
  const nowEpoch = Date.now() / 1000;

  let shouldInject = false;
  if (!info) {
    shouldInject = true;
    info = {
      first_seen: new Date().toISOString(),
      first_seen_epoch: nowEpoch,
    };
  } else if (info.last_was_agent && toolName !== "Agent") {
    // Previous tool was Agent (subagent likely spawned). Re-inject so memory
    // becomes visible inside the subagent context.
    shouldInject = true;
  } else if (info.last_slug !== slug) {
    // Slug changed mid-session — re-inject for the new project's memory.
    shouldInject = true;
  } else if (watchedMaxMtime(slug) > (info.last_inject_epoch ?? 0)) {
    // Watched memory file changed since our last inject.
    shouldInject = true;
  }

  info.last_was_agent = toolName === "Agent";
  info.last_seen_epoch = nowEpoch;
  info.last_slug = slug;
  if (shouldInject) info.last_inject_epoch = nowEpoch;
  sessions[sessionId] = info;
  pruneOldSessions(state);
  saveState(state);

  emit(shouldInject ? composeMessage(slug) : null);
}

main();
