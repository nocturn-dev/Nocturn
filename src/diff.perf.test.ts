import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "./diff";

// Перф-бюджеты diff (DiffView рендерит его на каждый fs_write шаг агента).
// Бюджеты щедрые (десятки крат от фактического времени) — ловят порядковые
// деградации вроде случайного O(n²), не флакая на слабом железе.
// Аудит А7-4: фикстура 40 строк не могла поймать деградации — LCS на
// 40×40 стоит микросекунды при любом алгоритме. 1400 строк — верх
// осмысленного диапазона (MAX_LINES = 1500 в diff.ts, выше LCS не
// считается и вход идёт грубым wholeReplace): честный O(n·m) здесь
// десятки мс, квадратичная деградация упирается в бюджет
const LINES = 1400;
const make = (seed: number) =>
  Array.from(
    { length: LINES },
    (_, i) => `строка ${i + seed}: ${"текст ".repeat(6)}`,
  ).join("\n");
const before = make(0);
const after = before
  .split("\n")
  .map((l, i) => (i % 7 === 0 ? `правка ${i}: ${"новый текст ".repeat(4)}` : l))
  .join("\n");

describe("diff perf budgets", () => {
  it(`diffLines ${LINES} строк с правками — до 300мс`, () => {
    const t0 = performance.now();
    diffStats(diffLines(before, after));
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it(`diffLines ${LINES} строк без изменений — до 300мс`, () => {
    const t0 = performance.now();
    diffStats(diffLines(before, before));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
