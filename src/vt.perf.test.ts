import { describe, expect, it } from "vitest";
import { Vt } from "./vt";

// Перф-бюджеты VT-разборки: pty.rs кормит её потоком вывода консоли —
// она не должна деградировать сильнее линейной ни при каком рефакторинге
describe("Vt perf budgets", () => {
  it("feed 8KB plain — до 300мс", () => {
    const vt = new Vt(80, 24);
    const t0 = performance.now();
    vt.feed("вывод строки терминала\r\n".repeat(300));
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("feed 8KB с SGR-кодами — до 300мс", () => {
    const vt = new Vt(80, 24);
    const t0 = performance.now();
    vt.feed("\x1b[1m\x1b[32mok\x1b[0m \x1b[31merr\x1b[0m: done\r\n".repeat(250));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
