/**
 * Статический анализ shell-команд для правил прав (волна E2). Бекенд матчит
 * deny/allow по сырому префиксу строки (без AST — сложная команда deny не
 * обходит); этот модуль решает ТОЛЬКО политику подтверждений фронта:
 * allow-правило не пробивает сложные (цепочки/пайпы/подстановки) и
 * dangerous-команды — они идут обычным ask-флоу. В Full-режиме dangerous
 * не спрашивает (Full = явный отказ от вопросов), deny-правила владельца
 * работают всегда.
 */
import { ruleMatches, type PermRules } from "./permRules";

/** Первые токены-обёртки: «allow bash *» ≈ «allow всё» — префикс невалиден */
export const BARE_SHELL_FIRST = new Set([
  "bash",
  "sh",
  "zsh",
  "cmd",
  "pwsh",
  "powershell",
  "xargs",
  "env",
  "sudo",
  "doas",
  "nohup",
  "timeout",
  "nice",
  "start",
  "call",
]);

/** Quote-aware токенизация (двойные/одинарные кавычки склеивают токен) */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** «Простая» команда: без цепочек (&& || ; | &), подстановок ($(` ${) и
 *  редиректов (< >) ВНЕ кавычек. echo "a && b" — простая; скан
 *  quote-aware, экранирование внутри кавычек уважается */
export function isSimpleShellCommand(cmd: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") return false;
    if (ch === "`") return false;
    if (ch === "<" || ch === ">") return false;
    if (ch === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) return false;
  }
  return true;
}

/** 2-токенный префикс (CC-паттерн своими словами): «git commit» из
 *  «git commit -m x». Второй токен обязан выглядеть сабкомандой (слово, не
 *  флаг, не путь); обёртки из BARE_SHELL_FIRST и сложные команды → null */
export function extractCommandPrefix(cmd: string): string | null {
  if (!isSimpleShellCommand(cmd)) return null;
  const toks = tokenizeCommand(cmd);
  if (toks.length === 0) return null;
  const first = (toks[0] as string).toLowerCase();
  if (BARE_SHELL_FIRST.has(first)) return null;
  if (toks.length === 1) return first;
  const second = toks[1] as string;
  if (/^[a-z][a-z0-9_-]*$/i.test(second) && !/[\\/]/.test(second)) {
    return `${first} ${second.toLowerCase()}`;
  }
  return first;
}

/** Dangerous-класс: allow-префикс их не покрывает (→ обычный ask-флоу).
 *  Regex по нижнему регистру всей строки: false positive уводит в ask —
 *  безопасное направление */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\beval\b/, // eval $() и «echo eval» — жертвуем точностью ради ask
  /\b(python3?|node|perl|php|ruby|lua)\b[^;&|]*\s-[ce]\b/, // интерпретаторы -c/-e
  /\b(curl|wget)\b[^;&|]*\|\s*(ba|z|fi|da)?sh\b/, // curl … | sh
  /\brm\s+[^;&|]*-[a-z]*r[a-z]*f/, // rm -rf (цели проверяет юзер вопросом)
  /\bdd\b[^;&|]*of=\/dev\//,
  /\bmkfs/,
  /\bchmod\b[^;&|]*-r\b[^;&|]*777/,
];

export function dangerousShellPattern(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  return DANGEROUS_PATTERNS.some((re) => re.test(lower));
}

export type ShellVerdict = "deny" | "allow" | "neutral";

/** Классификация shell_run для политики подтверждений: deny — сырой
 *  префикс-матч (бекенд отклонит и так, фронт сберегает вопрос); allow —
 *  только простая команда под allow-префикс; всё остальное — neutral
 *  (обычный mutating-флоу: ask в Ask/Edit, исполнение в Full) */
export function classifyShellRun(cmd: string, rules: PermRules): ShellVerdict {
  if (ruleMatches(rules.deny, "shell_run", cmd, false)) return "deny";
  if (dangerousShellPattern(cmd)) return "neutral";
  if (isSimpleShellCommand(cmd) && ruleMatches(rules.allow, "shell_run", cmd, false)) {
    return "allow";
  }
  return "neutral";
}
