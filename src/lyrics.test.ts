import { describe, expect, it } from "vitest";
import { parseLyrics } from "./lyrics";

// Золотые векторы LRC-парсера (№52 аудита v5): текст приходит извне
// (lrclib), разбор едет в тайминг ленты — регресс манглил бы таймкоды молча
describe("parseLyrics — золотые векторы", () => {
  it("synced: мм:сс[.дробь], сортировка, пропуск мусора", () => {
    const out = parseLyrics(
      [
        "[01:05.20] третья", // не по порядку — сортируется
        "[00:10] первая", // без дробной части
        "[0:5.5] дробь", // однозначные мм/сс
        "[00:07:50] двоеточие в дроби", // LRC допускает «:» вместо «.»
        "",
        "плашка без метки", // плейн-строка внутри synced — пропуск
        "[00:xx] битая", // нечисловые секунды — пропуск
        "[00:30]   ", // пустой текст — пропуск
      ].join("\n"),
      null,
    );
    expect(out).toEqual([
      { t: 5.5, text: "дробь" },
      { t: 7.5, text: "двоеточие в дроби" },
      { t: 10, text: "первая" },
      { t: 65.2, text: "третья" },
    ]);
  });

  it("synced: пустые входы", () => {
    expect(parseLyrics(null, null)).toEqual([]);
    expect(parseLyrics("", null)).toEqual([]);
    expect(parseLyrics("[00:01.00]", null)).toEqual([]); // метка без текста
  });

  it("plain: трим, фильтр пустых, t = -1", () => {
    expect(parseLyrics(null, "  а \n\n б\n")).toEqual([
      { t: -1, text: "а" },
      { t: -1, text: "б" },
    ]);
    // synced приоритетнее: plain не читается
    expect(parseLyrics("[00:01] x", "y")).toEqual([{ t: 1, text: "x" }]);
  });
});
