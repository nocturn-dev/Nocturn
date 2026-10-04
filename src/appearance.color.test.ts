import { describe, expect, it } from "vitest";
import { hslToRgb, mixRgb, parseHexColor, rgbCss, rgbToHsl, sceneTint } from "./appearance";

// Золотые векторы цветовой арифметики (правило 7): canvas-слои
// (LyricsRibbon/AmbientLayer/терминал) вызывают эти функции при каждой
// отрисовке — регресс смешивания давал невидимые/кислотные цвета молча
// (аудит 2026-10-04)
describe("цветовая арифметика — золотые векторы", () => {
  it("parseHexColor: #rrggbb, #rgb, отказ", () => {
    expect(parseHexColor("#d97757")).toEqual([217, 119, 87]);
    expect(parseHexColor("#262624")).toEqual([38, 38, 36]);
    expect(parseHexColor("#abc")).toEqual([170, 187, 204]);
    expect(parseHexColor("nope")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });

  it("mixRgb: t=0/1 — концы; t=0.5 — середина; клэмп вне диапазона", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [255, 255, 255];
    expect(mixRgb(a, b, 0)).toEqual([0, 0, 0]);
    expect(mixRgb(a, b, 1)).toEqual([255, 255, 255]);
    expect(mixRgb(a, b, 0.5)).toEqual([128, 128, 128]);
    expect(mixRgb(a, b, -3)).toEqual([0, 0, 0]);
    expect(mixRgb(a, b, 7)).toEqual([255, 255, 255]);
  });

  it("rgbCss", () => {
    expect(rgbCss([217, 119, 87])).toBe("rgb(217, 119, 87)");
  });

  it("rgbToHsl/hslToRgb: круговой обход серого и акцента", () => {
    expect(rgbToHsl([128, 128, 128])).toEqual([0, 0, 128 / 255]);
    // Терракотовый акцент: hue ~ 14.8° (стандартная формула HSL), s ~ 0.63, l ~ 0.60
    const [h, s, l] = rgbToHsl([217, 119, 87]);
    expect(Math.round(h * 10) / 10).toBeCloseTo(14.8, 0);
    expect(Math.round(s * 100) / 100).toBeCloseTo(0.63, 0);
    expect(Math.round(l * 100) / 100).toBeCloseTo(0.60, 0);
    expect(hslToRgb(h, s, l)).toEqual([217, 119, 87]);
  });

  it("sceneTint: нейтральные поверхности берут hue акцента, акцент не красит напрямую", () => {
    // claude dark: deep #1f1e1d, bg #262624 — почти нейтральны (s < 0.06),
    // акцент терракотовый насыщенный → холодного/тёплого сдвига нет: база
    const deep = parseHexColor("#1f1e1d")!;
    const bg = parseHexColor("#262624")!;
    const accent = parseHexColor("#d97757")!;
    // Поверхности claude почти нейтральны (s < 0.06) → hue берётся у
    // акцента с форсом s=0.45/l=0.16: тёплый тёмный тинт [59,31,22]
    expect(sceneTint(deep, bg, accent)).toEqual([59, 31, 22]);
  });
});
