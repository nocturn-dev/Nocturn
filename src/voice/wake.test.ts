import { describe, expect, it } from "vitest";
import { floatChunksToBase64, stripWakeWord, type WakeModel } from "./wake";

describe("stripWakeWord", () => {
  const cases: [string, WakeModel, string][] = [
    ["Hey Jarvis, что по погоде", "hey_jarvis", "что по погоде"],
    ["Hey, Jarvis! открой калькулятор", "hey_jarvis", "открой калькулятор"],
    ["hey jarvis запусти сборку", "hey_jarvis", "запусти сборку"],
    ["Ok Jarvis проверь почту", "hey_jarvis", "проверь почту"],
    ["Эй Джарвис, сколько времени", "hey_jarvis", "сколько времени"],
    ["Окей Джарвис. Сводка за день", "hey_jarvis", "Сводка за день"],
    ["Джарвис без приветствия", "hey_jarvis", "Джарвис без приветствия"],
    ["Hey Mycroft, время", "hey_mycroft", "время"],
    ["Эй Мойкрофт погода", "hey_mycroft", "погода"],
    // Чужое имя не срезается своей моделью
    ["Hey Mycroft, время", "hey_jarvis", "Hey Mycroft, время"],
    // Просто фраза без wake — не трогается
    ["Привет, как дела?", "hey_jarvis", "Привет, как дела?"],
    ["", "hey_jarvis", ""],
    // Wake-слово без команды после него
    ["Hey Jarvis", "hey_jarvis", ""],
  ];
  it.each(cases)("stripWakeWord(%j, %s) → %j", (input, model, expected) => {
    expect(stripWakeWord(input, model)).toBe(expected);
  });
});

describe("floatChunksToBase64", () => {
  it("encodes int16 PCM deterministically", () => {
    const b64 = floatChunksToBase64([new Float32Array([0, 0.5, -0.5, 1])]);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // 0 → 0x0000; 0.5 → int16-обрезка 0.5*0x7FFF = 16383 = 0x3FFF (FF 3F);
    // -0.5 → -0.5*0x8000 = -16384 = 0xC000 (00 C0); 1 → 0x7FFF (FF 7F)
    expect([...bytes]).toEqual([0, 0, 0xff, 0x3f, 0, 0xc0, 0xff, 0x7f]);
  });
});
