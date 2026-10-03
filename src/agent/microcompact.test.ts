import { describe, expect, it } from "vitest";
import {
  applyMicrocompact,
  CLEARED_TOOL_RESULT,
  estimateToolTokens,
  microcompactWindow,
} from "./microcompact";
import type { ChatMsgParam } from "../api";

const sys = (): ChatMsgParam => ({ role: "system", content: "sys" });
const user = (c = "задача"): ChatMsgParam => ({ role: "user", content: c });
const assistant = (ids: string[]): ChatMsgParam => ({
  role: "assistant",
  content: "",
  tool_calls: ids.map((id) => ({
    id,
    type: "function",
    function: { name: "fs_read", arguments: "{}" },
  })),
});
const tool = (id: string, content: string): ChatMsgParam => ({
  role: "tool",
  tool_call_id: id,
  content,
});

/** Прогон: system, user, n шагов по одному вызову с результатом size */
const run = (n: number, size = "x".repeat(100)): ChatMsgParam[] => {
  const msgs: ChatMsgParam[] = [sys(), user()];
  for (let i = 0; i < n; i++) {
    msgs.push(assistant([`tc${i}`]), tool(`tc${i}`, size));
  }
  return msgs;
};

/** Инвариант пар: каждый вызов имеет ответ, каждый ответ — владельца */
const assertPairsIntact = (msgs: ChatMsgParam[]): void => {
  const answered = new Set(
    msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls != null) {
      for (const c of m.tool_calls as Array<{ id: string }>) {
        expect(answered.has(c.id), `вызов ${c.id} без ответа`).toBe(true);
      }
    }
    if (m.role === "tool") {
      const idx = msgs.indexOf(m);
      const owner = msgs
        .slice(0, idx)
        .reverse()
        .find(
          (a) =>
            a.role === "assistant" &&
            (a.tool_calls as Array<{ id: string }>)?.some?.(
              (c) => c.id === m.tool_call_id,
            ),
        );
      expect(owner, `ответ ${m.tool_call_id} без владельца`).toBeDefined();
    }
  }
};

describe("microcompactWindow", () => {
  it("под бюджетом возвращает тот же массив (identity)", () => {
    const msgs = run(5);
    expect(microcompactWindow(msgs)).toBe(msgs);
  });

  it("сверх бюджета чистит старые шаги, последние 3 не трогает", () => {
    const big = "x".repeat(40_000); // ~10k токенов на шаг
    const msgs = run(6, big);
    const out = microcompactWindow(msgs);
    expect(out).not.toBe(msgs);
    // Очищены шаги 0..2 (protectedFrom = 6 - 3)
    expect(
      out.filter((m) => m.role === "tool" && m.content === CLEARED_TOOL_RESULT),
    ).toHaveLength(3);
    // Последние 3 шага живы, role/ids не изменились
    for (const id of ["tc3", "tc4", "tc5"]) {
      expect(
        out.find((m) => m.role === "tool" && m.tool_call_id === id)?.content,
      ).toBe(big);
    }
    expect(
      out.find((m) => m.role === "tool" && m.tool_call_id === "tc0")
        ?.tool_call_id,
    ).toBe("tc0");
    assertPairsIntact(out);
  });

  it("идемпотентна: повторный прогон — no-op", () => {
    const msgs = run(6, "x".repeat(40_000));
    const once = microcompactWindow(msgs);
    const twice = microcompactWindow(once);
    expect(twice).toBe(once);
  });

  it("system/user/assistant не трогаются (reference-preserving)", () => {
    const msgs = run(6, "x".repeat(40_000));
    const out = microcompactWindow(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
    for (let i = 2; i < msgs.length; i++) {
      const orig = msgs[i];
      if (orig?.role === "assistant") expect(out[i]).toBe(orig);
    }
  });

  it("шагов ≤ keepRecent — identity даже сверх бюджета", () => {
    const msgs = run(3, "x".repeat(60_000));
    expect(microcompactWindow(msgs)).toBe(msgs);
  });

  it("пустая история и история без инструментов — identity", () => {
    expect(microcompactWindow([])).toHaveLength(0);
    const msgs: ChatMsgParam[] = [sys(), user(), { role: "assistant", content: "ответ" }];
    expect(microcompactWindow(msgs)).toBe(msgs);
  });

  it("нестроковый tool-content не трогается", () => {
    const msgs: ChatMsgParam[] = [
      sys(),
      user(),
      assistant(["t0"]),
      { role: "tool", tool_call_id: "t0", content: [{ type: "text", text: "x" }] },
      assistant(["t1"]),
      tool("t1", "x".repeat(90_000)),
      assistant(["t2"]),
      tool("t2", "x".repeat(90_000)),
      assistant(["t3"]),
      tool("t3", "x".repeat(90_000)),
      assistant(["t4"]),
      tool("t4", "x".repeat(90_000)),
    ];
    const out = microcompactWindow(msgs);
    expect(out[3]).toBe(msgs[3]); // нестроковый остался тем же объектом
    expect(out[5]?.content).toBe(CLEARED_TOOL_RESULT);
  });

  it("осиротевший tool до первого шага не трогается", () => {
    // assertPairsIntact здесь неприменим: осиротевший tool по определению
    // без владельца — проверяем только неизменность объекта
    const msgs: ChatMsgParam[] = [
      sys(),
      user(),
      tool("orphan", "x".repeat(90_000)),
      ...run(6, "x".repeat(40_000)).slice(2),
    ];
    const out = microcompactWindow(msgs);
    expect(out[2]).toBe(msgs[2]);
  });
});

describe("estimateToolTokens / applyMicrocompact", () => {
  it("оценка считает только строковые tool-контенты", () => {
    const msgs = [sys(), user(), assistant(["t0"]), tool("t0", "abcd".repeat(25))];
    expect(estimateToolTokens(msgs)).toBe(25);
  });

  it("applyMicrocompact без изменений возвращает тот же массив", () => {
    const msgs = run(2);
    expect(applyMicrocompact(msgs)).toBe(msgs);
  });

  it("applyMicrocompact при очистке возвращает укороченную историю", () => {
    const msgs = run(6, "x".repeat(40_000));
    const out = applyMicrocompact(msgs);
    expect(out).not.toBe(msgs);
    assertPairsIntact(out);
  });
});
