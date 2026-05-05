import { describe, it, expect } from "vitest";
import {
  confirmInject,
  decideInject,
  pruneOldSessions,
  SESSION_TTL_SECONDS,
} from "../hooks/inject-memory.mjs";

describe("decideInject", () => {
  const now = 1_700_000_000;

  it("injects on first call (info undefined) and sets pending, not last_inject", () => {
    const { shouldInject, info } = decideInject(undefined, "Read", "my-proj", 0, now);
    expect(shouldInject).toBe(true);
    expect(info.first_seen_epoch).toBe(now);
    expect(info.pending_inject_epoch).toBe(now);
    expect(info.last_inject_epoch).toBeUndefined();
    expect(info.last_slug).toBe("my-proj");
  });

  it("stays silent on second call (same slug, no mtime change)", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_seen_epoch: now - 50,
      last_slug: "my-proj",
      last_was_agent: false,
    };
    const { shouldInject, info } = decideInject(prev, "Bash", "my-proj", now - 200, now);
    expect(shouldInject).toBe(false);
    expect(info.last_inject_epoch).toBe(now - 100);
  });

  it("re-injects when slug changes mid-session", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_slug: "old-proj",
      last_was_agent: false,
    };
    const { shouldInject, info } = decideInject(prev, "Read", "new-proj", now - 200, now);
    expect(shouldInject).toBe(true);
    expect(info.last_slug).toBe("new-proj");
    expect(info.pending_inject_epoch).toBe(now);
  });

  it("re-injects after Agent boundary", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_slug: "p",
      last_was_agent: true,
    };
    const { shouldInject } = decideInject(prev, "Read", "p", now - 200, now);
    expect(shouldInject).toBe(true);
  });

  it("does NOT re-inject when current tool is itself Agent", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_slug: "p",
      last_was_agent: true,
    };
    const { shouldInject, info } = decideInject(prev, "Agent", "p", now - 200, now);
    expect(shouldInject).toBe(false);
    expect(info.last_was_agent).toBe(true);
  });

  it("re-injects when watched mtime exceeds last_inject_epoch", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_slug: "p",
      last_was_agent: false,
    };
    const { shouldInject } = decideInject(prev, "Read", "p", now - 50, now);
    expect(shouldInject).toBe(true);
  });

  it("tracks last_was_agent correctly", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_slug: "p",
      last_was_agent: false,
    };
    const after = decideInject(prev, "Agent", "p", 0, now);
    expect(after.info.last_was_agent).toBe(true);
  });

  it("updates last_seen_epoch on every call", () => {
    const prev = {
      first_seen_epoch: now - 100,
      last_inject_epoch: now - 100,
      last_seen_epoch: now - 50,
      last_slug: "p",
    };
    const { info } = decideInject(prev, "Read", "p", 0, now);
    expect(info.last_seen_epoch).toBe(now);
  });
});

describe("confirmInject (PostToolUse promotion)", () => {
  it("promotes pending_inject_epoch to last_inject_epoch and clears pending", () => {
    const state = {
      sessions: {
        s1: { pending_inject_epoch: 1000, last_slug: "p" },
      },
    };
    const { promoted, state: next } = confirmInject(state, "s1");
    expect(promoted).toBe(true);
    expect(next.sessions.s1.last_inject_epoch).toBe(1000);
    expect(next.sessions.s1.pending_inject_epoch).toBeUndefined();
  });

  it("is a no-op when no pending exists", () => {
    const state = { sessions: { s1: { last_inject_epoch: 500, last_slug: "p" } } };
    const { promoted } = confirmInject(state, "s1");
    expect(promoted).toBe(false);
    expect(state.sessions.s1.last_inject_epoch).toBe(500);
  });

  it("is a no-op when session not in state", () => {
    const state = { sessions: {} };
    const { promoted } = confirmInject(state, "unknown-session");
    expect(promoted).toBe(false);
  });

  it("overwrites a previous last_inject_epoch on confirmation", () => {
    const state = {
      sessions: {
        s1: { pending_inject_epoch: 2000, last_inject_epoch: 1000 },
      },
    };
    confirmInject(state, "s1");
    expect(state.sessions.s1.last_inject_epoch).toBe(2000);
  });

  it("end-to-end: rejected-then-retry preserves re-inject (decideInject + skip confirm)", () => {
    // Simulate the bug scenario: tool 1 rejected (no confirm), tool 2 should re-inject.
    const t1 = 1000;
    const t2 = 1100;

    // Tool 1: PreToolUse — first call, sets pending=t1
    const r1 = decideInject(undefined, "Read", "p", 0, t1);
    expect(r1.shouldInject).toBe(true);
    expect(r1.info.pending_inject_epoch).toBe(t1);
    expect(r1.info.last_inject_epoch).toBeUndefined();

    // Tool 1 rejected: PostToolUse does NOT fire. State has pending but no last_inject.

    // Tool 2: PreToolUse — same slug, mtime > 0 (so > undefined ?? 0)
    const r2 = decideInject(r1.info, "Bash", "p", 500, t2);
    expect(r2.shouldInject).toBe(true);
    expect(r2.info.pending_inject_epoch).toBe(t2);
  });

  it("end-to-end: confirmed inject suppresses re-inject on next call (same slug, stale mtime)", () => {
    const t1 = 1000;
    const t2 = 1100;

    const r1 = decideInject(undefined, "Read", "p", 0, t1);
    const stateAfterPre = { sessions: { s1: r1.info } };
    confirmInject(stateAfterPre, "s1");
    const confirmed = stateAfterPre.sessions.s1;
    expect(confirmed.last_inject_epoch).toBe(t1);
    expect(confirmed.pending_inject_epoch).toBeUndefined();

    // Tool 2: same slug, mtime stale (< last_inject) → silent
    const r2 = decideInject(confirmed, "Bash", "p", t1 - 100, t2);
    expect(r2.shouldInject).toBe(false);
  });
});

describe("pruneOldSessions", () => {
  it("removes sessions older than TTL", () => {
    const now = 1_700_000_000;
    const stale = now - SESSION_TTL_SECONDS - 100;
    const fresh = now - 100;
    const state = {
      sessions: {
        old: { last_seen_epoch: stale },
        new: { last_seen_epoch: fresh },
      },
    };
    pruneOldSessions(state, now);
    expect(state.sessions).toHaveProperty("new");
    expect(state.sessions).not.toHaveProperty("old");
  });

  it("keeps sessions exactly at the cutoff", () => {
    const now = 1_700_000_000;
    const cutoff = now - SESSION_TTL_SECONDS;
    const state = { sessions: { boundary: { last_seen_epoch: cutoff } } };
    pruneOldSessions(state, now);
    expect(state.sessions).toHaveProperty("boundary");
  });

  it("falls back to first_seen_epoch when last_seen_epoch absent", () => {
    const now = 1_700_000_000;
    const state = {
      sessions: {
        oldOnly: { first_seen_epoch: now - SESSION_TTL_SECONDS - 1 },
        freshOnly: { first_seen_epoch: now - 10 },
      },
    };
    pruneOldSessions(state, now);
    expect(state.sessions).not.toHaveProperty("oldOnly");
    expect(state.sessions).toHaveProperty("freshOnly");
  });
});
