import { describe, expect, it } from "vitest";
import { interpolate, parseWorkflow } from "./workflow";

const ROLES = new Set(["researcher", "coder", "critic", "librarian"]);

describe("parseWorkflow", () => {
  it("валидный сценарий разбирается", () => {
    const out = parseWorkflow(
      {
        name: "Ревизия",
        steps: [
          { id: "scan", prompt: "Осмотри {{dir}}", role: "researcher" },
          { id: "fix", prompt: "Отчёт: {{scan}}" },
        ],
      },
      ROLES,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.def.name).toBe("Ревизия");
      expect(out.def.steps).toHaveLength(2);
      expect(out.def.steps[1]!.role).toBeUndefined();
    }
  });

  it("не-объект / пустые шаги / лишние шаги — ошибка", () => {
    expect(parseWorkflow("x", ROLES).ok).toBe(false);
    expect(parseWorkflow({ name: "n", steps: [] }, ROLES).ok).toBe(false);
    expect(
      parseWorkflow(
        { name: "n", steps: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, prompt: "p" })) },
        ROLES,
      ).ok,
    ).toBe(false);
  });

  it("дубликат id и кривой id — ошибка", () => {
    expect(
      parseWorkflow({ name: "n", steps: [{ id: "a", prompt: "p" }, { id: "a", prompt: "q" }] }, ROLES)
        .ok,
    ).toBe(false);
    expect(
      parseWorkflow({ name: "n", steps: [{ id: "плохой id", prompt: "p" }] }, ROLES).ok,
    ).toBe(false);
  });

  it("чужая роль — ошибка при заданном списке", () => {
    const out = parseWorkflow(
      { name: "n", steps: [{ id: "a", prompt: "p", role: "hacker" }] },
      ROLES,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("hacker");
    // Без списка ролей проверка пропускается (разрешение на исполнении)
    expect(parseWorkflow({ name: "n", steps: [{ id: "a", prompt: "p", role: "hacker" }] }).ok).toBe(
      true,
    );
  });
});

describe("interpolate", () => {
  it("подставляет известные переменные", () => {
    expect(interpolate("Отчёт: {{scan}}, всего {{scan}} строк", { scan: "12 файлов" })).toBe(
      "Отчёт: 12 файлов, всего 12 файлов строк",
    );
  });
  it("неизвестная переменная остаётся литералом", () => {
    expect(interpolate("{{ nope }} {{yes}}", { yes: "да" })).toBe("{{ nope }} да");
  });
  it("пробелы в скобках допустимы", () => {
    expect(interpolate("{{  x  }}", { x: "v" })).toBe("v");
  });
});
