import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  summarizeToolUse,
  summarizeToolResult,
  renderEvent,
  readTranscriptMessages,
} from "../hooks/memory_auditor/worker.mjs";
import { makeTmpDir, removeTree, writeJsonl } from "./helpers.mjs";

describe("summarizeToolUse", () => {
  it("formats command-bearing tool input", () => {
    const out = summarizeToolUse("Bash", { command: "ls -la" });
    expect(out).toBe('[tool: Bash command="ls -la"]');
  });

  it("falls back to file_path when command absent", () => {
    const out = summarizeToolUse("Read", { file_path: "/x/y.md" });
    expect(out).toBe('[tool: Read file_path="/x/y.md"]');
  });

  it("returns name-only summary when no recognized key", () => {
    expect(summarizeToolUse("Mystery", { other_key: "x" })).toBe("[tool: Mystery]");
  });

  it("handles non-object tool input", () => {
    expect(summarizeToolUse("Foo", null)).toBe("[tool: Foo]");
    expect(summarizeToolUse("Foo", "str")).toBe("[tool: Foo]");
  });

  it("truncates long values", () => {
    const long = "x".repeat(500);
    const out = summarizeToolUse("Bash", { command: long });
    expect(out.length).toBeLessThan(250);
    expect(out).toContain("...");
  });

  it("collapses newlines in values to spaces", () => {
    const out = summarizeToolUse("Bash", { command: "line1\nline2" });
    expect(out).toBe('[tool: Bash command="line1 line2"]');
  });
});

describe("summarizeToolResult", () => {
  it("handles list-of-text-blocks", () => {
    const out = summarizeToolResult([{ type: "text", text: "hello world" }]);
    expect(out).toBe("[result: hello world]");
  });

  it("handles plain string content", () => {
    expect(summarizeToolResult("ok")).toBe("[result: ok]");
  });

  it("returns <empty> marker for empty content", () => {
    expect(summarizeToolResult("")).toBe("[result: <empty>]");
    expect(summarizeToolResult([])).toBe("[result: <empty>]");
  });

  it("truncates long results", () => {
    const long = "y".repeat(2000);
    const out = summarizeToolResult(long);
    expect(out.length).toBeLessThan(550);
    expect(out).toContain("...");
  });
});

describe("renderEvent", () => {
  it("renders plain user string", () => {
    expect(renderEvent("user", "hi there")).toBe("[user] hi there");
  });

  it("returns empty for empty string", () => {
    expect(renderEvent("user", "")).toBe("");
    expect(renderEvent("user", "   ")).toBe("");
  });

  it("renders a list with text + tool_use blocks", () => {
    const out = renderEvent("assistant", [
      { type: "text", text: "thinking" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
    expect(out).toContain("[assistant] thinking");
    expect(out).toContain('[tool: Bash command="ls"]');
  });

  it("renders tool_result blocks", () => {
    const out = renderEvent("user", [
      { type: "tool_result", content: "done" },
    ]);
    expect(out).toContain("[result: done]");
  });

  it("returns empty when content has no displayable blocks", () => {
    expect(renderEvent("assistant", [{ type: "thinking", text: "ignored" }])).toBe("");
  });
});

describe("readTranscriptMessages", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let jsonlPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    jsonlPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => removeTree(tmpDir));

  it("returns empty for nonexistent file", () => {
    const result = readTranscriptMessages(path.join(tmpDir, "nope.jsonl"), 15);
    expect(result.excerpt).toBe("");
    expect(result.lastMsgId).toBe(null);
  });

  it("filters to user/assistant events only", () => {
    writeJsonl(jsonlPath, [
      { type: "system", message: { content: "system msg" } },
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi back" } },
      { type: "permission-mode", message: { content: "ignored" } },
    ]);
    const result = readTranscriptMessages(jsonlPath, 15);
    expect(result.excerpt).toContain("[user] hello");
    expect(result.excerpt).toContain("[assistant] hi back");
    expect(result.excerpt).not.toContain("system msg");
    expect(result.excerpt).not.toContain("ignored");
  });

  it("respects max_messages window", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      type: "user",
      uuid: `m-${i}`,
      message: { content: `msg ${i}` },
    }));
    writeJsonl(jsonlPath, events);
    const result = readTranscriptMessages(jsonlPath, 5);
    expect(result.excerpt).not.toContain("msg 24");
    expect(result.excerpt).toContain("msg 25");
    expect(result.excerpt).toContain("msg 29");
    expect(result.lastMsgId).toBe("m-29");
  });

  it("extracts last_msg_id from uuid field", () => {
    writeJsonl(jsonlPath, [
      { type: "user", uuid: "u1", message: { content: "a" } },
      { type: "assistant", uuid: "a1", message: { content: "b" } },
    ]);
    const result = readTranscriptMessages(jsonlPath, 15);
    expect(result.lastMsgId).toBe("a1");
  });

  it("falls back to id field if uuid absent", () => {
    writeJsonl(jsonlPath, [
      { type: "user", id: "msg-7", message: { content: "x" } },
    ]);
    const result = readTranscriptMessages(jsonlPath, 15);
    expect(result.lastMsgId).toBe("msg-7");
  });

  it("skips malformed jsonl lines", () => {
    const valid = JSON.stringify({ type: "user", message: { content: "ok" } });
    const content = `not json\n${valid}\nalso not json\n`;
    writeJsonl(jsonlPath, []);
    fs.writeFileSync(jsonlPath, content, "utf-8");
    const result = readTranscriptMessages(jsonlPath, 15);
    expect(result.excerpt).toContain("ok");
  });

  it("collapses tool_use blobs to one-liners", () => {
    writeJsonl(jsonlPath, [
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "text", text: "running ls" },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
    ]);
    const result = readTranscriptMessages(jsonlPath, 15);
    expect(result.excerpt).toContain("running ls");
    expect(result.excerpt).toContain('[tool: Bash command="ls -la"]');
  });
});
