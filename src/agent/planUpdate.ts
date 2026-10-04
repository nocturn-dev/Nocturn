/**
 * Валидация plan_update (PLAN §24 шаг 4б) — вынесена из useAgentRun без
 * изменения поведения: модель присылает tasks массивом, мусорные элементы
 * (пустой title, статус вне enum, не-объекты) выкидываются молча — план
 * обновляется тем, что валидно.
 */

import type { PlanTask } from "../types";

export function parsePlanTasks(raw: unknown): PlanTask[] {
  return Array.isArray(raw)
    ? raw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t) => ({
          title: typeof t.title === "string" ? t.title.trim() : "",
          status: t.status as PlanTask["status"],
        }))
        .filter(
          (t) =>
            t.title.length > 0 &&
            (t.status === "pending" ||
              t.status === "in_progress" ||
              t.status === "done"),
        )
    : [];
}
