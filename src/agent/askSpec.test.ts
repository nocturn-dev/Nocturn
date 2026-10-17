import { describe, expect, it } from "vitest";
import { parseAskSpec } from "./askSpec";

/** ask_user-контракт: вопрос + 2–4 опции с непустым label */
describe("parseAskSpec", () => {
  it("валидная спека проходит", () => {
    const spec = parseAskSpec(
      '{"question":"Куда идём?","options":[{"label":"Влево"},{"label":"Вправо"}]}',
    );
    expect(spec).toEqual({
      question: "Куда идём?",
      header: undefined,
      options: [{ label: "Влево" }, { label: "Вправо" }],
      multiSelect: false,
    });
  });
  it("опции с пустым/не-строковым label выкидываются; кап 4", () => {
    const spec = parseAskSpec(
      JSON.stringify({
        question: "q",
        options: [
          { label: "  " },
          42,
          null,
          { label: "a" },
          { label: "b" },
          { label: "c" },
          { label: "d" },
          { label: "e" },
        ],
      }),
    );
    expect(spec?.options.map((o) => o.label)).toEqual(["a", "b", "c", "d"]);
  });
  it("меньше двух осмысленных опций — null", () => {
    expect(parseAskSpec('{"question":"q","options":[{"label":"a"}]}')).toBeNull();
    expect(parseAskSpec('{"question":"q","options":[]}')).toBeNull();
    expect(parseAskSpec('{"question":"q"}')).toBeNull();
  });
  it("пустой/не-строковый вопрос — null", () => {
    expect(
      parseAskSpec('{"question":"  ","options":[{"label":"a"},{"label":"b"}]}'),
    ).toBeNull();
    expect(
      parseAskSpec('{"question":42,"options":[{"label":"a"},{"label":"b"}]}'),
    ).toBeNull();
  });
  it("header обрезается до 24 символов; не-строка — undefined", () => {
    const long = "x".repeat(40);
    expect(parseAskSpec(JSON.stringify({ question: "q", header: long, options: [{ label: "a" }, { label: "b" }] }))?.header).toHaveLength(24);
    expect(parseAskSpec(JSON.stringify({ question: "q", header: 42, options: [{ label: "a" }, { label: "b" }] }))?.header).toBeUndefined();
  });
  it("сохраняет description и preview опций", () => {
    const spec = parseAskSpec(
      JSON.stringify({
        question: "Выбор",
        options: [
          { label: "Вариант 1", description: "Описание 1", preview: "код 1" },
          { label: "Вариант 2" },
        ],
      }),
    );
    expect(spec?.options).toEqual([
      { label: "Вариант 1", description: "Описание 1", preview: "код 1" },
      { label: "Вариант 2" },
    ]);
  });
  it("поддерживает опции-строки", () => {
    const spec = parseAskSpec(
      JSON.stringify({
        question: "Вопрос",
        options: ["Да", "Нет"],
      }),
    );
    expect(spec?.options).toEqual([{ label: "Да" }, { label: "Нет" }]);
  });
  it("безопасно обрезает header с эмодзи без разрезания суррогатных пар", () => {
    const header = "🌟".repeat(30);
    const spec = parseAskSpec(
      JSON.stringify({
        question: "Вопрос",
        header,
        options: ["1", "2"],
      }),
    );
    expect(Array.from(spec?.header ?? "")).toHaveLength(24);
  });
  it("multiSelect только при явном true; битый JSON — null", () => {
    expect(parseAskSpec('{"question":"q","options":[{"label":"a"},{"label":"b"}],"multiSelect":true}')?.multiSelect).toBe(true);
    expect(parseAskSpec('{"question":"q","options":[{"label":"a"},{"label":"b"}],"multiSelect":"yes"}')?.multiSelect).toBe(false);
    expect(parseAskSpec("not json")).toBeNull();
  });
});
