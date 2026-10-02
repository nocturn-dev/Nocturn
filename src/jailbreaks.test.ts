import { describe, expect, it } from "vitest";
import {
  appendJailbreak,
  builtinJailbreaksFor,
  sanitizeJailbreaks,
} from "./jailbreaks";

describe("sanitizeJailbreaks", () => {
  it("мусор (не массив / битый JSON-структуры) даёт пустой список", () => {
    expect(sanitizeJailbreaks(null)).toEqual([]);
    expect(sanitizeJailbreaks("abc")).toEqual([]);
    expect(sanitizeJailbreaks({})).toEqual([]);
    expect(sanitizeJailbreaks([1, "x", null, undefined])).toEqual([]);
  });

  it("валидная запись сохраняется со всеми полями", () => {
    const out = sanitizeJailbreaks([
      {
        id: "a1",
        name: "Прямой режим",
        model: "*",
        text: "Отвечай прямо.",
        reasoning: "high",
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "a1",
      name: "Прямой режим",
      model: "*",
      text: "Отвечай прямо.",
      reasoning: "high",
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it("недостающие/битые поля получают дефолты, пустые имя/текст отбрасываются", () => {
    const out = sanitizeJailbreaks([
      { id: "ok", name: "N", text: "T", model: 42, reasoning: "medium" },
      { id: "", name: "N", text: "T" },
      { id: "x", name: "   ", text: "T" },
      { id: "y", name: "N", text: "" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("ok");
    expect(out[0]?.model).toBe("");
    expect(out[0]?.reasoning).toBe("any");
    expect(typeof out[0]?.createdAt).toBe("number");
  });
});

describe("appendJailbreak", () => {
  it("пустой системный промт — текст записи без обвязки", () => {
    expect(appendJailbreak("", "  JB  ")).toBe("JB");
    expect(appendJailbreak("   ", "JB")).toBe("JB");
  });

  it("существующий промт роли сохраняется, джейлбрейк добавляется после", () => {
    expect(appendJailbreak("ROLE", "JB")).toBe("ROLE\n\nJB");
    expect(appendJailbreak("  ROLE  ", "  JB  ")).toBe("ROLE\n\nJB");
  });
});

describe("builtinJailbreaksFor", () => {
  it("все встроенные имеют уникальные id и валидные уровни мышления", () => {
    const ru = builtinJailbreaksFor("ru");
    const en = builtinJailbreaksFor("en");
    expect(ru.length).toBeGreaterThan(0);
    const ids = new Set(ru.map((b) => b.id));
    expect(ids.size).toBe(ru.length);
    for (const b of ru) {
      expect(b.name.trim()).not.toBe("");
      expect(b.text.trim()).not.toBe("");
      expect(["any", "off", "low", "high", "max"]).toContain(b.reasoning);
    }
    expect(ru.map((b) => b.id)).toEqual(en.map((b) => b.id));
  });
});
