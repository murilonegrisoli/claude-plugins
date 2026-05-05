#!/usr/bin/env node
/**
 * @file memory-system SessionStart hook.
 *
 * Inject project MEMORY.md and the global memory index at session boot so the
 * model has the index from turn 1 — without needing a tool call to trigger
 * PreToolUse first. The paired PreToolUse hook (`inject-memory.mjs`) reads
 * the same `state.json` and dedups: SessionStart writes `last_inject_epoch`
 * + `last_slug` directly, so the next PreToolUse sees existing session info,
 * the same slug, and a fresh inject epoch — and stays silent.
 *
 * SessionStart does not fire for subagents, so the existing PreToolUse
 * Agent-boundary detection still covers them.
 *
 * Output: JSON with `hookSpecificOutput.additionalContext`. Always exits 0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  composeMessage,
  isDisabledForProject,
  loadState,
  pruneOldSessions,
  saveState,
  watchedMaxMtime,
} from "./inject-memory.mjs";
import { resolveSlug } from "./slug.mjs";
import { ensureSlugSignal } from "./statusline-signal.mjs";

/** @returns {Record<string, unknown>} */
function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** @param {string | null} context */
function emit(context) {
  const payload = context
    ? {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      }
    : { continue: true, suppressOutput: true };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

/**
 * Build the session info record SessionStart commits to state.json.
 *
 * Mirrors the shape PreToolUse expects, with `last_inject_epoch` set
 * directly (no two-phase pending — SessionStart has no paired PostToolUse).
 *
 * @param {string} slug
 * @param {number} nowEpoch
 * @param {number} watchedMtime
 * @returns {import("./inject-memory.mjs").SessionInfo}
 */
export function buildSessionInfo(slug, nowEpoch, watchedMtime) {
  return {
    first_seen: new Date(nowEpoch * 1000).toISOString(),
    first_seen_epoch: nowEpoch,
    last_seen_epoch: nowEpoch,
    // Use max(now, watchedMtime) so a memory file with a future-skewed mtime
    // doesn't immediately trigger a re-inject on the first PreToolUse.
    last_inject_epoch: Math.max(nowEpoch, watchedMtime),
    last_slug: slug,
    last_was_agent: false,
  };
}

function main() {
  const data = readInput();
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";

  if (!sessionId) emit(null);
  if (isDisabledForProject(cwd)) emit(null);

  const slug = resolveSlug(cwd, {
    transcriptPath: transcriptPath || null,
  });

  const state = loadState();
  const nowEpoch = Date.now() / 1000;
  const watchedMtime = watchedMaxMtime(slug);

  state.sessions[sessionId] = buildSessionInfo(slug, nowEpoch, watchedMtime);
  pruneOldSessions(state, nowEpoch);
  saveState(state);

  ensureSlugSignal(slug);

  emit(composeMessage(slug));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
