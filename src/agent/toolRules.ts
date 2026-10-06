/**
 * Предчек правил прав в диспетчере инструментов (PLAN §24 шаг 4г) —
 * вынесен из useAgentRun без изменения поведения. Фронтовый предчек
 * сберегает бессмысленное подтверждение; бекенд (perm.rs) всё равно
 * авторитетен — матч здесь best-effort.
 */

import { ruleMatches, type PermRules } from "./permRules";
import { classifyShellRun } from "./shellRules";

export interface ToolRuleVerdict {
  denyHit: boolean;
  alwaysAsk: boolean;
  allowRule: boolean;
}

export function evaluateToolRules(
  name: string,
  rules: PermRules | null | undefined,
  ruleArg: string | null,
  fsTool: boolean,
): ToolRuleVerdict {
  const denyHit = rules ? ruleMatches(rules.deny, name, ruleArg, fsTool) : false;
  let alwaysAsk = false;
  let allowRule = false;
  if (!denyHit && rules) {
    if (name === "shell_run" && ruleArg) {
      // Волна E2: allow не пробивает complex/dangerous (→ обычный
      // mutating-флоу); always_ask на shell спрашивает как обычно
      alwaysAsk = ruleMatches(rules.always_ask, name, ruleArg, false);
      allowRule = !alwaysAsk && classifyShellRun(ruleArg, rules) === "allow";
    } else {
      alwaysAsk = ruleMatches(rules.always_ask, name, ruleArg, fsTool);
      allowRule = ruleMatches(rules.allow, name, ruleArg, fsTool);
    }
  }
  return { denyHit, alwaysAsk, allowRule };
}

/** [P9] Слияние перманентных и сессионных правил: сессионные идут ПОСЛЕ
 *  (ruleMatches ищет первое совпадение — перманентный deny важнее, а
 *  allow-префиксы аддитивны). Чистая функция */
export function mergePermRules(
  base: PermRules | null | undefined,
  extra: PermRules | null | undefined,
): PermRules | null {
  if (!base) return extra ?? null;
  if (!extra) return base;
  return {
    allow: [...base.allow, ...extra.allow.filter((r) => !base.allow.includes(r))],
    deny: [...base.deny, ...extra.deny.filter((r) => !base.deny.includes(r))],
    always_ask: [
      ...base.always_ask,
      ...extra.always_ask.filter((r) => !base.always_ask.includes(r)),
    ],
  };
}

/** [P9] Добавить сессионное allow-правило (кнопка «Разрешить «{p} *» до
 *  конца задачи» в карточке подтверждения). Чистая функция: золотые векторы
 *  в toolRules.test закрепляют дедуп по строке и сохранность deny/always_ask
 *  (аудит A7-12: inline-сборка в useAgentRun была без юнит-теста) */
export function withSessionAllowRule(
  prev: PermRules | null | undefined,
  rule: string,
): PermRules {
  return {
    allow: [...new Set([...(prev?.allow ?? []), rule])],
    deny: prev?.deny ?? [],
    always_ask: prev?.always_ask ?? [],
  };
}
