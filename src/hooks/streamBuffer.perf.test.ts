import { describe, expect, it } from "vitest";
import { StreamDeltaBuffer, applyMainDeltas } from "./streamBuffer";
import type { Message } from "../types";

// Перф-бюджеты стрим-буфера: он живёт на каждом токене прогона
describe("streamBuffer perf budgets", () => {
  it("1000 мелких дельт → drain — до 100мс", () => {
    const t0 = performance.now();
    const buf = new StreamDeltaBuffer();
    for (let i = 0; i < 1000; i++) {
      buf.append("m1", "токен ", i % 5 === 0 ? "мысль " : "");
    }
    buf.drain();
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("applyMainDeltas: 200 тиков по ленте из 100 сообщений — до 500мс", () => {
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      content: "",
    }));
    const t0 = performance.now();
    let acc = messages;
    for (let tick = 0; tick < 200; tick++) {
      acc = applyMainDeltas(acc, [["m42", { content: "токен ", thought: "" }]]);
    }
    expect(performance.now() - t0).toBeLessThan(500);
    expect(acc.find((m) => m.id === "m42")?.content).toBe("токен ".repeat(200));
  });
});
