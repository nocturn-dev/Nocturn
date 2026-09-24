import { describe, expect, it } from "vitest";
import { parseNotePrompt } from "./vault";

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
