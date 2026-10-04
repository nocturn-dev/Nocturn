import { describe, expect, it } from "vitest";
import { buildThemeCss } from "./themeStyles";
import { DEFAULT_APPEARANCE, fullClaudeCss, officialCss } from "./appearance";

// Золотые векторы генераторов каскадо-критичного CSS (правило 7):
// потеря ":not(.light)", "!important" или data-гейта в этих функциях
// ломала каскад МОЛЧА — снапшот падает громко (аудит 2026-10-04).
// Обновление снапшота = осознанное изменение контракта каскада
describe("css generator goldens", () => {
  it("buildThemeCss — полный зафиксированный вывод всех стилей", () => {
    const css = buildThemeCss();
    expect(css).toContain('html[data-style="storm"]');
    expect(css).toContain('html[data-style="storm"]:not(.light)');
    expect(css).toMatchSnapshot();
  });

  it("officialCss — монохром с !important (палитра бьёт data-style)", () => {
    const css = officialCss(false, false);
    expect(css).toContain(":root.official");
    expect(css).toContain("!important");
    expect(css).toMatchSnapshot();
  });

  it("fullClaudeCss — important-блок и оled/contrast-переменные", () => {
    const css = fullClaudeCss(DEFAULT_APPEARANCE);
    expect(css).toContain("html.full-claude");
    expect(css).toContain("!important");
    expect(css).toMatchSnapshot();
    // поле, которое читает генератор, меняет вывод — детерминизм по аргументам
    expect(fullClaudeCss({ ...DEFAULT_APPEARANCE, fullClaudeRadius: 1.4 })).not.toBe(css);
  });
});
