import { describe, expect, it } from "vitest";
import { Vt } from "./vt";

/** Видимый текст строки терминала */
function rowText(vt: Vt, row: number): string {
  const cells = vt.rows[row];
  expect(cells).toBeDefined();
  return cells!.map((c) => c.ch).join("").trimEnd();
}

describe("Vt", () => {
  it("prints plain text at the cursor position", () => {
    const vt = new Vt(40, 5);
    vt.feed("hello");
    expect(rowText(vt, 0)).toBe("hello");
  });

  it("handles CRLF line breaks", () => {
    const vt = new Vt(40, 5);
    vt.feed("one\r\ntwo");
    expect(rowText(vt, 0)).toBe("one");
    expect(rowText(vt, 1)).toBe("two");
  });

  it("applies SGR bold and resets it", () => {
    const vt = new Vt(40, 5);
    vt.feed("\x1b[1mbold\x1b[0m plain");
    const row = vt.rows[0]!;
    expect(row[0]!.style.bold).toBe(true);
    expect(row[3]!.style.bold).toBe(true);
    expect(row[5]!.style.bold).toBe(false);
    expect(rowText(vt, 0)).toBe("bold plain");
  });

  it("CSI cursor move (CUP) places following text", () => {
    const vt = new Vt(40, 5);
    vt.feed("\x1b[2;3Hthere");
    expect(rowText(vt, 1)).toBe("  there");
  });

  it("erase display (ED 2) clears the screen", () => {
    const vt = new Vt(40, 5);
    vt.feed("junk\x1b[2J");
    expect(rowText(vt, 0)).toBe("");
  });

  it("DSR query produces a mandatory cursor-position response", () => {
    const vt = new Vt(40, 5);
    vt.feed("\x1b[6n");
    expect(vt.takeResponse()).toBe("\x1b[1;1R");
    expect(vt.takeResponse()).toBeNull();
  });

  it("overlong line wraps to the next row", () => {
    const vt = new Vt(4, 5);
    vt.feed("abcdef");
    expect(rowText(vt, 0)).toBe("abcd");
    expect(rowText(vt, 1)).toBe("ef");
  });

  it("giant CSI L (malformed input) completes instantly and stays bounded", () => {
    const vt = new Vt(40, 5);
    vt.feed("base");
    const start = Date.now();
    // Раньше: 1e9 итераций splice+pop — вечное зависание UI-потока.
    // Семантика L: вставка строк на курсоре выталкивает контент за экран
    vt.feed("\x1b[999999999L");
    expect(Date.now() - start).toBeLessThan(1000);
    // Экран не разросся, контент вытеснен вставками (как в реальном терминале)
    expect(vt.rows.length).toBe(5);
    expect(rowText(vt, 0)).toBe("");
  });

  it("CSI param ceiling (xterm-style 65535) does not blow up cursor ops", () => {
    const start = Date.now();
    const vt = new Vt(40, 5);
    vt.feed("\x1b[999999999B\x1b[999999999Ctail");
    expect(Date.now() - start).toBeLessThan(1000);
    // Курсор зажат экраном; «tail» записан с мягким переносом на нижней строке
    expect(vt.rows.length).toBe(5);
    expect(vt.row).toBe(4);
    expect(rowText(vt, 4)).toContain("ail");
  });
});
