import { describe, expect, it } from "vitest";
import { StreamDeltaBuffer, applyMainDeltas } from "./streamBuffer";
import type { Message } from "../types";

// Перф-бюджеты стрим-буфера: он живёт на каждом токене прогона.
// Входы подняты и бюджеты ужаты до запаса ~x10-30 (старые x100/x500 не
// ловили даже порядковые деградации — аудит 2026-10-04)
describe("streamBuffer perf budgets", () => {
  it("5000 мелких дельт в 8 потоков -> drain — до 20мс", () => {
    const t0 = performance.now();
    const buf = new StreamDeltaBuffer();
    for (let i = 0; i < 5000; i++) {
      buf.append(`m${i % 8}`, "токен ", i % 5 === 0 ? "мысль " : "");
    }
    buf.drain();
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it("applyMainDeltas: 1000 тиков по ленте из 200 сообщений — до 50мс", () => {
    const messages: Message[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      content: "",
    }));
    const t0 = performance.now();
    let acc = messages;
    for (let tick = 0; tick < 1000; tick++) {
      acc = applyMainDeltas(acc, [["m42", { content: "токен ", thought: "" }]]);
    }
    expect(performance.now() - t0).toBeLessThan(50);
    expect(acc.find((m) => m.id === "m42")?.content).toBe("токен ".repeat(1000));
  });
});
