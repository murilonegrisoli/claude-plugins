import { describe, it, expect } from "vitest";
import { buildSessionInfo } from "../hooks/inject-on-session-start.mjs";
import { decideInject } from "../hooks/inject-memory.mjs";

describe("buildSessionInfo (SessionStart record)", () => {
  const now = 1_700_000_000;

  it("commits last_inject_epoch directly (no two-phase pending)", () => {
    const info = buildSessionInfo("p", now, 0);
    expect(info.last_inject_epoch).toBe(now);
    expect(info.pending_inject_epoch).toBeUndefined();
  });

  it("sets last_was_agent=false so subsequent non-Agent calls don't trip the boundary", () => {
    const info = buildSessionInfo("p", now, 0);
    expect(info.last_was_agent).toBe(false);
  });

  it("captures slug and timestamps", () => {
    const info = buildSessionInfo("my-proj", now, 0);
    expect(info.last_slug).toBe("my-proj");
    expect(info.first_seen_epoch).toBe(now);
    expect(info.last_seen_epoch).toBe(now);
    expect(info.first_seen).toBe(new Date(now * 1000).toISOString());
  });

  it("clamps last_inject_epoch up to watched mtime when mtime is in the future", () => {
    const future = now + 500;
    const info = buildSessionInfo("p", now, future);
    expect(info.last_inject_epoch).toBe(future);
  });

  it("uses now when mtime is stale (normal case)", () => {
    const info = buildSessionInfo("p", now, now - 1000);
    expect(info.last_inject_epoch).toBe(now);
  });
});

describe("SessionStart → PreToolUse dedup contract", () => {
  const now = 1_700_000_000;

  it("first PreToolUse after SessionStart stays silent (same slug, stale mtime)", () => {
    const sessionInfo = buildSessionInfo("p", now, now - 100);
    const { shouldInject } = decideInject(sessionInfo, "Read", "p", now - 100, now + 1);
    expect(shouldInject).toBe(false);
  });

  it("first PreToolUse re-injects if slug changed between SessionStart and first tool", () => {
    const sessionInfo = buildSessionInfo("old-proj", now, 0);
    const { shouldInject } = decideInject(sessionInfo, "Read", "new-proj", 0, now + 1);
    expect(shouldInject).toBe(true);
  });

  it("first PreToolUse re-injects if a memory file was touched after SessionStart", () => {
    const sessionInfo = buildSessionInfo("p", now, now - 1000);
    // mtime updates AFTER SessionStart fired
    const { shouldInject } = decideInject(sessionInfo, "Read", "p", now + 50, now + 100);
    expect(shouldInject).toBe(true);
  });

  it("Agent boundary still triggers re-inject after SessionStart (subagent path)", () => {
    // SessionStart writes initial info (last_was_agent=false).
    // Then an Agent tool call fires, flipping last_was_agent=true.
    const start = buildSessionInfo("p", now, 0);
    const afterAgent = decideInject(start, "Agent", "p", 0, now + 10);
    expect(afterAgent.info.last_was_agent).toBe(true);

    // Subagent's first inner tool call must re-inject.
    const inSubagent = decideInject(afterAgent.info, "Read", "p", 0, now + 20);
    expect(inSubagent.shouldInject).toBe(true);
  });
});
