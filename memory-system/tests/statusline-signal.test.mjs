import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ensureSlugSignal,
  formatSlugOnlySignal,
  formatStatuslineSignal,
  shouldRefreshSlugSignal,
  writeStatuslineSignal,
} from "../hooks/statusline-signal.mjs";
import { makeTmpDir, removeTree, writeFile } from "./helpers.mjs";

describe("formatStatuslineSignal", () => {
  // POSIX-style roots so tests pass cross-platform without depending on
  // the running OS's homedir layout.
  const memoryRoot = "/home/u/.claude/memory";
  const projectMemoryRoot = "/home/u/.claude/project-memory";
  const opts = { memoryRoot, projectMemoryRoot };
  const slug = "claude-plugins";

  it("strips ~/.claude/memory/ prefix and includes slug", () => {
    const out = formatStatuslineSignal(
      "wrote: /home/u/.claude/memory/tools/postgres.md — pg jsonb gotcha",
      slug,
      opts,
    );
    expect(out).toBe("🧠 [claude-plugins] wrote tools/postgres.md");
  });

  it("strips ~/.claude/project-memory/ prefix (slug appears both bracketed and in path)", () => {
    const out = formatStatuslineSignal(
      "wrote: /home/u/.claude/project-memory/foo/architecture.md — v0.4.4 ship",
      "foo",
      opts,
    );
    expect(out).toBe("🧠 [foo] wrote foo/architecture.md");
  });

  it("falls back to basename for unfamiliar paths", () => {
    const out = formatStatuslineSignal("wrote: /tmp/oddball.md — note", slug, opts);
    expect(out).toBe("🧠 [claude-plugins] wrote oddball.md");
  });

  it("handles comma-separated path lists by taking the first one", () => {
    const out = formatStatuslineSignal(
      "wrote: /home/u/.claude/memory/tools/a.md, /home/u/.claude/memory/tools/b.md — both",
      slug,
      opts,
    );
    expect(out).toBe("🧠 [claude-plugins] wrote tools/a.md");
  });

  it("omits the bracket prefix when slug is empty", () => {
    const out = formatStatuslineSignal(
      "wrote: /home/u/.claude/memory/tools/x.md — note",
      "",
      opts,
    );
    expect(out).toBe("🧠 wrote tools/x.md");
  });

  it("returns null for skip lines", () => {
    expect(formatStatuslineSignal("skip: nothing memo-worthy", slug, opts)).toBeNull();
  });

  it("returns null for blank input", () => {
    expect(formatStatuslineSignal("", slug, opts)).toBeNull();
  });

  it("returns null for malformed (no path after wrote:)", () => {
    expect(formatStatuslineSignal("wrote:", slug, opts)).toBeNull();
    expect(formatStatuslineSignal("wrote: ", slug, opts)).toBeNull();
  });

  it("returns null for first-line garbage that isn't wrote:", () => {
    expect(
      formatStatuslineSignal("Sure, let me check the transcript.", slug, opts),
    ).toBeNull();
  });

  it("normalizes Windows backslashes to forward slashes for display", () => {
    const out = formatStatuslineSignal(
      "wrote: C:\\Users\\u\\.claude\\memory\\tools\\postgres.md — pg",
      slug,
      { memoryRoot: "C:\\Users\\u\\.claude\\memory", projectMemoryRoot },
    );
    expect(out).toBe("🧠 [claude-plugins] wrote tools/postgres.md");
  });

  it("handles em-dash and ascii dash separators identically (path matching is whitespace-bounded)", () => {
    const em = formatStatuslineSignal(
      "wrote: /home/u/.claude/memory/tools/x.md — summary",
      slug,
      opts,
    );
    const ascii = formatStatuslineSignal(
      "wrote: /home/u/.claude/memory/tools/x.md -- summary",
      slug,
      opts,
    );
    expect(em).toBe("🧠 [claude-plugins] wrote tools/x.md");
    expect(ascii).toBe("🧠 [claude-plugins] wrote tools/x.md");
  });
});

describe("formatSlugOnlySignal", () => {
  it("renders 🧠 [<slug>] for a real slug", () => {
    expect(formatSlugOnlySignal("claude-plugins")).toBe("🧠 [claude-plugins]");
  });

  it("returns null for empty slug (no meaningless 🧠 [])", () => {
    expect(formatSlugOnlySignal("")).toBeNull();
  });
});

