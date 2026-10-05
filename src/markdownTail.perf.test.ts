import { describe, expect, it } from "vitest";
import { splitMarkdownTail } from "./markdownTail";

// Бюджет сплита (волна 3а): функция зовётся на каждом тике печати (50 мс),
// на длинных ответах обязана оставаться шумом рядом с ре-парсом хвоста
describe("markdownTail perf budgets", () => {
  it("splitMarkdownTail: 6000 строк / 100 КБ — до 5 мс", () => {
    const parts: string[] = [];
    for (let i = 0; i < 800; i++) {
      parts.push(`## Раздел ${i}\n\nАбзац текста с **разметкой** и \`кодом\` номер ${i}, немного длиннее.`);
      parts.push("```rust\nfn f() {\n    let x = 1;\n}\n```\n");
    }
    const md = parts.join("\n\n");
    expect(md.length).toBeGreaterThan(80_000);
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 100; i++) {
      const { stable, tail } = splitMarkdownTail(md);
      sink += stable.length + tail.length;
    }
    const perCall = (performance.now() - t0) / 100;
    expect(sink).toBeGreaterThan(0); // split не выкинут оптимизатором
    expect(perCall).toBeLessThan(5);
  });
});
