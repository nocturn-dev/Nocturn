import { describe, expect, it } from "vitest";
import { allowKey, parseHttpCode, ruleArgument } from "./toolArgs";
import type { ToolCallInfo } from "../types";

const call = (name: string, args: string): ToolCallInfo => ({
  id: "t1",
  name,
  arguments: args,
});

describe("parseHttpCode", () => {
  it("извлекает код из строки ошибки стрима", () => {
    expect(parseHttpCode("HTTP 503: service unavailable")).toBe(503);
    expect(parseHttpCode("provider said HTTP 429 too many requests")).toBe(429);
    expect(parseHttpCode("HTTP 500 and again HTTP 404 — берёт первый")).toBe(500);
  });
  it("без кода — null", () => {
    expect(parseHttpCode("no status here")).toBeNull();
    expect(parseHttpCode("")).toBeNull();
    // Трёхзначное не-HTTP число кодом не считается
    expect(parseHttpCode("error 500 inline")).toBeNull();
  });
});

describe("allowKey", () => {
  it("имя + аргументы: разные инструменты с теми же аргументами — разные ключи", () => {
    expect(allowKey(call("fs_write", "{}"))).toBe('fs_write {}');
    expect(allowKey(call("shell_run", "{}"))).toBe('shell_run {}');
  });
  it("одинаковый вызов — одинаковый ключ (память «всегда для задачи»)", () => {
    expect(allowKey(call("shell_run", '{"command":"git status"}'))).toBe(
      allowKey(call("shell_run", '{"command":"git status"}')),
    );
  });
});

describe("ruleArgument", () => {
  it("shell_run → command", () => {
    expect(ruleArgument(call("shell_run", '{"command":"git push"}'))).toBe("git push");
  });
  it("fs_* → path", () => {
    expect(ruleArgument(call("fs_write", '{"path":"C:\\\\p"}'))).toBe("C:\\p");
    expect(ruleArgument(call("fs_read", '{"path":"/a"}'))).toBe("/a");
  });
  it("не fs_/shell инструмент — null", () => {
    expect(ruleArgument(call("browser_read", '{"path":"/a"}'))).toBeNull();
  });
  it("не JSON / нет нужного поля / не строка — null", () => {
    expect(ruleArgument(call("shell_run", "not json"))).toBeNull();
    expect(ruleArgument(call("shell_run", "{}"))).toBeNull();
    expect(ruleArgument(call("fs_write", '{"path":42}'))).toBeNull();
  });
});
