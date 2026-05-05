import { describe, it, expect } from "vitest";
import { bar, renderStatusline } from "../statusline.mjs";

describe("bar", () => {
  it("returns null for null/undefined/negative", () => {
    expect(bar(null)).toBe(null);
    expect(bar(undefined)).toBe(null);
    expect(bar(-1)).toBe(null);
  });

  it("renders 0% as all empty cells", () => {
    expect(bar(0)).toBe("░".repeat(10) + " 0%");
  });

  it("renders 100% as all filled cells", () => {
    expect(bar(100)).toBe("█".repeat(10) + " 100%");
  });

  it("renders 50% as half-filled", () => {
    expect(bar(50)).toBe("█".repeat(5) + "░".repeat(5) + " 50%");
  });

  it("clamps values above 100", () => {
    const out = bar(150);
    expect(out).toContain("100%");
    expect(out).toMatch(/^█{10} /);
  });

  it("rounds fractional percentages", () => {
    expect(bar(33)).toBe("███" + "░".repeat(7) + " 33%");
    expect(bar(35)).toBe("████" + "░".repeat(6) + " 35%");
  });
});

describe("renderStatusline", () => {
  const fullData = {
    context_window: { used_percentage: 41 },
    rate_limits: {
      five_hour: { used_percentage: 22 },
      seven_day: { used_percentage: 12 },
    },
  };

  it("renders all three bars when all metrics present", () => {
    const out = renderStatusline(fullData, []);
    expect(out).toContain("Ctx");
    expect(out).toContain("5h");
    expect(out).toContain("7d");
    expect(out).toContain("41%");
    expect(out).toContain("22%");
    expect(out).toContain("12%");
  });

  it("skips missing metrics", () => {
    const out = renderStatusline({ context_window: { used_percentage: 50 } }, []);
    expect(out).toContain("Ctx");
    expect(out).toContain("50%");
    expect(out).not.toContain("5h");
    expect(out).not.toContain("7d");
  });

  it("returns empty string when nothing to render", () => {
    expect(renderStatusline({}, [])).toBe("");
    expect(renderStatusline(null, [])).toBe("");
  });

  it("appends plugin signals after the bars", () => {
    const out = renderStatusline(fullData, [
      { name: "memory-system", content: "🧠 wrote tools/foo.md" },
    ]);
    const ctxIdx = out.indexOf("Ctx");
    const sigIdx = out.indexOf("🧠");
    expect(ctxIdx).toBeLessThan(sigIdx);
  });

  it("renders signals in the order provided", () => {
    const out = renderStatusline({}, [
      { name: "a", content: "first" },
      { name: "b", content: "second" },
    ]);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });

  it("uses two-space separator between segments", () => {
    const out = renderStatusline(
      { context_window: { used_percentage: 10 } },
      [{ name: "x", content: "sig" }],
    );
    expect(out).toMatch(/10%  sig/);
  });

  it("renders signals only when no bars", () => {
    const out = renderStatusline({}, [{ name: "x", content: "lonely-signal" }]);
    expect(out).toBe("lonely-signal");
  });
});
