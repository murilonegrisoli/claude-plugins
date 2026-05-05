import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { cwdToSlug, tombstonePath } from "../hooks/memory_auditor/worker.mjs";

describe("cwdToSlug", () => {
  it("matches claude's observed slug for a Windows path", () => {
    expect(cwdToSlug("C:\\.projects\\claude-plugins")).toBe("C---projects-claude-plugins");
  });

  it("preserves hyphens within path segments", () => {
    expect(cwdToSlug("C:\\.projects\\adapta-crm")).toBe("C---projects-adapta-crm");
  });

  it("converts a POSIX path with leading slash", () => {
    expect(cwdToSlug("/home/u/work")).toBe("-home-u-work");
  });

  it("converts colon, backslash, forward slash, and dot to dash", () => {
    expect(cwdToSlug("a:b\\c/d.e")).toBe("a-b-c-d-e");
  });

  it("returns the input unchanged when no separator-like chars present", () => {
    expect(cwdToSlug("plain-name")).toBe("plain-name");
  });
});

describe("tombstonePath", () => {
  it("composes ~/.claude/projects/<slug>/<uuid>.jsonl", () => {
    const cwd = "C:\\.projects\\claude-plugins";
    const uuid = "11111111-2222-3333-4444-555555555555";
    const got = tombstonePath(cwd, uuid);
    const expected = path.join(
      os.homedir(),
      ".claude",
      "projects",
      "C---projects-claude-plugins",
      `${uuid}.jsonl`,
    );
    expect(got).toBe(expected);
  });

  it("uses the slug derivation, not the raw cwd", () => {
    const got = tombstonePath("/var/x.y/z", "u");
    expect(got).toContain("-var-x-y-z");
    expect(got.endsWith("u.jsonl")).toBe(true);
  });
});
