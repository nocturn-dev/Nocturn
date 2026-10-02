import { describe, expect, it } from "vitest";
import { filterToolSchemas, isMutatingTool } from "./toolFilter";

const schema = (name: string) => ({ type: "function", function: { name } });
const names = (out: unknown) =>
  (out as Array<{ function?: { name?: string } }>)
    .map((x) => x?.function?.name)
    .filter((n): n is string => n !== undefined);

describe("filterToolSchemas", () => {
  it("убирает отключённые пользователем инструменты", () => {
    const out = filterToolSchemas(
      [schema("fs_read"), schema("shell_run"), schema("mcp__srv__t")],
      { disabled: ["shell_run", "mcp__srv__t"] },
    );
    expect(names(out)).toEqual(["fs_read"]);
  });

  it("убирает subagent_run только когда субагенты выключены", () => {
    const list = [schema("fs_read"), schema("subagent_run")];
    expect(names(filterToolSchemas(list, { removeSubagent: true }))).toEqual([
      "fs_read",
    ]);
    expect(names(filterToolSchemas(list, {}))).toEqual(["fs_read", "subagent_run"]);
  });

  it("убирает memory_* только когда память выключена", () => {
    const list = [schema("fs_read"), schema("memory_save"), schema("memory_recall")];
    expect(names(filterToolSchemas(list, { removeMemory: true }))).toEqual([
      "fs_read",
    ]);
    expect(names(filterToolSchemas(list, {}))).toEqual([
      "fs_read",
      "memory_save",
      "memory_recall",
    ]);
  });

  it("пустой/отсутствующий список ничего не убирает", () => {
    const list = [schema("a"), schema("b")];
    expect(names(filterToolSchemas(list, { disabled: [] }))).toEqual(["a", "b"]);
    expect(names(filterToolSchemas(list, {}))).toEqual(["a", "b"]);
  });

  it("не-массив возвращается как есть, элементы без имени не теряются", () => {
    expect(filterToolSchemas("oops", { disabled: ["a"] })).toBe("oops");
    const weird = [schema("a"), { custom: true }, null];
    expect(filterToolSchemas(weird, { disabled: ["a"] })).toEqual([
      { custom: true },
      null,
    ]);
  });
});

// Золотой список: ДОСЛОВНОЕ зеркало perm.rs (is_mutating, perm.rs:74-81).
// Стык front↔perm склеен только этим тестом и комментариями-зеркалами —
// при добавлении инструмента правь ОБЕ стороны и этот список вместе с ними.
describe("isMutatingTool — золотой список perm.rs", () => {
  it("мутирующие точные имена", () => {
    expect(
      ["shell_run", "fs_write", "fs_delete", "vault_write", "memory_save", "image_generate"].every(
        (n) => isMutatingTool(n),
      ),
    ).toBe(true);
  });

  it("mcp__* — всегда мутирующий", () => {
    expect(isMutatingTool("mcp__anything")).toBe(true);
    expect(isMutatingTool("mcp__server__tool")).toBe(true);
  });

  it("browser_*/computer_*: чтение и скриншот безопасны, действия — нет", () => {
    expect(isMutatingTool("browser_read")).toBe(false);
    expect(isMutatingTool("browser_screenshot")).toBe(false);
    expect(isMutatingTool("browser_navigate")).toBe(true);
    expect(isMutatingTool("browser_click")).toBe(true);
    expect(isMutatingTool("computer_screenshot")).toBe(false);
    expect(isMutatingTool("computer_key")).toBe(true);
    expect(isMutatingTool("computer_click")).toBe(true);
  });

  it("читающие инструменты не мутируют", () => {
    expect(
      ["fs_read", "fs_list", "fs_grep", "vault_read", "vault_search", "memory_recall", "web_search"].every(
        (n) => !isMutatingTool(n),
      ),
    ).toBe(true);
  });

  it("неизвестное имя — не мутирующий (бекенд решает по своему списку)", () => {
    expect(isMutatingTool("future_tool")).toBe(false);
  });
});
