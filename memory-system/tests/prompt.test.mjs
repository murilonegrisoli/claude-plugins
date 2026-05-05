import { describe, it, expect } from "vitest";
import { AUDITOR_PROMPT, buildCommand } from "../hooks/memory_auditor/worker.mjs";

describe("AUDITOR_PROMPT", () => {
  it("substitutes cwd, project_slug, and transcript_excerpt", () => {
    const out = AUDITOR_PROMPT("/work/proj", "my-plugin", "[user] hi");
    expect(out).toContain("Working directory: `/work/proj`");
    expect(out).toContain("Project slug: `my-plugin`");
    expect(out).toContain("[user] hi");
    expect(out).toContain("~/.claude/project-memory/my-plugin/MEMORY.md");
  });

  it("preserves literal {name} / {topic} placeholders for filename templates", () => {
    const out = AUDITOR_PROMPT("/x", "y", "z");
    expect(out).toContain("`tools/{name}.md`");
    expect(out).toContain("`domain/{topic}.md`");
  });

  it("includes the strict final-output rule", () => {
    const out = AUDITOR_PROMPT("/x", "y", "z");
    expect(out).toContain("output EXACTLY ONE line");
    expect(out).toMatch(/wrote:.*one-line summary/);
    expect(out).toMatch(/skip:.*reason/);
  });

  it("includes the confirmation filter section", () => {
    const out = AUDITOR_PROMPT("/x", "y", "z");
    expect(out).toContain("Confirmation filter");
    expect(out).toContain("Skip claims that:");
  });

  it("includes the routing self-test", () => {
    const out = AUDITOR_PROMPT("/x", "y", "z");
    expect(out).toContain("Routing — global memory vs project memory");
    expect(out).toContain("<other-project>");
  });

  it("includes the append-only constraint", () => {
    const out = AUDITOR_PROMPT("/x", "y", "z");
    expect(out).toContain("Append-only constraint");
  });
});

describe("buildCommand", () => {
  it("includes all required claude flags", () => {
    const cmd = buildCommand("haiku", "/usr/bin/claude", "test-uuid-1");
    expect(cmd[0]).toBe("/usr/bin/claude");
    expect(cmd).toContain("--print");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("haiku");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("bypassPermissions");
    expect(cmd).toContain("--allowed-tools");
    expect(cmd).toContain("Read,Write,Edit,Glob,Grep");
    expect(cmd).toContain("--no-session-persistence");
  });

  it("propagates the model arg", () => {
    const cmd = buildCommand("sonnet", "/x/claude", "test-uuid-2");
    const idx = cmd.indexOf("--model");
    expect(cmd[idx + 1]).toBe("sonnet");
  });

  it("does not include destructive tools in --allowed-tools", () => {
    const cmd = buildCommand("haiku", "/x/claude", "test-uuid-3");
    const allowedIdx = cmd.indexOf("--allowed-tools");
    const allowed = cmd[allowedIdx + 1];
    expect(allowed).not.toContain("Bash");
    expect(allowed).not.toContain("Task");
    expect(allowed).not.toContain("AskUserQuestion");
  });

  it("includes --add-dir for memory paths", () => {
    const cmd = buildCommand("haiku", "/x/claude", "test-uuid-4");
    const addDirCount = cmd.filter((a) => a === "--add-dir").length;
    expect(addDirCount).toBe(2);
  });

  it("includes --session-id with the provided uuid (v0.4.3+ tombstone workaround)", () => {
    const cmd = buildCommand("haiku", "/x/claude", "abc-123-def");
    const idx = cmd.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("abc-123-def");
  });
});
