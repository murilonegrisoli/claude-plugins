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
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(HOOKS_DIR, "memory_auditor", "worker.mjs");

export const AUDITOR_ENV_VAR = "MEMORY_SYSTEM_AUDITOR";

/** @returns {Record<string, unknown>} */
function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isRecursion(env = process.env) {
  return env[AUDITOR_ENV_VAR] === "1";
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
export function isDisabledForProject(cwd) {
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

/**
 * @typedef {{
 *   isRecursion: boolean,
 *   stopHookActive: boolean,
 *   sessionId: string,
 *   transcriptPath: string,
 *   transcriptExists: boolean,
 *   isDisabled: boolean,
 *   workerExists: boolean,
 * }} GateInput
 */

/**
 * Pure gate decision: should we spawn the worker?
 *
 * @param {GateInput} input
 * @returns {{ spawn: boolean, reason: string | null }}
 */
export function decideGate(input) {
  if (input.isRecursion) return { spawn: false, reason: "recursion" };
  if (input.stopHookActive) return { spawn: false, reason: "stop_hook_active" };
  if (!input.sessionId || !input.transcriptPath) return { spawn: false, reason: "missing_args" };
  if (!input.transcriptExists) return { spawn: false, reason: "no_transcript" };
  if (input.isDisabled) return { spawn: false, reason: "project_disabled" };
  if (!input.workerExists) return { spawn: false, reason: "no_worker" };
  return { spawn: true, reason: null };
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

  const decision = decideGate({
    isRecursion: isRecursion(),
    stopHookActive,
    sessionId,
    transcriptPath,
    transcriptExists: !!transcriptPath && isFile(transcriptPath),
    isDisabled: isDisabledForProject(cwd),
    workerExists: isFile(WORKER_SCRIPT),
  });

  if (!decision.spawn) emitContinue();

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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
