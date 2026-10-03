import { describe, expect, it } from "vitest";
import { applyCompact, serializeHead } from "./autocompact";
import type { ChatMsgParam } from "../api";

// Перф-бюджеты autocompact: serializeHead гоняется на каждом срабатывании
// триггера (редко, но по всей истории), applyCompact — копия массива +
// trimContextWindow. Фикстура — верх реального окна с запасом; бюджеты
// щедрые — ловят порядковые деградации, не флакая на слабом железе.
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

describe("autocompact perf budgets", () => {
  it(`serializeHead на ${STEPS} шагах × 64KB — до 20мс`, () => {
    const msgs = fixture();
    const t0 = performance.now();
    serializeHead(msgs);
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it(`applyCompact на ${STEPS} шагах × 64KB — до 20мс`, () => {
    const msgs = fixture();
    const t0 = performance.now();
    const out = applyCompact(msgs, "Итог");
    expect(performance.now() - t0).toBeLessThan(20);
    expect(out).not.toBe(msgs);
  });
});
