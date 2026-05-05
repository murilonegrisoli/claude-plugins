import { describe, it, expect } from "vitest";
import { extractActionLine } from "../hooks/memory_auditor/worker.mjs";

describe("extractActionLine", () => {
  it("returns the wrote: line when at start", () => {
    expect(extractActionLine("wrote: tools/foo.md — added X")).toBe(
      "wrote: tools/foo.md — added X",
    );
  });

  it("returns the skip: line when at start", () => {
    expect(extractActionLine("skip: nothing memo-worthy")).toBe(
      "skip: nothing memo-worthy",
    );
  });

  it("extracts wrote: line from middle of chatter", () => {
    const input = "Some chatter\nmore chatter\nwrote: tools/foo.md — bar\ntrailing";
    expect(extractActionLine(input)).toBe("wrote: tools/foo.md — bar");
  });

  it("extracts skip: line after preamble", () => {
    const input = "Pre-amble\nskip: confirmation filter rejected all candidates";
    expect(extractActionLine(input)).toBe(
      "skip: confirmation filter rejected all candidates",
    );
  });

  it("falls back to first non-empty line if no marker found", () => {
    expect(extractActionLine("no marker at all\njust prose")).toBe("no marker at all");
  });

  it("returns empty string for empty input", () => {
    expect(extractActionLine("")).toBe("");
  });

  it("handles CRLF line endings", () => {
    expect(extractActionLine("chatter\r\nwrote: tools/x.md\r\n")).toBe(
      "wrote: tools/x.md",
    );
  });

  it("returns empty string for whitespace-only input", () => {
    expect(extractActionLine("   \n\n  \t\n")).toBe("");
  });
});
