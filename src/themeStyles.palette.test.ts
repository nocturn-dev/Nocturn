import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STYLE_PALETTES } from "./themeStyles";

/**
 * Аудит: палитра «claude» существует в двух местах — index.css (:root и
 * html.light, реальный UI) и themeStyles.ts STYLE_PALETTES.claude (эталон
 * для превью в настройках). Правка одной стороны без другой давала превью,
 * расходящееся с фактическим интерфейсом. Тест ловит расхождение.
 */

const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

/** Значение var из плоского CSS-блока (блоки :root/html.light без вложенности) */
function rootVar(block: string, name: string): string | undefined {
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
}

function cssBlock(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} must exist in index.css`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("claude palette: index.css ↔ themeStyles.ts (эталон)", () => {
  it("тёмная палитра :root совпадает с STYLE_PALETTES.claude.dark", () => {
    const block = cssBlock(":root {");
    const dark = STYLE_PALETTES.claude.dark;
    for (const [name, expected] of [
      ["--halo-bg", dark.bg],
      ["--halo-deep", dark.deep],
      ["--halo-surface", dark.surface],
      ["--halo-raised", dark.raised],
      ["--halo-line", dark.line],
      ["--halo-text", dark.text],
      ["--halo-muted", dark.muted],
      ["--halo-code-bg", dark.codeBg],
    ] as const) {
      expect(rootVar(block, name), name).toBe(expected);
    }
  });

  it("светлая палитра html.light совпадает с STYLE_PALETTES.claude.light", () => {
    const block = cssBlock("html.light {");
    const light = STYLE_PALETTES.claude.light;
    for (const [name, expected] of [
      ["--halo-bg", light.bg],
      ["--halo-deep", light.deep],
      ["--halo-surface", light.surface],
      ["--halo-raised", light.raised],
      ["--halo-line", light.line],
      ["--halo-text", light.text],
      ["--halo-muted", light.muted],
      ["--halo-code-bg", light.codeBg],
    ] as const) {
      expect(rootVar(block, name), name).toBe(expected);
    }
  });
});
