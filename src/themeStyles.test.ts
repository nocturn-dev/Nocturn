import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STYLE_PALETTES } from "./themeStyles";

/**
 * index.css — единственная точка правды базовой палитры claude; STYLE_PALETTES
 * дублирует её ТОЛЬКО для превью витрины тем. Дубль — согласованное решение
 * (CSS нельзя импортировать в данные), но рассинхрон должен падать здесь,
 * в CI, а не молча: пользователь выбирает цвет по превью, а применяется другой.
 * Значения сверяются посимвольно с var-блоками :root (тёмная) и html.light.
 */

const css = readFileSync(
  fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** Первый var-блок после селектора: у :root/html.light вложенных блоков нет */
function varsOf(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `selector "${selector}" exists in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name && value) vars[name] = value.trim();
  }
  return vars;
}

const FIELDS = [
  ["bg", "--halo-bg"],
  ["deep", "--halo-deep"],
  ["surface", "--halo-surface"],
  ["raised", "--halo-raised"],
  ["line", "--halo-line"],
  ["text", "--halo-text"],
  ["muted", "--halo-muted"],
  ["codeBg", "--halo-code-bg"],
  ["hover", "--halo-hover"],
  ["hoverStrong", "--halo-hover-strong"],
] as const;

const darkVars = varsOf(":root {");
const lightVars = varsOf("html.light {");

describe("claude palette parity: index.css ↔ STYLE_PALETTES", () => {
  it.each(FIELDS)("dark %s совпадает с %s", (field, varName) => {
    expect(STYLE_PALETTES.claude.dark[field]).toBe(darkVars[varName]);
  });
  it.each(FIELDS)("light %s совпадает с %s", (field, varName) => {
    expect(STYLE_PALETTES.claude.light[field]).toBe(lightVars[varName]);
  });
});
