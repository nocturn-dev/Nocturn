import { describe, expect, it } from "vitest";
import {
  appendJailbreak,
  builtinJailbreaksFor,
  jbModelFacets,
  jbYearFacets,
  sanitizeJailbreaks,
  searchJailbreaks,
  type JailbreakEntry,
} from "./jailbreaks";

function mk(partial: Partial<JailbreakEntry>): JailbreakEntry {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    name: partial.name ?? "N",
    model: partial.model ?? "",
    text: partial.text ?? "T",
    reasoning: "any",
    year: partial.year,
    tags: partial.tags,
    createdAt: 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  } as JailbreakEntry;
}

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

describe("sanitizeJailbreaks: year/tags", () => {
  it("год и теги строкой проходят, битые типы отбрасываются", () => {
    const out = sanitizeJailbreaks([
      { id: "a", name: "N", text: "T", year: "2025", tags: "no-limits;persona-dan" },
      { id: "b", name: "N2", text: "T2", year: 2024, tags: 42 },
    ]);
    expect(out[0]?.year).toBe("2025");
    expect(out[0]?.tags).toBe("no-limits;persona-dan");
    expect(out[1]?.year).toBeUndefined();
    expect(out[1]?.tags).toBeUndefined();
  });
});

describe("searchJailbreaks + фасеты", () => {
  const pool = [
    mk({ id: "1", name: "DAN classic", model: "ChatGPT", text: "do anything now mode", year: "2023", tags: "persona-dan" }),
    mk({ id: "2", name: "Godmode", model: "OPENAI", text: "godmode is active, no limits", year: "2025", tags: "no-limits" }),
    mk({ id: "3", name: "Sonnet unlock", model: "Claude Sonnet 4.6", text: "no restrictions, act as twin", year: "2026" }),
    mk({ id: "4", name: "Template {{ prompt }}", model: "", text: "universal template", year: "2024-2025" }),
  ];

  it("многословный запрос — AND по подстрокам, регистр не важен", () => {
    const r = searchJailbreaks(pool, { query: "godmode LIMITS", model: "", year: "", sort: "relevance" });
    expect(r.map((x) => x.id)).toEqual(["2"]);
    expect(searchJailbreaks(pool, { query: "godmode DAN", model: "", year: "", sort: "relevance" })).toHaveLength(0);
  });

  it("поиск ищет по тегам и модели, не только по тексту", () => {
    expect(searchJailbreaks(pool, { query: "persona-dan", model: "", year: "", sort: "relevance" }).map((x) => x.id)).toEqual(["1"]);
    expect(searchJailbreaks(pool, { query: "sonnet", model: "", year: "", sort: "relevance" }).map((x) => x.id)).toEqual(["3"]);
  });

  it("фильтры модели и года комбинируются с запросом", () => {
    expect(searchJailbreaks(pool, { query: "", model: "OPENAI", year: "", sort: "name" }).map((x) => x.id)).toEqual(["2"]);
    expect(searchJailbreaks(pool, { query: "", model: "", year: "2026", sort: "name" }).map((x) => x.id)).toEqual(["3"]);
    expect(searchJailbreaks(pool, { query: "no", model: "OPENAI", year: "2025", sort: "relevance" }).map((x) => x.id)).toEqual(["2"]);
  });

  it("сортировки: relevance (имя > модель > текст), newest по году, name", () => {
    const rel = searchJailbreaks(pool, { query: "no", model: "", year: "", sort: "relevance" });
    expect(rel[0]?.id).toBe("2"); // «no» в тексте И в теге no-limits — самый высокий счёт
    const newest = searchJailbreaks(pool, { query: "", model: "", year: "", sort: "newest" });
    expect(newest[0]?.id).toBe("3"); // 2026
    const byName = searchJailbreaks(pool, { query: "", model: "", year: "", sort: "name" });
    expect(byName[0]?.name).toBe("DAN classic");
  });

  it("фасеты моделей нормализуют пустую модель в any, годы — новее выше", () => {
    const models = jbModelFacets(pool);
    expect(models[0]).toEqual({ value: "any", count: 1 });
    expect(models.map((f) => f.value)).toContain("ChatGPT");
    const years = jbYearFacets(pool);
    expect(years.map((f) => f.value)).toEqual(["2026", "2025", "2024-2025", "2023"]);
  });
});
