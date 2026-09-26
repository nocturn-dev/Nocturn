import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "./diff";

// Перф-бюджеты diff (DiffView рендерит его на каждый fs_write шаг агента).
// Бюджеты щедрые (десятки крат от фактического времени) — ловят порядковые
// деградации вроде случайного O(n²), не флакая на слабом железе.
const make = (seed: number) =>
  Array.from({ length: 40 }, (_, i) => `строка ${i + seed}: ${"текст ".repeat(6)}`).join("\n");
const before = make(0);
const after = before
  .split("\n")
  .map((l, i) => (i % 7 === 0 ? `правка ${i}: ${"новый текст ".repeat(4)}` : l))
  .join("\n");

describe("diff perf budgets", () => {
  it("diffLines 2KB с правками — до 300мс", () => {
    const t0 = performance.now();
    diffStats(diffLines(before, after));
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("diffLines 2KB без изменений — до 300мс", () => {
    const t0 = performance.now();
    diffStats(diffLines(before, before));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
