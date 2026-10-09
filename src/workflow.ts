/**
 * Workflow-оркестратор v1 (блок 12 шаг 6, паттерн-референс — чистая комната):
 * именованный сценарий из шагов-субагентов. Шаги исполняются по порядку,
 * выход шага попадает в переменные и подставляется в промты последующих
 * шагов через {{stepId}}. Провал шага роняет сценарий, если шаг не помечен
 * continueOnError. Модуль чистый: разбор, валидация, интерполяция — тесты
 * без React; исполнение (runSubagent) — в useAgentRun.
 */

export interface WorkflowStep {
  /** Идентификатор шага: ключ переменной {{id}} */
  id: string;
  /** Промт шага (интерполируется выходами предыдущих шагов) */
  prompt: string;
  /** Роль субагента из SUBAGENT_ROLES; отсутствует — дефолт исполнителя */
  role?: string;
  /** Провал шага не роняет сценарий — в переменную пишется текст ошибки */
  continueOnError?: boolean;
}

export interface WorkflowDef {
  name: string;
  steps: WorkflowStep[];
}

const MAX_STEPS = 20;
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** Разбор и валидация сценария: не объект/пустые шаги/дубли id/чужая роль —
 *  осмысленная ошибка (уходит модели в результат инструмента) */
export function parseWorkflow(
  raw: unknown,
  allowedRoles?: ReadonlySet<string>,
): { ok: true; def: WorkflowDef } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "workflow must be an object {name, steps[]}" };
  }
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 60) : "";
  if (!name) return { ok: false, error: "workflow.name is required" };
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    return { ok: false, error: "workflow.steps must be a non-empty array" };
  }
  if (p.steps.length > MAX_STEPS) {
    return { ok: false, error: `workflow.steps: max ${MAX_STEPS}` };
  }
  const seen = new Set<string>();
  const steps: WorkflowStep[] = [];
  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i] as unknown;
    if (typeof s !== "object" || s === null) {
      return { ok: false, error: `steps[${i}]: must be an object` };
    }
    const st = s as Record<string, unknown>;
    const id = typeof st.id === "string" ? st.id : "";
    if (!ID_RE.test(id)) {
      return {
        ok: false,
        error: `steps[${i}].id: required, [a-zA-Z0-9_-] up to 32 chars`,
      };
    }
    if (seen.has(id)) return { ok: false, error: `steps[${i}].id: duplicate "${id}"` };
    seen.add(id);
    if (typeof st.prompt !== "string" || !st.prompt.trim()) {
      return { ok: false, error: `steps[${i}].prompt: required non-empty string` };
    }
    const role = typeof st.role === "string" ? st.role : undefined;
    if (role !== undefined && allowedRoles && !allowedRoles.has(role)) {
      return { ok: false, error: `steps[${i}].role: unknown role "${role}"` };
    }
    steps.push({
      id,
      prompt: st.prompt,
      role,
      continueOnError: st.continueOnError === true,
    });
  }
  return { ok: true, def: { name, steps } };
}

/**
 * Подстановка {{stepId}} выходами предыдущих шагов. Ссылка на неизвестную
 * переменную остаётся литералом — модель увидит её как есть и поймёт сама.
 */
export function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m,
  );
}