describe("shouldRefreshSlugSignal", () => {
  const slug = "claude-plugins";

  it("refreshes when file is absent (content === null)", () => {
    expect(shouldRefreshSlugSignal({ content: null, ageSeconds: 0, slug })).toBe(true);
  });

  it("refreshes when file is older than the 60s TTL", () => {
    expect(
      shouldRefreshSlugSignal({ content: "🧠 [claude-plugins]", ageSeconds: 61, slug }),
    ).toBe(true);
  });

  it("refreshes when file is fresh but doesn't mention the current slug", () => {
    expect(
      shouldRefreshSlugSignal({ content: "🧠 [other-project]", ageSeconds: 5, slug }),
    ).toBe(true);
  });

  it("does NOT refresh when file is fresh AND already shows slug-only signal", () => {
    expect(
      shouldRefreshSlugSignal({ content: "🧠 [claude-plugins]", ageSeconds: 5, slug }),
    ).toBe(false);
  });

  it("does NOT refresh when fresh and showing auditor wrote line for current slug", () => {
    // The wrote line contains [<slug>] so the slug-substring check covers it.
    expect(
      shouldRefreshSlugSignal({
        content: "🧠 [claude-plugins] wrote tools/postgres.md",
        ageSeconds: 5,
        slug,
      }),
    ).toBe(false);
  });

  it("does not refresh when slug is empty (caller has nothing meaningful to write)", () => {
    expect(
      shouldRefreshSlugSignal({ content: null, ageSeconds: 0, slug: "" }),
    ).toBe(false);
  });
});

describe("ensureSlugSignal (filesystem integration)", () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let target;

  beforeEach(() => {
    tmp = makeTmpDir();
    target = path.join(tmp, "cache", "memory-system", "statusline.txt");
  });

  afterEach(() => removeTree(tmp));

  it("writes 🧠 [<slug>] when file is missing", () => {
    ensureSlugSignal("claude-plugins", { target });
    expect(fs.readFileSync(target, "utf-8")).toBe("🧠 [claude-plugins]");
  });

  it("preserves an existing fresh wrote signal for the same slug", () => {
    writeFile(target, "🧠 [claude-plugins] wrote tools/postgres.md");
    ensureSlugSignal("claude-plugins", { target, now: Date.now() });
    expect(fs.readFileSync(target, "utf-8")).toBe(
      "🧠 [claude-plugins] wrote tools/postgres.md",
    );
  });

  it("overwrites a stale wrote signal with slug-only", () => {
    writeFile(target, "🧠 [claude-plugins] wrote tools/old.md");
    // Force the file to look older than the 60s TTL.
    const past = Date.now() - 120_000;
    fs.utimesSync(target, past / 1000, past / 1000);
    ensureSlugSignal("claude-plugins", { target });
    expect(fs.readFileSync(target, "utf-8")).toBe("🧠 [claude-plugins]");
  });

  it("overwrites when slug changed (project switched)", () => {
    writeFile(target, "🧠 [other-project]");
    ensureSlugSignal("claude-plugins", { target, now: Date.now() });
    expect(fs.readFileSync(target, "utf-8")).toBe("🧠 [claude-plugins]");
  });

  it("no-op when slug is empty", () => {
    ensureSlugSignal("", { target });
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("writeStatuslineSignal", () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let target;

  beforeEach(() => {
    tmp = makeTmpDir();
    target = path.join(tmp, "cache", "memory-system", "statusline.txt");
  });

  afterEach(() => removeTree(tmp));

  it("writes the signal file (creating parent dirs)", () => {
    writeStatuslineSignal("🧠 wrote tools/postgres.md", target);
    expect(fs.readFileSync(target, "utf-8")).toBe("🧠 wrote tools/postgres.md");
  });

  it("uses atomic write (no leftover .tmp file)", () => {
    writeStatuslineSignal("hi", target);
    expect(fs.existsSync(target + ".tmp")).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("overwrites previous content on second call", () => {
    writeStatuslineSignal("first", target);
    writeStatuslineSignal("second", target);
    expect(fs.readFileSync(target, "utf-8")).toBe("second");
  });
});
