#!/usr/bin/env node
/**
 * @file memory-system PostToolUse hook — confirms inject delivery.
 *
 * Pairs with `inject-memory.mjs` (PreToolUse). The two-phase pattern handles
 * rejected tool calls cleanly:
 *
 *   1. PreToolUse builds the inject payload and sets `pending_inject_epoch`
 *      on the session (but does NOT set `last_inject_epoch`).
 *   2. The user approves or rejects at the permission prompt.
 *   3a. APPROVED + ran: PostToolUse fires here. We promote
 *       `pending_inject_epoch` → `last_inject_epoch` so the next PreToolUse
 *       knows the inject reached the model and skips re-injection.
 *   3b. REJECTED: PostToolUse does NOT fire. State stays "unconfirmed" —
 *       `last_inject_epoch` is unset and the next PreToolUse re-injects via
 *       the existing mtime-check fallback (`mtime > last_inject_epoch ?? 0`
 *       evaluates to true for any nonzero mtime).
 *
 * Output: `{continue: true, suppressOutput: true}`. Always exits 0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { confirmInject, loadState, saveState } from "./inject-memory.mjs";

/** @returns {Record<string, unknown>} */
function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function main() {
  const data = readInput();
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  if (!sessionId) emitContinue();

  const state = loadState();
  const { promoted, state: nextState } = confirmInject(state, sessionId);
  if (promoted) saveState(nextState);
  emitContinue();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
