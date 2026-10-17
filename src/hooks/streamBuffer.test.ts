import { describe, expect, it } from "vitest";
import { StreamDeltaBuffer, applyMainDeltas, isSeqGap } from "./streamBuffer";

describe("StreamDeltaBuffer", () => {
  it("accumulates deltas per message id", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "При", "");
    buf.append("a", "вет", "");
    buf.append("a", "", " думаю");
    expect(buf.isEmpty).toBe(false);
    // holder-объект: TS не видит присваивания в колбэках и сужает тип к null
    const holder: {
      main: Array<[string, { content: string; thought: string }]>;
      subThoughts: Array<[string, string]>;
    } = { main: [], subThoughts: [] };
    buf.drain((data) => {
      holder.main = data.main;
      holder.subThoughts = data.subThoughts;
    });
    expect(holder.main).toEqual([["a", { content: "Привет", thought: " думаю" }]]);
    expect(holder.subThoughts).toEqual([]);
  });

  it("drain empties the buffer", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "x", "");
    buf.appendSubThought("sub1", "раз");
    buf.appendSubThought("sub1", "два");
    buf.drain(() => {});
    expect(buf.isEmpty).toBe(true);
    const second: { main: unknown[]; subThoughts: unknown[] } = { main: [], subThoughts: [] };
    buf.drain((data) => {
      second.main = data.main;
      second.subThoughts = data.subThoughts;
    });
    expect(second.main).toEqual([]);
    expect(second.subThoughts).toEqual([]);
  });

  it("drain keeps deltas when the applier throws", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "дельта", "");
    expect(() =>
      buf.drain(() => {
        throw new Error("apply failed");
      }),
    ).toThrow();
    expect(buf.isEmpty).toBe(false);
    let seen = "";
    buf.drain(({ main }) => {
      seen = main[0]![1].content;
    });
    expect(seen).toBe("дельта");
    expect(buf.isEmpty).toBe(true);
  });

  it("drain hands out copies: mutating them doesn't corrupt the buffer", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "оригинал", "");
    expect(() =>
      buf.drain(({ main }) => {
        main[0]![1].content = "испорчено";
        // сбой применения после мутации копии
        throw new Error("boom");
      }),
    ).toThrow();
    // мутация копии не должна испортить буфер — drain после сбоя не вызывался,
    // поэтому второй drain видит исходные данные (см. тест «keeps deltas»)
    let seen = "";
    buf.drain(({ main }) => {
      seen = main[0]![1].content;
    });
    expect(seen).toBe("оригинал");
  });

  it("accumulates subagent thoughts per call id", () => {
    const buf = new StreamDeltaBuffer();
    buf.appendSubThought("s1", "шаг ");
    buf.appendSubThought("s2", "другой агент");
    buf.appendSubThought("s1", "мысли");
    let subThoughts: Array<[string, string]> = [];
    buf.drain((data) => {
      subThoughts = data.subThoughts;
    });
    expect(subThoughts).toEqual([
      ["s1", "шаг мысли"],
      ["s2", "другой агент"],
    ]);
  });
});

describe("applyMainDeltas", () => {
  it("merges deltas only into the targeted messages", () => {
    const messages = [
      { id: "u1", content: "вопрос" },
      { id: "a1", content: "часть1", thought: "мысль" },
      { id: "a2", content: "" },
    ];
    const out = applyMainDeltas(messages, [
      ["a1", { content: " +часть2", thought: " ещё" }],
      ["a2", { content: "новый", thought: "" }],
    ]);
    expect(out[1]!.content).toBe("часть1 +часть2");
    expect(out[1]!.thought).toBe("мысль ещё");
    expect(out[2]!.content).toBe("новый");
    expect(out[2]!.thought).toBeUndefined();
    expect(out[0]!).toBe(messages[0]); // незатронутые переиспользуются по ссылке
  });

  it("empty deltas → same array reference", () => {
    const messages = [{ id: "a", content: "x" }];
    expect(applyMainDeltas(messages, [])).toBe(messages);
  });

  it("thought-less delta keeps existing thought untouched", () => {
    const messages = [{ id: "a", content: "x", thought: "t" }];
    const out = applyMainDeltas(messages, [["a", { content: "y", thought: "" }]]);
    expect(out[0]!.thought).toBe("t");
  });
});

describe("isSeqGap", () => {
  it("последовательные номера — не гэп", () => {
    expect(isSeqGap(-1, 0)).toBe(false);
    expect(isSeqGap(0, 1)).toBe(false);
    expect(isSeqGap(41, 42)).toBe(false);
  });
  it("пропуск номера — гэп (потерянное событие)", () => {
    expect(isSeqGap(41, 43)).toBe(true);
    expect(isSeqGap(0, 5)).toBe(true);
  });
  it("повтор/откат — не гэп (дубликаты каналов не роняем)", () => {
    expect(isSeqGap(42, 42)).toBe(false);
    expect(isSeqGap(42, 41)).toBe(false);
  });
});

