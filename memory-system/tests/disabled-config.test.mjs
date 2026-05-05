import { afterEach, beforeEach, describe, it, expect } from "vitest";
import path from "node:path";
import { isDisabledForProject as injectIsDisabled } from "../hooks/inject-memory.mjs";
import { isDisabledForProject as auditIsDisabled } from "../hooks/audit-memory.mjs";
import { makeTmpDir, removeTree, writeFile } from "./helpers.mjs";

describe.each([
  ["inject-memory", injectIsDisabled],
  ["audit-memory", auditIsDisabled],
])("isDisabledForProject (%s)", (_name, isDisabled) => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => removeTree(tmpDir));

  it("returns false when config file doesn't exist", () => {
    expect(isDisabled(tmpDir)).toBe(false);
  });

  it("returns true for `disabled: true`", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "---\ndisabled: true\n---\n",
    );
    expect(isDisabled(tmpDir)).toBe(true);
  });

  it("accepts yes/1 as truthy", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "---\ndisabled: yes\n---\n",
    );
    expect(isDisabled(tmpDir)).toBe(true);
  });

  it("returns false for `disabled: false`", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "---\ndisabled: false\n---\n",
    );
    expect(isDisabled(tmpDir)).toBe(false);
  });

  it("returns false when frontmatter is empty", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "---\n---\nbody\n",
    );
    expect(isDisabled(tmpDir)).toBe(false);
  });

  it("ignores `disabled:` outside the leading frontmatter", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "no frontmatter\ndisabled: true\n",
    );
    expect(isDisabled(tmpDir)).toBe(false);
  });
});
