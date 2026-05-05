import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPluginSignals } from "../statusline.mjs";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
}

function writeSignal(cacheRoot, name, content, mtimeOffsetSec = 0) {
  const dir = path.join(cacheRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "statusline.txt");
  fs.writeFileSync(file, content, "utf-8");
  if (mtimeOffsetSec !== 0) {
    const past = (Date.now() + mtimeOffsetSec * 1000) / 1000;
    fs.utimesSync(file, past, past);
  }
  return file;
}

describe("readPluginSignals", () => {
  /** @type {string} */
  let cacheRoot;

  beforeEach(() => {
    cacheRoot = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns [] when cache root doesn't exist", () => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    expect(readPluginSignals(cacheRoot)).toEqual([]);
  });

  it("returns [] when cache root is empty", () => {
    expect(readPluginSignals(cacheRoot)).toEqual([]);
  });

  it("reads a single fresh signal", () => {
    writeSignal(cacheRoot, "memory-system", "🧠 wrote tools/foo.md");
    const out = readPluginSignals(cacheRoot);
    expect(out).toEqual([
      { name: "memory-system", content: "🧠 wrote tools/foo.md" },
    ]);
  });

  it("aggregates signals from multiple plugins, sorted by name", () => {
    writeSignal(cacheRoot, "z-last", "z-content");
    writeSignal(cacheRoot, "a-first", "a-content");
    writeSignal(cacheRoot, "m-middle", "m-content");
    const out = readPluginSignals(cacheRoot);
    expect(out.map((s) => s.name)).toEqual(["a-first", "m-middle", "z-last"]);
  });

  it("drops signals older than the TTL (60s)", () => {
    writeSignal(cacheRoot, "stale", "old-content", -120);
    writeSignal(cacheRoot, "fresh", "new-content");
    const out = readPluginSignals(cacheRoot);
    expect(out.map((s) => s.name)).toEqual(["fresh"]);
  });

  it("keeps signals exactly at the TTL boundary", () => {
    writeSignal(cacheRoot, "boundary", "borderline");
    const fixedNow = Date.now();
    fs.utimesSync(
      path.join(cacheRoot, "boundary", "statusline.txt"),
      (fixedNow - 60_000) / 1000,
      (fixedNow - 60_000) / 1000,
    );
    const out = readPluginSignals(cacheRoot, fixedNow);
    expect(out.map((s) => s.name)).toEqual(["boundary"]);
  });

  it("collapses multi-line signals to a single line", () => {
    writeSignal(cacheRoot, "multi", "line one\nline two\nline three");
    const out = readPluginSignals(cacheRoot);
    expect(out[0].content).toBe("line one line two line three");
  });

  it("trims surrounding whitespace", () => {
    writeSignal(cacheRoot, "ws", "  padded  ");
    expect(readPluginSignals(cacheRoot)[0].content).toBe("padded");
  });

  it("skips empty signal files", () => {
    writeSignal(cacheRoot, "empty", "");
    writeSignal(cacheRoot, "whitespace-only", "   \n  \n");
    expect(readPluginSignals(cacheRoot)).toEqual([]);
  });

  it("caps long signals at 200 chars with ellipsis", () => {
    const long = "x".repeat(500);
    writeSignal(cacheRoot, "verbose", long);
    const out = readPluginSignals(cacheRoot);
    expect(out[0].content.length).toBe(200);
    expect(out[0].content.endsWith("...")).toBe(true);
  });

  it("ignores files at root that aren't statusline.txt inside a subdir", () => {
    fs.writeFileSync(path.join(cacheRoot, "stray.txt"), "ignored", "utf-8");
    expect(readPluginSignals(cacheRoot)).toEqual([]);
  });

  it("ignores subdirs without a statusline.txt", () => {
    fs.mkdirSync(path.join(cacheRoot, "no-signal-dir"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheRoot, "no-signal-dir", "other.txt"),
      "ignored",
      "utf-8",
    );
    expect(readPluginSignals(cacheRoot)).toEqual([]);
  });

  it("preserves ANSI escape sequences in the signal", () => {
    writeSignal(cacheRoot, "colored", "\x1b[31mred\x1b[0m");
    expect(readPluginSignals(cacheRoot)[0].content).toBe("\x1b[31mred\x1b[0m");
  });
});
