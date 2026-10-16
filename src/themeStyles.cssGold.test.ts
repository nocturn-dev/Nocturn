import { describe, expect, it } from "vitest";
import { buildThemeCss } from "./themeStyles";
import { DEFAULT_APPEARANCE, fullClaudeCss, officialCss } from "./appearance";

// Золотые векторы генераторов каскадо-критичного CSS (правило 7):
// потеря ":not(.light)", "!important" или data-гейта в этих функциях
// ломала каскад МОЛЧА — снапшот падает громко.
// Обновление снапшота = осознанное изменение контракта каскада
describe("css generator goldens", () => {
  it("buildThemeCss — полный зафиксированный вывод всех стилей", () => {
    const css = buildThemeCss();
    expect(css).toContain('html[data-style="storm"]');
    expect(css).toContain('html[data-style="storm"]:not(.light)');
    expect(css).toMatchSnapshot();
  });

  it("officialCss — монохром выше палитр стилей, без important", () => {
    const css = officialCss(false, false);
    expect(css).toContain(":root.official:not(.light)");
    // Светлый вариант той же темы — отдельный блок с собственным скоупом
    expect(css).toContain(":root.official.light {");
    expect(css).toContain("--halo-bg: #0a0a0a;");
    expect(css).not.toContain("!important");
    expect(css).toMatchSnapshot();
  });

  it("fullClaudeCss — палитра без important (специфичность 0-3-0 против палитр 0-2-1)", () => {
    const css = fullClaudeCss(DEFAULT_APPEARANCE);
    expect(css).toContain("html.full-claude");
    // Селектор темы выше палитр стилей — important в var-блоке не нужен;
    // остаются только бои с инлайном (header-color сайдбара)
    expect(css).toContain(":root.full-claude:not(.light)");
    // Светлый вариант — равноправный скоуп той же темы
    expect(css).toContain(":root.full-claude.light {");
    expect(css).toContain("--halo-bg: #151515;");
    expect(css).not.toContain("#151515 !important");
    expect(css).toMatchSnapshot();
    // поле, которое читает генератор, меняет вывод — детерминизм по аргументам
    expect(fullClaudeCss({ ...DEFAULT_APPEARANCE, fullClaudeRadius: 1.4 })).not.toBe(css);
  });
});
