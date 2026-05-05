#!/usr/bin/env node
/**
 * @file memory-system Stop hook — auto-write auditor.
 *
 * Fires when a Claude Code turn ends. Runs heuristic gates and, if they pass,
 * spawns a detached worker subprocess that asks Claude (via `claude -p`) to
 * audit the recent turn and persist anything memo-worthy.
 *
 * The worker runs in the background; this hook returns immediately so the
 * user isn't blocked. Loop prevention via the `MEMORY_SYSTEM_AUDITOR=1` env
 * var: when the worker spawns its own claude subprocess, it sets this var,
 * and any Stop hook that fires inside that nested session bails immediately.
 *
 * Output: empty `{continue: true, suppressOutput: true}` payload. Always
 * exits 0.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, ".claude");
const STATE_DIR = path.join(CLAUDE_HOME, "cache", "memory-system");
// AUDIT_STATE_FILE kept for parity with .py — not currently consumed here,
// but the path is stable so future gates (e.g. dedup) can reuse it.
// eslint-disable-next-line no-unused-vars
const AUDIT_STATE_FILE = path.join(STATE_DIR, "audit-state.json");

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(HOOKS_DIR, "memory_auditor", "worker.mjs");

const AUDITOR_ENV_VAR = "MEMORY_SYSTEM_AUDITOR";

/** @returns {Record<string, unknown>} */
function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** @returns {boolean} */
function isRecursion() {
  return process.env[AUDITOR_ENV_VAR] === "1";
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} cwd */
function isDisabledForProject(cwd) {
  const config = path.join(cwd, ".claude", "memory-system.local.md");
  if (!isFile(config)) return false;
  let content;
  try {
    content = fs.readFileSync(config, "utf-8");
  } catch {
    return false;
  }
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

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function main() {
  const data = readInput();
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
  const stopHookActive = Boolean(data.stop_hook_active);

  // Gates
  if (isRecursion()) emitContinue();
  if (stopHookActive) emitContinue();
  if (!sessionId || !transcriptPath) emitContinue();
  if (!isFile(transcriptPath)) emitContinue();
  if (isDisabledForProject(cwd)) emitContinue();
  if (!isFile(WORKER_SCRIPT)) emitContinue();

  // Spawn detached worker
  try {
    const env = { ...process.env, [AUDITOR_ENV_VAR]: "1" };
    const child = spawn(
      process.execPath,
      [
        WORKER_SCRIPT,
        "--session-id", sessionId,
        "--transcript", transcriptPath,
        "--cwd", cwd,
      ],
      {
        env,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.unref();
  } catch {
    // best-effort spawn; never block the hook
  }

  emitContinue();
}

main();
