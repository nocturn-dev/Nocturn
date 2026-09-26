import { describe, expect, it } from "vitest";
import { buildReflect, buildReflectPrompt, sessionLastActive, type ReflectInput } from "./reflect";
import type { Session, UsageEvent } from "./types";

// Фиксированное «сейчас»: детерминированные тесты без зависимости от часов
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0); // 26.09.2026 12:00 UTC
const DAY = 86_400_000;

const msg = (role: "user" | "assistant", ts?: number) => ({
  id: Math.random().toString(36).slice(2),
  role,
  content: "...",
  ...(ts != null ? { ts } : {}),
});

const session = (over: Partial<Session>): Session => ({
  id: Math.random().toString(36).slice(2),
  title: "Задача",
  createdAt: NOW,
  messages: [],
  ...over,
});

const input = (over: Partial<ReflectInput> = {}): ReflectInput => ({
  sessions: [],
  usage: [],
  facts: [],
  notes: [],
  nowMs: NOW,
  days: 7,
  ...over,
});

const usage = (day: string, prompt = 100, completion = 50): UsageEvent => ({
  day,
  prompt,
  completion,
  model: "m",
  workedMs: 0,
});

describe("buildReflect", () => {
  it("считает задачи, сообщения и токены за период; архив игнорирует", () => {
    const d = buildReflect(
      input({
        sessions: [
          session({ createdAt: NOW - 2 * DAY, updatedAt: NOW - DAY, messages: [msg("user", NOW - DAY)] }),
          session({ createdAt: NOW - 30 * DAY, messages: [msg("user", NOW - 3 * DAY), msg("assistant", NOW - 3 * DAY)] }),
          session({ createdAt: NOW - 2 * DAY, archived: true, messages: [msg("user", NOW - DAY)] }),
        ],
        usage: [usage("2026-09-25"), usage("2026-08-01", 9999, 9999)],
      }),
    );
    expect(d.tasksCreated).toBe(1); // вторая создана 30 дней назад, архив не считается
    expect(d.tasksTouched).toBe(2);
    expect(d.userMsgs).toBe(2);
    expect(d.tokens).toEqual({ prompt: 100, completion: 50 }); // чужой месяц не считается
  });

  it("граница периода включительна", () => {
    const d = buildReflect(
      input({
        sessions: [session({ createdAt: NOW - 7 * DAY, messages: [msg("user", NOW - 7 * DAY)] })],
        usage: [usage(dayKeyOf(NOW - 7 * DAY), 7, 3)],
      }),
    );
    expect(d.tasksCreated).toBe(1);
    expect(d.userMsgs).toBe(1);
    expect(d.tokens).toEqual({ prompt: 7, completion: 3 });
  });

  it("незавершённые планы: свежие сверху, done не считаются, максимум 5", () => {
    const mk = (title: string, daysAgo: number, plan: Session["plan"]) =>
      session({ title, createdAt: NOW - (daysAgo + 5) * DAY, updatedAt: NOW - daysAgo * DAY, plan });
    const sessions = [
      mk("старый", 10, [
        { title: "a", status: "done" },
        { title: "b", status: "pending" },
      ]),
      mk("новый", 1, [
        { title: "a", status: "in_progress" },
        { title: "b", status: "pending" },
        { title: "c", status: "pending" },
      ]),
      mk("закрытый", 2, [{ title: "a", status: "done" }]),
    ];
    for (let i = 0; i < 6; i++) sessions.push(mk(`наполнитель ${i}`, 3 + i, [{ title: "x", status: "pending" }]));
    const d = buildReflect(input({ sessions }));
    expect(d.stalled[0]?.title).toBe("новый");
    expect(d.stalled[0]).toMatchObject({ inProgress: 1, pending: 2 });
    expect(d.stalled.every((s) => s.title !== "закрытый")).toBe(true);
    expect(d.stalled.length).toBe(5);
  });

  it("факты в миллисекундах, заметки — в СЕКУНДАХ (формат notes_list)", () => {
    const d = buildReflect(
      input({
        facts: [{ ts: NOW - 1 * DAY }, { ts: NOW - 20 * DAY }],
        notes: [{ updated: Math.floor((NOW - 2 * DAY) / 1000) }, { updated: Math.floor((NOW - 30 * DAY) / 1000) }],
      }),
    );
    expect(d.newFacts).toBe(1);
    expect(d.notesTouched).toBe(1);
  });
});

describe("sessionLastActive", () => {
  it("updatedAt > последний ts сообщения > createdAt; пустые ts не ломают", () => {
    const s = session({
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 5 * DAY,
      messages: [msg("user", NOW - 8 * DAY), msg("assistant"), msg("user", NOW - 6 * DAY)],
    });
    expect(sessionLastActive(s)).toBe(NOW - 5 * DAY);
    expect(sessionLastActive(session({ createdAt: NOW - DAY }))).toBe(NOW - DAY);
  });
});

describe("buildReflectPrompt", () => {
  it("складывает локализованные подписи и stalled-список", () => {
    const data = buildReflect(
      input({
        sessions: [
          session({
            title: "Рефакторинг",
            updatedAt: NOW,
            plan: [
              { title: "a", status: "in_progress" },
              { title: "b", status: "pending" },
            ],
          }),
        ],
      }),
    );
    const text = buildReflectPrompt(data, {
      tasksCreated: "Задач создано",
      tasksTouched: "Активных задач",
      userMsgs: "Сообщений",
      tokens: "Токенов",
      facts: "Фактов",
      notes: "Заметок",
      stalled: "Незавершённые планы",
      inProgress: "в работе",
      pending: "ждут",
      none: "нет",
    });
    expect(text).toContain("Задач создано: 1");
    expect(text).toContain('Незавершённые планы: "Рефакторинг" (1 в работе / 1 ждут)');
  });

  it("без зависших планов — явное «нет»", () => {
    const text = buildReflectPrompt(buildReflect(input()), {
      tasksCreated: "t", tasksTouched: "t", userMsgs: "m", tokens: "k",
      facts: "f", notes: "n", stalled: "s", inProgress: "i", pending: "p", none: "нет",
    });
    expect(text).toContain("s: нет");
  });
});

function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
