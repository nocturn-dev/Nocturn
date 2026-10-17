/**
 * Хелперы аргументов инструментальных вызовов — вынесены
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

/** аргумент матчинга правил — команда shell_run / путь fs_*;
 *  bare-правила матчат инструмент и без аргумента */
export const ruleArgument = (call: ToolCallInfo): string | null => {
  try {
    const p = JSON.parse(call.arguments) as {
      path?: unknown;
      file?: unknown;
      dir?: unknown;
      command?: unknown;
    };
    if (call.name === "shell_run") {
      return typeof p.command === "string" ? p.command : null;
    }
    if (call.name.startsWith("fs_")) {
      // Схемы fs_* исторически несут путь в разных ключах (path/file/dir):
      // правило по пути обязано видеть все — иначе allow/deny молча
      // не матчится
      for (const k of ["path", "file", "dir"] as const) {
        if (typeof p[k] === "string") return p[k];
      }
      return null;
    }
  } catch {
    // не JSON — правила по аргументу не матчим (bare-правила всё равно работают)
  }
  return null;
};
