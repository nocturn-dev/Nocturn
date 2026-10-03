/**
 * Зеркало perm-правил (волна E1): парсер/валидатор/матчинг правил прав.
 * Таблицы кейсов держатся синхронно с rust-тестами perm.rs. deny — серверный
 * блок (применяется в perm.rs), allow/always_ask — политика подтверждений
 * ФРОНТА: бекенд их не исполняет (он не может отличить «юзер подтвердил» от
 * «фронт забыл спросить»), жёсткие границы режима правила не пробивают.
 *
 * Матчинг на фронте — best-effort по сырому пути (нормализация регистр/слэши,
 * компонентная граница): промах = лишний вопрос (безопасно), ложный хит
 * отсекается бекендом (deny/sensitive всё равно авторитетны).
 */

export interface PermRules {
  allow: string[];
  deny: string[];
  /** snake_case: контракт serde-структуры perm.rs (настройки без rename) */
  always_ask: string[];
}

export const EMPTY_RULES: PermRules = { allow: [], deny: [], always_ask: [] };

const LS_KEY = "haloui-perm-rules";

/** Событие после сохранения правил секцией «Права» — App перечитывает реф */
export const PERM_RULES_CHANGED = "perm-rules-changed";

export function loadPermRules(): PermRules {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY_RULES };
    const v = JSON.parse(raw) as Partial<PermRules>;
    // Санитизация: только строковые массивы; битое/чужое — дефолт (fail-safe:
    // потеря правил = более строгий ask-флоу, а не слабее)
    const arr = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
    return { allow: arr(v.allow), deny: arr(v.deny), always_ask: arr(v.always_ask) };
  } catch {
    return { ...EMPTY_RULES };
  }
}

export function savePermRules(rules: PermRules): void {
  localStorage.setItem(LS_KEY, JSON.stringify(rules));
  window.dispatchEvent(new CustomEvent(PERM_RULES_CHANGED));
}

export interface ParsedRule {
  tool: string;
  prefix: string | null;
}

export function parseRule(rule: string): ParsedRule | null {
  const r = rule.trim();
  if (!r) return null;
  let tool: string;
  let prefix: string | null = null;
  const i = r.indexOf("(");
  if (i >= 0) {
    if (!r.endsWith(")")) return null;
    tool = r.slice(0, i).trim();
    let inner = r.slice(i + 1, -1);
    if (inner.endsWith("*")) inner = inner.slice(0, -1);
    // звёздочка допустима только замыкающей
    if (inner.includes("*")) return null;
    prefix = inner.trim();
  } else {
    tool = r;
  }
  if (!tool) return null;
  // mcp-имена: mcp__server__tool (разделитель — двойное подчёркивание);
  // существование сервера не проверяем — он может быть ещё не подключён
  const okName = tool.startsWith("mcp__")
    ? (() => {
        const rest = tool.slice(5);
        return (
          rest.length > 0 &&
          rest.includes("__") &&
          rest.split("__").every((s) => s.length > 0)
        );
      })()
    : /^[a-z0-9_]+$/.test(tool);
  if (!okName) return null;
  return { tool, prefix };
}

const FS_TOOLS = new Set(["fs_read", "fs_write", "fs_delete", "fs_list", "fs_grep"]);

/** null — валидно, string — причина отказа (зеркало perm::validate_rule) */
export function validateRule(
  rule: string,
  forAllow: boolean,
  known: Set<string>,
): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return `invalid rule format: ${rule}`;
  const isMcp = parsed.tool.startsWith("mcp__");
  if (!isMcp && !known.has(parsed.tool)) {
    return `unknown tool in rule: ${parsed.tool}`;
  }
  const fsTool = FS_TOOLS.has(parsed.tool);
  if (forAllow && parsed.prefix === null && (parsed.tool === "shell_run" || fsTool)) {
    // bare allow shell_run = Full-режим через боковую дверь; bare allow
    // fs_read снял бы sensitive-deny везде
    return `allow rule for ${parsed.tool} requires a prefix`;
  }
  if (parsed.prefix !== null) {
    if (!parsed.prefix) return `empty prefix in rule: ${rule}`;
    if (fsTool && !(parsed.prefix.includes(":") || parsed.prefix.startsWith("/"))) {
      return `fs prefix must be an absolute path: ${parsed.prefix}`;
    }
  }
  return null;
}

/** Нормализация пути для матчинга: регистр + разделители (зеркало
    norm_for_compare; 8.3/симлинки разворачивает бекенд — фронтовый матч
    best-effort, авторитетен только сервер) */
function normPath(p: string): string {
  return p.toLowerCase().replaceAll("\\", "/");
}

/** Матч списка правил против (tool, arg). arg для fs_* — путь (компонентная
    граница), для shell_run — команда case-insensitive с границей слова
    («git *» не матчит «github-cli»). Битые правила не матчатся */
export function ruleMatches(
  rules: string[],
  tool: string,
  arg: string | null | undefined,
  argIsPath: boolean,
): boolean {
  for (const r of rules) {
    const p = parseRule(r);
    if (!p || p.tool !== tool) continue;
    if (p.prefix === null) return true; // bare: весь инструмент
    if (!p.prefix || !arg) continue;
    const hit = argIsPath
      ? (() => {
          const pn = normPath(p.prefix as string);
          const an = normPath(arg);
          return an === pn || (an.startsWith(pn) && an[pn.length] === "/");
        })()
      : (() => {
          const pl = (p.prefix as string).toLowerCase();
          const al = arg.toLowerCase();
          return al === pl || al.startsWith(`${pl} `);
        })();
    if (hit) return true;
  }
  return false;
}
