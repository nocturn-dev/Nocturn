import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, buildSkillRun } from "./skills";

describe("buildSkillRun ([P12])", () => {
  it("неизвестный id — ошибка с именованием", () => {
    const r = buildSkillRun(BUILTIN_SKILLS, "nope", "");
    expect("error" in r && r.error).toBe('unknown skill "nope"');
  });

  it("инструкция скилла = задача; args дописываются материалом", () => {
    const r = buildSkillRun(BUILTIN_SKILLS, "review", "");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.task.startsWith("[Скил: Code Review]")).toBe(true);
    const r2 = buildSkillRun(BUILTIN_SKILLS, "review", "код: x=1");
    if ("error" in r2) return;
    expect(r2.task.endsWith("код: x=1")).toBe(true);
  });

  it("id регистронезависим, allowlist и model доезжают из скилла", () => {
    const r = buildSkillRun(BUILTIN_SKILLS, "WIKI", "");
    if ("error" in r) throw new Error("wiki must resolve");
    expect(r.tools).toEqual(["fs_read", "fs_list", "fs_write", "fs_grep"]);
    // model не задан — undefined (модель главного агента)
    expect(r.model).toBeUndefined();
    const custom = [
      ...BUILTIN_SKILLS,
      { id: "cheap", name: "Cheap", prompt: "do", model: "haiku" },
    ];
    const r2 = buildSkillRun(custom, "cheap", "");
    if ("error" in r2) throw new Error("cheap must resolve");
    expect(r2.model).toBe("haiku");
  });

  it("скилл без allowedTools — null (read-only набор runSubagent)", () => {
    const r = buildSkillRun(BUILTIN_SKILLS, "review", "");
    if ("error" in r) throw new Error("review must resolve");
    expect(r.tools).toBeNull();
  });
});
