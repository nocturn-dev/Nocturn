/**
 * Статический анализ shell-команд для правил прав. Бекенд матчит
 * deny/allow по сырому префиксу строки (без AST — сложная команда deny не
 * обходит); этот модуль решает ТОЛЬКО политику подтверждений фронта:
 * allow-правило не пробивает сложные (цепочки/пайпы/подстановки) и
 * dangerous-команды — они идут обычным ask-флоу. В Full-режиме dangerous
 * не спрашивает (Full = явный отказ от вопросов), deny-правила пользователя
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
    // Перенос строки — тот же разделитель команд, что и «;»: «ls\nrm -rf /»
    // без этой проверки выглядит одной безобидной командой
    if (ch === "\n" || ch === "\r") return false;
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
  // Явный гард вдобавок к isSimpleShellCommand: префикс первой строки не
  // покрывает остальные — кнопка «по префиксу» на такой команде не должна
  // появляться вовсе
  if (/[\r\n]/.test(cmd)) return null;
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
  /\brm\s+[^;&|]*-[a-z]*(rf|fr)\b/, // rm -rf/-fr (цели проверяет юзер вопросом)
  // rm: рекурсия+force в РАЗНЫХ кластерах/порядке — «-r -f», «-f -r»,
  // «--recursive --force» старый кластерный паттерн пропускал
  /\brm\s+[^;&|]*(-r\b|--recursive)\b[^;&|]*(-+[a-z]*f\b|--force)/,
  /\brm\s+[^;&|]*(-f\b|--force)\b[^;&|]*(-r\b|--recursive)/,
  /\bdd\b[^;&|]*of=\/dev\//,
  /\bmkfs/,
  /\bchmod\b[^;&|]*-r\b[^;&|]*777/,
  // Windows/PowerShell-диалект: shell_run на Windows исполняет через
  // powershell, а список ниже был POSIX-центричен — Remove-Item -Recurse
  // и дисковые операции уходили в allow без вопроса.

  // False positive уводит в ask — безопасное направление
  /\bremove-item\b[^;&|]*-[a-z]*r/, // Remove-Item -Recurse [-Force]
  /\b(ri|erase)\b[^;&|]*-[a-z]*r/, // алиасы Remove-Item с рекурсией
  /\bremove-itemproperty\b/, // чистка свойств — всегда вопрос
  /\breg\s+(add|delete)\b/, // запись/удаление в реестре
  /\b(format-volume|clear-disk)\b/, // дисковые операции PS (format c: — выше)
  /\bwsl\b[^;&|]*--unregister\b/, // снос дистрибутива WSL
  /\b(rd|rmdir)\b[^;&|]*\/s\b/, // rd /s /q — деревo каталогов
  /\bdel\b[^;&|]*\/s\b/, // del /s — деревo файлов
  /\bformat\b[^;&|]*[a-z]:/, // format c:
  /\bdiskpart\b/,
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
  // Перенос строки дробит команду на несколько: allow-префикс первого
  // сегмента не прикрывает последующие — каждый сегмент проверяется сам
  // по себе (simple, dangerous, allow-матч), иначе «ls\nrm -rf /» прошёл бы
  // как продолжение разрешённой команды
  const segments = cmd.split(/[\r\n]+/).filter((s) => s.trim());
  // Пустая команда не «разрешена по умолчанию» — every() на пустом списке
  // вернул бы true
  if (segments.length === 0) return "neutral";
  if (segments.some((s) => dangerousShellPattern(s))) return "neutral";
  if (
    segments.every(
      (s) => isSimpleShellCommand(s) && ruleMatches(rules.allow, "shell_run", s, false),
    )
  ) {
    return "allow";
  }
  return "neutral";
}
