/**
 * Локальная агрегация для «Обзора» (Reflect): сессии, журнал использования,
 * факты памяти и заметки сводятся за период. Чистые функции — без IPC и
 * времени «сейчас» (передаётся параметром) — чтобы тесты были детерминированы.
 * Рефлексия текстом строится из этого же набора данных (ReflectSection).
 */
import type { Session, UsageEvent } from "./types";
import { dayKeyLocal } from "./time";

const DAY_MS = 86_400_000;

export interface ReflectInput {
  sessions: Session[];
  usage: UsageEvent[];
  /** Факты памяти (ts — миллисекунды) */
  facts: { ts: number }[];
  /** Заметки (updated — СЕКУНДЫ, так отдаёт notes_list) */
  notes: { updated: number }[];
  nowMs: number;
  days: number;
}

export interface StalledPlan {
  id: string;
  title: string;
  inProgress: number;
  pending: number;
}

export interface ReflectData {
  sinceMs: number;
  /** Задач создано за период (архив не считается) */
  tasksCreated: number;
  /** Задач с активностью за период */
  tasksTouched: number;
  /** Пользовательских сообщений за период */
  userMsgs: number;
  tokens: { prompt: number; completion: number };
  /** Новых фактов памяти и изменённых заметок за период */
  newFacts: number;
  notesTouched: number;
  /** Незавершённые планы (самые свежие сверху), максимум 5 */
  stalled: StalledPlan[];
}

/** Момент последней активности задачи: updatedAt, иначе последний ts
 *  сообщения, иначе createdAt (у старых сессий ts у сообщений отсутствует) */
export function sessionLastActive(s: Session): number {
  let latest = s.updatedAt ?? s.createdAt;
  for (const m of s.messages) {
    if (m.ts != null && m.ts > latest) latest = m.ts;
  }
  return Math.max(latest, s.createdAt);
}

export function buildReflect(input: ReflectInput): ReflectData {
  const sinceMs = input.nowMs - input.days * DAY_MS;
  const alive = input.sessions.filter((s) => !s.archived);

  const tasksCreated = alive.filter((s) => s.createdAt >= sinceMs).length;
  const tasksTouched = alive.filter((s) => sessionLastActive(s) >= sinceMs).length;
  let userMsgs = 0;
  for (const s of alive) {
    for (const m of s.messages) {
      if (m.role === "user" && m.ts != null && m.ts >= sinceMs) userMsgs += 1;
    }
  }

  // Журнал использования — по ключу дня (локальной даты), граница включительно
  let prompt = 0;
  let completion = 0;
  for (const e of input.usage) {
    if (e.day >= dayKeyLocal(new Date(sinceMs))) {
      prompt += e.prompt;
      completion += e.completion;
    }
  }

  const stalled: StalledPlan[] = alive
    .filter((s) => {
      const plan = s.plan ?? [];
      return plan.some((p) => p.status !== "done");
    })
    .sort((a, b) => sessionLastActive(b) - sessionLastActive(a))
    .slice(0, 5)
    .map((s) => {
      const plan = s.plan ?? [];
      return {
        id: s.id,
        title: s.title,
        inProgress: plan.filter((p) => p.status === "in_progress").length,
        pending: plan.filter((p) => p.status === "pending").length,
      };
    });

  return {
    sinceMs,
    tasksCreated,
    tasksTouched,
    userMsgs,
    tokens: { prompt, completion },
    newFacts: input.facts.filter((f) => f.ts >= sinceMs).length,
    notesTouched: input.notes.filter((n) => n.updated * 1000 >= sinceMs).length,
    stalled,
  };
}

/** Плоский текстовый дайджест для модели: те же числа, что видит пользователь.
 *  Локализованные подписи подставляет вызывающий (labels) — агрегация остаётся
 *  чистой и не зависит от языка */
export function buildReflectPrompt(
  data: ReflectData,
  labels: Record<string, string>,
): string {
  const lines: string[] = [];
  const push = (k: string, v: string | number) => lines.push(`${labels[k]}: ${v}`);
  push("tasksCreated", data.tasksCreated);
  push("tasksTouched", data.tasksTouched);
  push("userMsgs", data.userMsgs);
  push("tokens", data.tokens.prompt + data.tokens.completion);
  push("facts", data.newFacts);
  push("notes", data.notesTouched);
  if (data.stalled.length > 0) {
    lines.push(
      `${labels.stalled}: ${data.stalled
        .map(
          (s) =>
            `"${s.title}" (${s.inProgress} ${labels.inProgress} / ${s.pending} ${labels.pending})`,
        )
        .join(", ")}`,
    );
  } else {
    lines.push(`${labels.stalled}: ${labels.none}`);
  }
  return lines.join("\n");
}
