/**
 * Хелперы аргументов инструментальных вызовов (PLAN §24 шаг 4б) — вынесены
 * из useAgentRun без изменения поведения: чистые функции, тестируемые
 * таблично. Ни один из них не знает про React/стейт.
 */

import type { ToolCallInfo } from "../types";

/** HTTP-код из строки ошибки Rust-стрима ("HTTP 503: …") */
export function parseHttpCode(raw: string): number | null {
  const m = raw.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** Ключ разрешения «всегда для задачи»: имя инструмента + аргументы. Раньше
 *  хранились одни аргументы — разрешение на один инструмент с `{}` покрывало
 *  любой другой мутирующий инструмент с теми же аргументами. Имя функции не
 *  содержит пробелов, поэтому первый пробел однозначно делит ключ */
export const allowKey = (call: ToolCallInfo) => `${call.name} ${call.arguments}`;

/** Волна E1: аргумент матчинга правил — команда shell_run / путь fs_*;
 *  bare-правила матчат инструмент и без аргумента */
export const ruleArgument = (call: ToolCallInfo): string | null => {
  try {
    const p = JSON.parse(call.arguments) as { path?: unknown; command?: unknown };
    if (call.name === "shell_run") {
      return typeof p.command === "string" ? p.command : null;
    }
    if (call.name.startsWith("fs_")) {
      return typeof p.path === "string" ? p.path : null;
    }
  } catch {
    // не JSON — правила по аргументу не матчим (bare-правила всё равно работают)
  }
  return null;
};
