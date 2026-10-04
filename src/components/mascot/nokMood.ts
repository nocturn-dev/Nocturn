import type { MsgKey } from "../../locales";

/**
 * Чистая логика Нока (PLAN.md §21): FSM настроений и выбор квипа после
 * прогона вытянуты из компонента, чтобы приоритеты покрывались табличными
 * тестами (тот же подход, что у зеркал toolFilter). Порядок проверок
 * pickMood = приоритет реакции: прямой контакт пользователя (гнев/шторм)
 * и системные сигналы (вопрос агента, ошибка) бьют самодеятельность.
 */

export type NokMood =
  | "storm" // улетел обиженным за экран
  | "anger" // лесенка злости
  | "waiting" // агент ждёт подтверждения ask_user
  | "error" // прогон упал: тревожная вспышка
  | "surprised" // смена темы
  | "fly" // пасхалка «Эй Нок, полетай»
  | "tumble" // нелепость: «разучился летать»
  | "done" // вспышка завершения прогона
  | "petting" // поглаживание
  | "scare" // «Бууу» с сайдбара
  | "groove" // наушники, качание под музыку
  | "coding" // самодеятельность: ноутбук
  | "streaming"
  | "thinking"
  | "sleeping"
  | "idle";

export interface MoodDeps {
  storming: boolean;
  /** 0..12; от 5 — злой, от 12 — улетает (лесенка решает это выше) */
  anger: number;
  /** Агент ждёт подтверждения (ask_user над композером) */
  waitingConfirm: boolean;
  /** Прогон упал — короткая тревожная вспышка */
  errorFlash: boolean;
  surprised: boolean;
  scaring: boolean;
  flying: boolean;
  donePulse: boolean;
  pet: boolean;
  streaming: boolean;
  /** Активность агента (thinking-индикатор): стрим с ней — thinking */
  activity: string | null;
  asleep: boolean;
  tumble: boolean;
  coding: boolean;
  musicPlaying: boolean;
}

export function pickMood(d: MoodDeps): NokMood {
  if (d.storming) return "storm";
  if (d.anger >= 5) return "anger";
  if (d.waitingConfirm) return "waiting";
  if (d.errorFlash) return "error";
  if (d.surprised) return "surprised";
  if (d.scaring) return "scare";
  if (d.flying) return "fly";
  if (d.donePulse) return "done";
  if (d.pet) return "petting";
  if (d.streaming) return d.activity ? "thinking" : "streaming";
  if (d.asleep) return "sleeping";
  if (d.tumble) return "tumble";
  if (d.coding) return "coding";
  if (d.musicPlaying) return "groove";
  return "idle";
}

/** Квип после завершения прогона (реплики редкие — дисциплина компонента):
 *  ±строк диффа — в половине случаев, каждая 10-я задача дня — «перерыв».
 *  Ошибка и скрытое окно реплики не заслуживают. rnd инъектится для тестов */
export function pickPostRunQuip(d: {
  failed: boolean;
  changedLines: number;
  runsToday: number;
  hidden: boolean;
  rnd?: () => number;
}): { key: "mascot.quip.diff" | "mascot.quip.break"; n: number } | null {
  if (d.failed || d.hidden) return null;
  const rnd = d.rnd ?? Math.random;
  if (d.changedLines > 0 && rnd() < 0.5) {
    return { key: "mascot.quip.diff", n: d.changedLines };
  }
  if (d.runsToday > 0 && d.runsToday % 10 === 0) {
    return { key: "mascot.quip.break", n: d.runsToday };
  }
  return null;
}

/** Тип квипа для пропса Nok.postRunQuip: seq отсекает повторные вспышки */
export interface PostRunQuip {
  seq: number;
  key: MsgKey;
  n?: number;
}
