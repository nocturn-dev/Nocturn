import { describe, expect, it } from "vitest";
import { microcompactWindow } from "./microcompact";
import type { ChatMsgParam } from "../api";

// Перф-бюджеты microcompact: вызывается на каждом шаге агентного цикла
// (до 25 раз на прогон). Фикстура — верх реального окна (30 сообщений в
// buildHistory) с запасом ×10; бюджеты щедрые (десятки крат от фактического
// времени) — ловят порядковые деградации вроде случайного O(n²), не флакая
// на слабом железе. Очистка не режет строки посимвольно, только O(n) длины.
const STEPS = 60;
const BIG = "x".repeat(64 * 1024);
const fixture = (): ChatMsgParam[] => [
  { role: "system", content: "sys" },
  { role: "user", content: "задача" },
  ...Array.from({ length: STEPS }, (_, i) => [
    {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        { id: `tc${i}`, type: "function", function: { name: "fs_read", arguments: "{}" } },
      ],
    },
    { role: "tool" as const, tool_call_id: `tc${i}`, content: BIG },
  ]).flat(),
];

describe("microcompact perf budgets", () => {
  it(`очистка ${STEPS} шагов × 64KB — до 20мс`, () => {
    const msgs = fixture();
    const t0 = performance.now();
    const out = microcompactWindow(msgs);
    expect(performance.now() - t0).toBeLessThan(20);
    expect(out).not.toBe(msgs);
  });

  it(`identity-путь на ${STEPS} защищённых шагах — до 20мс`, () => {
    const msgs = fixture();
    const t0 = performance.now();
    const out = microcompactWindow(msgs, 20_000, STEPS);
    expect(performance.now() - t0).toBeLessThan(20);
    expect(out).toBe(msgs);
  });
});
