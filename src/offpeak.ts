/**
 * Идл-очередь задач (offpeak) — паттерн ZCode, блок 12 шаг 3, чистая комната:
 * задачи без расписания, исполняются, когда клиент простаивает — движок
 * свободен и пользователь не активен заданный порог. Всё локально.
 *
 * Модуль чистый (без React): модель, персист, гейт простоя, FIFO-выбор.
 * Исполнение — в App.tsx по образцу runChain (сессия «🌙 …» + handleSend
 * с guard'ом runStartedRef).
 */

export interface OffPeakTask {
  id: string;
  /** Промт задачи (уходит агенту как обычное сообщение) */
  text: string;
  /** Краткое имя (первая непустая строка промта) */
  title: string;
  createdAt: number;
  /** running — отправлена в движок; при рестарте приложения возвращается
   *  в waiting (sanitize): прогон не должен теряться */
  status: "waiting" | "running" | "done" | "failed";
  ranAt?: number;
  error?: string;
}

const LS_KEY = "haloui-offpeak";
/** Хвост очереди не растёт бесконечно: done/failed старше суток чистятся */
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TASKS = 50;

/** Короткое имя из промта: первая непустая строка, обрезка 60 */
export function offPeakTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "Без названия";
  const t = line.trim();
  return t.length > 60 ? t.slice(0, 59) + "…" : t;
}

/** Санитизация при загрузке: мусор → пустой список, поля добираются дефолтами */
export function sanitizeOffPeak(raw: unknown): OffPeakTask[] {
  if (!Array.isArray(raw)) return [];
  const out: OffPeakTask[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const p = r as Record<string, unknown>;
    if (typeof p.id !== "string" || !p.id) continue;
    if (typeof p.text !== "string" || !p.text.trim()) continue;
    const status =
      // running при загрузке = приложение перезапустилось посреди прогона —
      // задача возвращается в очередь, а не зависает навсегда
      p.status === "done" || p.status === "failed"
        ? p.status
        : p.status === "running"
          ? "waiting"
          : "waiting";
    out.push({
      id: p.id,
      text: p.text,
      title: typeof p.title === "string" && p.title ? p.title : offPeakTitle(p.text),
      createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
      status,
      ranAt: typeof p.ranAt === "number" ? p.ranAt : undefined,
      error: typeof p.error === "string" ? p.error : undefined,
    });
  }
  return out.slice(0, MAX_TASKS);
}

export function loadOffPeak(): OffPeakTask[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return sanitizeOffPeak(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveOffPeak(list: OffPeakTask[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

/**
 * Гейт простоя: движок свободен (нет активного стрима) И пользователь не
 * активен дольше порога. now/lastActivity в мс — чистая функция для тестов.
 */
export function isIdle(
  now: number,
  lastActivity: number,
  streaming: boolean,
  idleMs = 120_000,
): boolean {
  if (streaming) return false;
  return now - lastActivity >= idleMs;
}

/** FIFO: первая waiting-задача */
export function nextWaiting(list: OffPeakTask[]): OffPeakTask | null {
  return list.find((t) => t.status === "waiting") ?? null;
}

/** Прореживание: done/failed старше TTL и лишние сверх MAX_TASKs.
 *  waiting/running не трогаем — это живая очередь */
export function pruneOffPeak(list: OffPeakTask[], now: number): OffPeakTask[] {
  const kept = list.filter(
    (t) =>
      t.status === "waiting" ||
      t.status === "running" ||
      t.ranAt === undefined ||
      now - t.ranAt < DONE_TTL_MS,
  );
  return kept.slice(0, MAX_TASKS);
}

/** Добавить задачу (текст непустой) — в конец очереди waiting */
export function addOffPeakTask(list: OffPeakTask[], text: string, now: number): OffPeakTask[] {
  const t = text.trim();
  if (!t) return list;
  const task: OffPeakTask = {
    id: `op-${now}-${Math.random().toString(36).slice(2, 8)}`,
    text: t,
    title: offPeakTitle(t),
    createdAt: now,
    status: "waiting",
  };
  return [...list, task].slice(0, MAX_TASKS);
}
