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
// Стык front↔perm склеен этим списком, комментариями-зеркалами И
// МЕХАНИЧЕСКОЙ сверкой ниже: тест читает исходник perm.rs и проверяет,
// что match-блок бекенда и isMutatingTool не разъехались (аудит А7-5:
// раньше тест вызывал только фронтовую функцию, и новый мутирующий
// инструмент в perm.rs оставался незамеченным фронтом)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const permSrc = readFileSync(
  fileURLToPath(new URL("../../src-tauri/src/perm.rs", import.meta.url)),
  "utf8",
);
// Парсер привязан к текущему форматированию match-блока: при рефакторинге
// perm.rs тест упадёт громко — обнови якорь (это и есть контракт)
const mutatingBlock =
  permSrc.match(/let mutating = match name \{([\s\S]*?)\n    \};/)?.[1] ?? "";
const exactNames = mutatingBlock
  .split("\n")
  .filter((l) => !l.includes("starts_with"))
  .flatMap((l) => [...l.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))
  .filter((n): n is string => !!n);
const readExempt = [...mutatingBlock.matchAll(/"(?:browser|computer)_[a-z_]+"/g)]
  .map((m) => m[0])
  .filter((n): n is string => !!n)
  .map((n) => n.replaceAll('"', ""));

describe("isMutatingTool — механическое зеркало perm.rs", () => {
  it("каждое точное имя match-блока perm.rs мутирует на фронте", () => {
    expect(exactNames.length).toBeGreaterThan(0);
    for (const n of exactNames) {
      expect(isMutatingTool(n)).toBe(true);
    }
  });

  it("каждое исключение чтения/скриншота perm.rs не мутирует на фронте", () => {
    expect(readExempt).toContain("browser_read");
    expect(readExempt).toContain("computer_screenshot");
    for (const n of readExempt) {
      expect(isMutatingTool(n)).toBe(false);
    }
  });
});

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
