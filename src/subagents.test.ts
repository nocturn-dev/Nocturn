import { describe, expect, it } from "vitest";
import {
  FALLBACK_ROLE,
  resolveSubagentRole,
  resolveWorkflowRole,
  SUBAGENT_ROLES,
  type SubagentRole,
} from "./subagents";

const custom: SubagentRole[] = [
  { id: "reviewer", name: "Reviewer", tools: null, maxSteps: 4, systemPrompt: "rev" },
  { id: "coder", name: "Coder", tools: null, maxSteps: 8, systemPrompt: "code" },
];

describe("resolveSubagentRole (цепочка subagent_run)", () => {
  it("запрошенная роль находится", () => {
    expect(resolveSubagentRole("reviewer", custom).id).toBe("reviewer");
  });
  it("неизвестная → builtin[0] (цепочка БЕЗ шага roles[0] — как было)", () => {
    // У subagent-цепочки после find сразу SUBAGENT_ROLES[0]: custom[0]
    // (reviewer) НЕ выбирается — поведение оригинала сохранено
    expect(resolveSubagentRole("nope", custom).id).toBe(SUBAGENT_ROLES[0]!.id);
  });
  it("пустой список → builtin[0] целиком (с desc); литеральный фолбэк — на строгие индексы", () => {
    expect(resolveSubagentRole("x", [])).toEqual(SUBAGENT_ROLES[0]);
    // Фолбэк — урезанный литерал из оригинала (без desc)
    expect(FALLBACK_ROLE).toEqual({
      id: "researcher",
      name: "Researcher",
      tools: null,
      maxSteps: 8,
      systemPrompt: "",
    });
  });
});

describe("resolveWorkflowRole (цепочка workflow-шага)", () => {
  it("шаговая роль → coder-предпочтение → первая → builtin[0] → фолбэк", () => {
    expect(resolveWorkflowRole("reviewer", custom).id).toBe("reviewer");
    // шаг просит несуществующую — цепочка падает на coder
    expect(resolveWorkflowRole("nope", custom).id).toBe("coder");
    // coder нет в списке — первая роль
    expect(resolveWorkflowRole("nope", [custom[0]!]).id).toBe("reviewer");
    expect(resolveWorkflowRole("nope", []).id).toBe(SUBAGENT_ROLES[0]!.id);
    expect(resolveWorkflowRole("nope", [])).toEqual(
      // SUBAGENT_ROLES[0] существует по построению; фолбэк — на случай строгих индексов
      resolveSubagentRole("__", []),
    );
    expect(FALLBACK_ROLE.id).toBe("researcher");
  });
});
