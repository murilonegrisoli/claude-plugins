import { describe, it, expect } from "vitest";
import { decideGate, isRecursion, AUDITOR_ENV_VAR } from "../hooks/audit-memory.mjs";

const baseInput = () => ({
  isRecursion: false,
  stopHookActive: false,
  sessionId: "s1",
  transcriptPath: "/tmp/t.jsonl",
  transcriptExists: true,
  isDisabled: false,
  workerExists: true,
});

describe("decideGate", () => {
  it("spawns when all gates pass", () => {
    const out = decideGate(baseInput());
    expect(out.spawn).toBe(true);
    expect(out.reason).toBe(null);
  });

  it("bails on recursion", () => {
    const out = decideGate({ ...baseInput(), isRecursion: true });
    expect(out.spawn).toBe(false);
    expect(out.reason).toBe("recursion");
  });

  it("bails on stop_hook_active", () => {
    const out = decideGate({ ...baseInput(), stopHookActive: true });
    expect(out.spawn).toBe(false);
    expect(out.reason).toBe("stop_hook_active");
  });

  it("bails on missing session_id", () => {
    expect(decideGate({ ...baseInput(), sessionId: "" }).reason).toBe("missing_args");
  });

  it("bails on missing transcript_path", () => {
    expect(decideGate({ ...baseInput(), transcriptPath: "" }).reason).toBe("missing_args");
  });

  it("bails when transcript file doesn't exist", () => {
    expect(decideGate({ ...baseInput(), transcriptExists: false }).reason).toBe("no_transcript");
  });

  it("bails on per-project disable", () => {
    expect(decideGate({ ...baseInput(), isDisabled: true }).reason).toBe("project_disabled");
  });

  it("bails when worker script is missing", () => {
    expect(decideGate({ ...baseInput(), workerExists: false }).reason).toBe("no_worker");
  });

  it("recursion takes precedence over disabled", () => {
    const out = decideGate({ ...baseInput(), isRecursion: true, isDisabled: true });
    expect(out.reason).toBe("recursion");
  });
});

describe("isRecursion", () => {
  it("returns true when env var is '1'", () => {
    expect(isRecursion({ [AUDITOR_ENV_VAR]: "1" })).toBe(true);
  });

  it("returns false when env var is unset", () => {
    expect(isRecursion({})).toBe(false);
  });

  it("returns false for any value other than '1'", () => {
    expect(isRecursion({ [AUDITOR_ENV_VAR]: "true" })).toBe(false);
    expect(isRecursion({ [AUDITOR_ENV_VAR]: "0" })).toBe(false);
    expect(isRecursion({ [AUDITOR_ENV_VAR]: "" })).toBe(false);
  });
});
