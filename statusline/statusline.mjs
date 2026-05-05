#!/usr/bin/env node
/**
 * @file statusline plugin renderer.
 *
 * Reads Claude Code's session JSON from stdin and renders a single
 * statusline. Three base segments (context window + 5h/7d rate limits,
 * each as a 10-cell progress bar) plus any plugin signals collected
 * from `~/.claude/cache/{plugin}/statusline.txt`.
 *
 * Output: single line on stdout, ANSI styled. No newline if there's
 * nothing to render.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIGNAL_TTL_SECONDS = 60;
const MAX_SIGNAL_CHARS = 200;
const CACHE_ROOT = path.join(os.homedir(), ".claude", "cache");

/**
 * Render a 10-cell percentage bar, e.g. `███░░░░░░░ 30%`. Returns null
 * for invalid input (used to skip absent metrics).
 *
 * @param {number | null | undefined} pct
 * @returns {string | null}
 */
export function bar(pct) {
  if (pct == null || pct < 0) return null;
  const p = Math.min(Math.round(pct), 100);
  const f = Math.round((p * 10) / 100);
  return "█".repeat(f) + "░".repeat(10 - f) + ` ${p}%`;
}

/**
 * Collect non-stale plugin signals from `<cacheRoot>/{name}/statusline.txt`.
 * Signals older than `SIGNAL_TTL_SECONDS` are dropped. Multi-line content is
 * collapsed to a single line for display. Per-signal char cap prevents one
 * misbehaving plugin from breaking the statusline.
 *
 * @param {string} [cacheRoot] defaults to `~/.claude/cache`. Override for tests.
 * @param {number} [now] current time in ms. Override for deterministic stale-tests.
 * @returns {Array<{ name: string, content: string }>}
 */
export function readPluginSignals(cacheRoot = CACHE_ROOT, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {Array<{ name: string, content: string }>} */
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(cacheRoot, ent.name, "statusline.txt");
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > SIGNAL_TTL_SECONDS * 1000) continue;
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const display = content.replace(/\r?\n/g, " ").trim();
    if (!display) continue;
    const capped =
      display.length > MAX_SIGNAL_CHARS
        ? display.slice(0, MAX_SIGNAL_CHARS - 3) + "..."
        : display;
    out.push({ name: ent.name, content: capped });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Render the full statusline given Claude Code session JSON.
 *
 * @param {Record<string, any>} data
 * @param {Array<{ name: string, content: string }>} signals
 * @returns {string}
 */
export function renderStatusline(data, signals) {
  /** @type {string[]} */
  const parts = [];

  const ctx = bar(data?.context_window?.used_percentage);
  if (ctx) parts.push(`\x1b[2mCtx\x1b[0m ${ctx}`);
  const five = bar(data?.rate_limits?.five_hour?.used_percentage);
  if (five) parts.push(`\x1b[2m5h\x1b[0m  ${five}`);
  const week = bar(data?.rate_limits?.seven_day?.used_percentage);
  if (week) parts.push(`\x1b[2m7d\x1b[0m  ${week}`);

  for (const s of signals) parts.push(s.content);

  return parts.join("  ");
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

async function main() {
  const raw = await readStdin();
  /** @type {Record<string, any>} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const line = renderStatusline(data, readPluginSignals());
  if (line) process.stdout.write(line + "\n");
}

// Run main only when invoked directly (not when imported by tests).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
