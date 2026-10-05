import { describe, expect, it } from "vitest";
import {
  buildBacklinks,
  buildChainPlan,
  extractLinks,
  parseNotePrompt,
  resolveLinks,
  type Note,
} from "./vault";

describe("parseNotePrompt", () => {
  it("parses frontmatter and detects agent: true", () => {
    // Регресс: символьный класс [[\s\S] ломал regex — match был null,
    // шаги цепочек всегда запускались без инструментов
    const { prompt, agent } = parseNotePrompt(
      "---\nagent: true\n---\nСделай отчёт",
    );
    expect(agent).toBe(true);
    expect(prompt).toBe("Сделай отчёт");
  });

  it("frontmatter without agent flag → plain step", () => {
    const { prompt, agent } = parseNotePrompt("---\ntitle: x\n---\nТекст");
    expect(agent).toBe(false);
    expect(prompt).toBe("Текст");
  });

  it("no frontmatter → whole content is the prompt", () => {
    const { prompt, agent } = parseNotePrompt("Просто текст");
    expect(agent).toBe(false);
    expect(prompt).toBe("Просто текст");
  });

  it("handles CRLF line endings", () => {
    const { prompt, agent } = parseNotePrompt(
      "---\r\nagent: true\r\n---\r\nШаг",
    );
    expect(agent).toBe(true);
    expect(prompt).toBe("Шаг");
  });
});

// №53 аудита v5: остальные 4 экспорта vault.ts — граф заметок едет в UI
// (бэклинки/висячие ссылки/цепочки), регрес был бы молчаливым

const note = (file: string, title: string, content: string, updated = 1): Note => ({
  file,
  title,
  updated,
  content,
});

describe("extractLinks", () => {
  it("уникальные по порядку, регистронезависимый дедуп, трим", () => {
    expect(extractLinks("[[A]] текст [[b]] ещё [[ A ]] [[a]]")).toEqual([
      "A",
      "b",
    ]);
    // сломанные/вложенные/переносящие — не ссылки
    expect(extractLinks("[[x] и [[y\nz]] [oops]")).toEqual([]);
    expect(extractLinks("без ссылок")).toEqual([]);
  });
});

describe("buildBacklinks", () => {
  it("кто на кого ссылается; самоссылки и несуществующие цели мимо", () => {
    const notes = [
      note("a.md", "Альфа", "см. [[Бета]] и [[Гамма]]"),
      note("b.md", "Бета", "обратно [[альфа]] и [[Альфа]] и [[себя]]"),
      note("c.md", "Гамма", "[[нет такой]]"),
    ];
    const map = buildBacklinks(notes);
    expect(map.get("a.md")?.map((x) => x.file)).toEqual(["b.md"]);
    expect(map.get("b.md")?.map((x) => x.file)).toEqual(["a.md"]);
    // «Гамма» — валидная цель ссылки из a.md; «себя»/«нет такой» — нет
    expect(map.get("c.md")?.map((x) => x.file)).toEqual(["a.md"]);
    // ключей больше, чем реальных целей, не возникает
    expect([...map.keys()].sort()).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("resolveLinks", () => {
  it("resolved без себя, dangling по порядку", () => {
    const notes = [
      note("a.md", "Альфа", "[[Бета]] [[гамма]] [[Альфа]] [[дельта]]"),
      note("b.md", "Бета", ""),
      note("c.md", "Гамма", ""),
    ];
    const { resolved, dangling } = resolveLinks(notes[0]!, notes);
    expect(resolved.map((x) => x.file)).toEqual(["b.md", "c.md"]);
    expect(dangling).toEqual(["дельта"]);
  });
});

describe("buildChainPlan", () => {
  it("обход по ссылкам, цикл обрывается, лимит шагов", () => {
    const notes = [
      note("1.md", "Один", "шаг [[Два]]"),
      note("2.md", "Два", "шаг [[Три]] и [[Один]]"), // цикл на «Один»
      note("3.md", "Три", "конец"),
    ];
    expect(buildChainPlan(notes, "1.md").map((n) => n.file)).toEqual([
      "1.md",
      "2.md",
      "3.md",
    ]);
    // maxSteps режет цепочку
    expect(buildChainPlan(notes, "1.md", 2).map((n) => n.file)).toEqual([
      "1.md",
      "2.md",
    ]);
    // неизвестный старт — пусто
    expect(buildChainPlan(notes, "nope.md")).toEqual([]);
  });
});
