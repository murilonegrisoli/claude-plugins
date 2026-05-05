import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadState, saveState } from "../hooks/inject-memory.mjs";
import { makeTmpDir, removeTree, writeFile } from "./helpers.mjs";

describe("loadState / saveState round-trip", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let stateFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateFile = path.join(tmpDir, "cache", "memory-system", "state.json");
  });

  afterEach(() => removeTree(tmpDir));

  it("returns empty state when file doesn't exist", () => {
    expect(loadState(stateFile)).toEqual({ sessions: {} });
  });

  it("returns empty state for malformed JSON", () => {
    writeFile(stateFile, "{ not json");
    expect(loadState(stateFile)).toEqual({ sessions: {} });
  });

  it("returns empty state when sessions key is missing", () => {
    writeFile(stateFile, JSON.stringify({ other: 1 }));
    expect(loadState(stateFile)).toEqual({ sessions: {} });
  });

  it("round-trips a state object", () => {
    const state = {
      sessions: {
        s1: {
          first_seen: "2026-01-01T00:00:00Z",
          first_seen_epoch: 1700000000,
          last_seen_epoch: 1700001000,
          last_inject_epoch: 1700000500,
          last_slug: "proj-a",
          last_was_agent: false,
        },
      },
    };
    saveState(state, stateFile);
    expect(loadState(stateFile)).toEqual(state);
  });

  it("creates parent directory if missing", () => {
    saveState({ sessions: {} }, stateFile);
    expect(fs.existsSync(path.dirname(stateFile))).toBe(true);
  });

  it("uses atomic write (tmp file + rename)", () => {
    saveState({ sessions: { s1: { last_slug: "x" } } }, stateFile);
    // tmp file should be cleaned up after rename
    expect(fs.existsSync(stateFile + ".tmp")).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("overwrites previous state cleanly", () => {
    saveState({ sessions: { old: { last_slug: "a" } } }, stateFile);
    saveState({ sessions: { new: { last_slug: "b" } } }, stateFile);
    const loaded = loadState(stateFile);
    expect(loaded.sessions).not.toHaveProperty("old");
    expect(loaded.sessions).toHaveProperty("new");
  });
});
