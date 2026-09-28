/**
 * Автоматизации: запланированные задачи агента.
 * Расписание хранится локально (localStorage), движок в App.tsx раз в
 * полминуты проверяет срок и создаёт задачу с промтом шаблона.
 * Приватность: никакой «облачной» части — всё исполняет локальный клиент
 * через выбранного пользователем провайдера.
 */

import type { MsgKey } from "./locales";

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "interval"; minutes: number };

export interface Automation {
  id: string;
  name: string;
  /** Промт, который отправляется агенту при запуске */
  prompt: string;
  schedule: Schedule;
  /** Метка времени следующего запуска */
  nextRunAt: number;
  /** Последний запуск (0 — ещё не запускалась) */
  lastRunAt: number;
  enabled: boolean;
  createdAt: number;
  /** История запусков (метки времени, последние 10) */
  runs?: number[];
  /** Писать отчёт в заметку vault через vault_write */
  toVault?: boolean;
}

/** Дописка к промту, когда включён отчёт в заметки */
export const VAULT_REPORT_SUFFIX =
  "\n\n[Автоматизация] По завершении сохрани краткий отчёт (5–10 строк) в заметку vault через инструмент vault_write: файл \"automations-report.md\", полностью перезаписав его последним отчётом (заголовок с названием и датой, затем итоги).";

const LS_KEY = "haloui-automations";

/** Валидация записи: тикер в App работает с полями напрямую (name.slice,
 *  nextRunAfter → schedule.kind) — битый элемент из чужого файла импорта
 *  (haloui-automations входит в settings-экспорт) ронял setInterval каждые
 *  30 с и стопорил тик для задач, стоящих позже в массиве. Та же конвенция
 *  «диск не доверяем», что sanitizeSession у сессий */
function sanitizeAutomation(v: unknown): Automation | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.name !== "string" || typeof r.prompt !== "string") return null;
  if (typeof r.schedule !== "object" || r.schedule === null) return null;
  const s = r.schedule as Record<string, unknown>;
  if (
    s.kind !== "daily" &&
    s.kind !== "weekdays" &&
    s.kind !== "weekly" &&
    s.kind !== "interval"
  ) {
    return null;
  }
  if (s.kind === "interval") {
    if (typeof s.minutes !== "number" || !Number.isFinite(s.minutes)) return null;
  } else if (typeof s.time !== "string") {
    return null;
  }
  if (s.kind === "weekly" && typeof s.weekday !== "number") return null;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    schedule: r.schedule as Schedule,
    nextRunAt:
      typeof r.nextRunAt === "number" && Number.isFinite(r.nextRunAt)
        ? r.nextRunAt
        : 0,
    lastRunAt: typeof r.lastRunAt === "number" ? r.lastRunAt : 0,
    enabled: r.enabled === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    runs: Array.isArray(r.runs)
      ? r.runs.filter((x): x is number => typeof x === "number").slice(-10)
      : undefined,
    toVault: r.toVault === true,
  };
}

export function loadAutomations(): Automation[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.map(sanitizeAutomation).filter((a): a is Automation => a !== null)
      : [];
  } catch {
    return [];
  }
}

export function saveAutomations(list: Automation[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function newId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function parseTime(time: string): [number, number] {
  const parts = time.split(":").map((x) => parseInt(x, 10));
  const h = parts[0];
  const m = parts[1];
  return [h === undefined || isNaN(h) ? 9 : h, m === undefined || isNaN(m) ? 0 : m];
}

/** Ближайший запуск расписания после момента from */
export function nextRunAfter(a: Automation, from: number): number {
  if (a.schedule.kind === "interval") {
    const ms = Math.max(5, a.schedule.minutes) * 60000;
    return from + ms;
  }
  const [hh, mm] = parseTime(a.schedule.time);
  for (let i = 0; i < 8; i++) {
    const day = new Date(from);
    day.setDate(day.getDate() + i);
    const dow = day.getDay();
    const ok =
      a.schedule.kind === "daily" ||
      (a.schedule.kind === "weekdays" && dow >= 1 && dow <= 5) ||
      (a.schedule.kind === "weekly" && dow === a.schedule.weekday);
    if (!ok) continue;
    const at = new Date(day);
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() > from) return at.getTime();
  }
  return from + 86400000; // страховка: завтра в это же время
}

/** Создать автоматизацию с вычисленным первым запуском */
export function makeAutomation(
  name: string,
  prompt: string,
  schedule: Schedule,
): Automation {
  const a: Automation = {
    id: newId(),
    name,
    prompt,
    schedule,
    nextRunAt: 0,
    lastRunAt: 0,
    enabled: true,
    createdAt: Date.now(),
  };
  a.nextRunAt = nextRunAfter(a, Date.now());
  return a;
}

/** Пришёл ли срок запуска */
export function isDue(a: Automation, now: number = Date.now()): boolean {
  return a.enabled && a.nextRunAt > 0 && now >= a.nextRunAt;
}

// ---------- Шаблоны (как в референсе) ----------

export interface Template {
  /** Идентификатор SVG-иконки: sun | zap | doc | list */
  icon: "sun" | "zap" | "doc" | "list";
  // Ключи словаря: компилятор проверяет, что шаблоны не ссылаются в никуда
  nameKey: MsgKey;
  descKey: MsgKey;
  schedule: Schedule;
  prompt: string;
}

export const AUTOMATION_TEMPLATES: Template[] = [
  {
    icon: "sun",
    nameKey: "auto.tplMorning",
    descKey: "auto.tplMorningDesc",
    schedule: { kind: "weekdays", time: "09:00" },
    prompt:
      "Сделай краткий dev-брифинг по проекту из корневой папки (если папка не выбрана — работай по заметкам vault): 1) коммиты и изменения модулей с прошлого рабочего дня, 2) статус CI/сборки, если доступен, 3) открытые вопросы и что взять в работу сегодня. Ответ — не длиннее 15 строк, список.",
  },
  {
    icon: "zap",
    nameKey: "auto.tplRisk",
    descKey: "auto.tplRiskDesc",
    schedule: { kind: "daily", time: "10:00" },
    prompt:
      "Просмотри изменения кода за последние 24 часа (git diff/status, если проект привязан — иначе по заметкам) и найди риски высокой уверенности: падения в рантайме, потеря данных, безопасность. Формат: риск → файл → почему → как проверить.",
  },
  {
    icon: "doc",
    nameKey: "auto.tplRelease",
    descKey: "auto.tplReleaseDesc",
    schedule: { kind: "weekly", weekday: 5, time: "16:00" },
    prompt:
      "Собери недельный release-брифинг: PR и коммиты за неделю разложи по разделам Features / Fixes / Improvements / Engineering. Источник — git-лог проекта или заметки vault. В конце — 3 главных изменения недели.",
  },
  {
    icon: "list",
    nameKey: "auto.tplDocs",
    descKey: "auto.tplDocsDesc",
    schedule: { kind: "weekly", weekday: 3, time: "15:00" },
    prompt:
      "Сверь документацию с кодом за последние 7 дней: README и docs/ против реальных изменений. Найди места, где доки устарели, и составь список правок высокой уверенности. Сам ничего не меняй — только отчёт.",
  },
];
