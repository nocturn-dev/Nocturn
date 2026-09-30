import { describe, expect, it } from "vitest";
import { StreamDeltaBuffer, applyMainDeltas, isSeqGap } from "./streamBuffer";

describe("StreamDeltaBuffer", () => {
  it("accumulates deltas per message id", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "При", "");
    buf.append("a", "вет", "");
    buf.append("a", "", " думаю");
    expect(buf.isEmpty).toBe(false);
    const { main, subThoughts } = buf.drain();
    expect(main).toEqual([["a", { content: "Привет", thought: " думаю" }]]);
    expect(subThoughts).toEqual([]);
  });

  it("drain empties the buffer", () => {
    const buf = new StreamDeltaBuffer();
    buf.append("a", "x", "");
    buf.appendSubThought("sub1", "раз");
    buf.appendSubThought("sub1", "два");
    buf.drain();
    expect(buf.isEmpty).toBe(true);
    const second = buf.drain();
    expect(second.main).toEqual([]);
    expect(second.subThoughts).toEqual([]);
  });

  it("accumulates subagent thoughts per call id", () => {
    const buf = new StreamDeltaBuffer();
    buf.appendSubThought("s1", "шаг ");
    buf.appendSubThought("s2", "другой агент");
    buf.appendSubThought("s1", "мысли");
    const { subThoughts } = buf.drain();
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

