import { describe, it, expect } from "vitest";
import { parseArgs } from "../hooks/memory_auditor/worker.mjs";

describe("parseArgs", () => {
  it("parses --key value pairs", () => {
    const result = parseArgs([
      "--session-id", "abc123",
      "--transcript", "/tmp/t.jsonl",
      "--cwd", "/work/proj",
    ]);
    expect(result).toEqual({
      "session-id": "abc123",
      transcript: "/tmp/t.jsonl",
      cwd: "/work/proj",
    });
  });

  it("returns empty object for empty argv", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("treats --flag without value as empty string", () => {
    const result = parseArgs(["--flag", "--next", "v"]);
    expect(result).toEqual({ flag: "", next: "v" });
  });

  it("ignores positional args without leading --", () => {
    const result = parseArgs(["positional", "--key", "value"]);
    expect(result).toEqual({ key: "value" });
  });

  it("supports --model override", () => {
    const result = parseArgs(["--session-id", "s1", "--model", "sonnet"]);
    expect(result).toEqual({ "session-id": "s1", model: "sonnet" });
  });
});
