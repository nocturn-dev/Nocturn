import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "./diff";

describe("diffLines", () => {
  it("identical texts → all context lines", () => {
    const out = diffLines("a\nb\nc", "a\nb\nc");
    expect(out).toHaveLength(3);
    expect(out.every((l) => l.type === "ctx")).toBe(true);
    expect(out[0].oldNo).toBe(1);
    expect(out[0].newNo).toBe(1);
  });

  it("marks removed and added lines", () => {
    const out = diffLines("a\nb\nc", "a\nx\nc");
    const del = out.filter((l) => l.type === "del");
    const add = out.filter((l) => l.type === "add");
    expect(del.map((l) => l.text)).toEqual(["b"]);
    expect(add.map((l) => l.text)).toEqual(["x"]);
    expect(del[0].oldNo).toBe(2);
    expect(add[0].newNo).toBe(2);
  });

  it("trailing newline does not create a phantom empty line", () => {
    const out = diffLines("a\nb\n", "a\nb\n");
    expect(out).toHaveLength(2);
  });

  it("empty vs non-empty → only adds (plus the phantom empty line)", () => {
    const out = diffLines("", "one\ntwo");
    expect(out.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["one", "two"]);
    expect(out.filter((l) => l.type === "del").map((l) => l.text)).toEqual([""]);
  });

  it("oversized input falls back to whole-replace", () => {
    const big = Array.from({ length: 1600 }, (_, i) => `l${i}`).join("\n");
    const out = diffLines(big, big);
    expect(out.filter((l) => l.type === "del")).toHaveLength(1600);
    expect(out.filter((l) => l.type === "add")).toHaveLength(1600);
  });
});

describe("diffStats", () => {
  it("counts added/removed lines", () => {
    const s = diffStats(diffLines("a\nb\nc", "a\nx\nc"));
    expect(s).toEqual({ added: 1, removed: 1 });
  });
});
