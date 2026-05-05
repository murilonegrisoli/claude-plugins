import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveSlug } from "../hooks/slug.mjs";
import { makeTmpDir, removeTree, writeFile } from "./helpers.mjs";

describe("resolveSlug", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => removeTree(tmpDir));

  it("step 5: falls back to cwd basename when no markers exist", () => {
    expect(resolveSlug(tmpDir)).toBe(path.basename(tmpDir));
  });

  it("step 4: walks up to .git/ and returns containing dir name", () => {
    const repo = path.join(tmpDir, "myrepo");
    writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main");
    const cwd = path.join(repo, "src", "deep");
    fs.mkdirSync(cwd, { recursive: true });
    expect(resolveSlug(cwd)).toBe("myrepo");
  });

  it("step 2: walks up to .claude-plugin/plugin.json and returns plugin dir name", () => {
    const repo = path.join(tmpDir, "marketplace");
    writeFile(path.join(repo, ".git", "HEAD"), "ref");
    const plugin = path.join(repo, "my-plugin");
    writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"my-plugin"}');
    const cwd = path.join(plugin, "hooks");
    fs.mkdirSync(cwd, { recursive: true });
    expect(resolveSlug(cwd)).toBe("my-plugin");
  });

  it("step 3 (tool input): uses recent file activity at marketplace root", () => {
    const repo = path.join(tmpDir, "marketplace");
    writeFile(path.join(repo, ".git", "HEAD"), "ref");
    const pluginA = path.join(repo, "plugin-a");
    const pluginB = path.join(repo, "plugin-b");
    writeFile(path.join(pluginA, ".claude-plugin", "plugin.json"), "{}");
    writeFile(path.join(pluginB, ".claude-plugin", "plugin.json"), "{}");

    const slugWithToolInput = resolveSlug(repo, {
      currentToolInput: { file_path: path.join(pluginA, "hooks", "x.mjs") },
    });
    expect(slugWithToolInput).toBe("plugin-a");

    const slugWithDifferentInput = resolveSlug(repo, {
      currentToolInput: { file_path: path.join(pluginB, "skills", "y.md") },
    });
    expect(slugWithDifferentInput).toBe("plugin-b");
  });

  it("step 3 (transcript): uses recent tool_use file_path from jsonl", () => {
    const repo = path.join(tmpDir, "marketplace");
    writeFile(path.join(repo, ".git", "HEAD"), "ref");
    const pluginA = path.join(repo, "plugin-a");
    writeFile(path.join(pluginA, ".claude-plugin", "plugin.json"), "{}");

    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: path.join(pluginA, "skills", "thing.md") },
            },
          ],
        },
      },
    ];
    writeFile(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n"));

    expect(resolveSlug(repo, { transcriptPath })).toBe("plugin-a");
  });

  it("step 1: explicit project_slug override wins over all other steps", () => {
    const repo = path.join(tmpDir, "marketplace");
    writeFile(path.join(repo, ".git", "HEAD"), "ref");
    const plugin = path.join(repo, "real-plugin");
    writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), "{}");
    writeFile(
      path.join(plugin, ".claude", "memory-system.local.md"),
      "---\nproject_slug: custom-name\n---\n",
    );
    expect(resolveSlug(plugin)).toBe("custom-name");
  });

  it("step 1: handles quoted override values", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      '---\nproject_slug: "quoted-slug"\n---\n',
    );
    expect(resolveSlug(tmpDir)).toBe("quoted-slug");
  });

  it("ignores frontmatter outside the leading --- block", () => {
    writeFile(
      path.join(tmpDir, ".claude", "memory-system.local.md"),
      "no frontmatter here\nproject_slug: should-not-match\n",
    );
    expect(resolveSlug(tmpDir)).toBe(path.basename(tmpDir));
  });

  it("step 4 fires before step 5 when only .git/ exists", () => {
    const repo = path.join(tmpDir, "plain-repo");
    writeFile(path.join(repo, ".git", "HEAD"), "ref");
    expect(resolveSlug(repo)).toBe("plain-repo");
  });
});
