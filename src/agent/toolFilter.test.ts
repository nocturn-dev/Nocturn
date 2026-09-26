import { describe, expect, it } from "vitest";
import { filterToolSchemas } from "./toolFilter";

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
