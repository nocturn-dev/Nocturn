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
  // Полёт — ЯВНАЯ команда пользователя: бьёт самодеятельность и удивление.
  // Раньше scare/surprised были выше: случайно совпавший «Бууу» срывал
  // полёт — forwards-анимация обрывалась классом, снап на насест
  if (d.flying) return "fly";
  if (d.surprised) return "surprised";
  if (d.scaring) return "scare";
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
 *  ±строк диффа — в половине случаев, каждая 10-я задача дня — «перерыв»,
 *  иначе — пул «готово» с шансом. Ошибка и скрытое окно реплики не
 *  заслуживают. rnd инъектится для тестов */
export type PostRunOutcome =
  | { kind: "diff"; n: number }
  | { kind: "break"; n: number }
  | { kind: "done" };

export function pickPostRunQuip(d: {
  failed: boolean;
  changedLines: number;
  runsToday: number;
  hidden: boolean;
  rnd?: () => number;
}): PostRunOutcome | null {
  if (d.failed || d.hidden) return null;
  const rnd = d.rnd ?? Math.random;
  if (d.changedLines > 0 && rnd() < 0.5) {
    return { kind: "diff", n: d.changedLines };
  }
  if (d.runsToday > 0 && d.runsToday % 10 === 0) {
    return { kind: "break", n: d.runsToday };
  }
  if (rnd() < 0.5) return { kind: "done" };
  return null;
}

/** Пропс Nok.postRunQuip: seq отсекает повторные вспышки, outcome — что
 *  показать (конкретные diff/break или выбор из колоды done) */
export interface PostRunQuip {
  seq: number;
  outcome: PostRunOutcome;
}

/**
 * —— Событийные пасхалки (волна 05.10, решение владельца «делай все») ——
 * Почти каждое действие агента/пользователя может вызвать реплику Нока.
 * Анти-заучивание: (1) пул на событие + колода БЕЗ повторов — перетасовка,
 * фраза не повторится, пока колода не прокрутится целиком; (2) шанс
 * срабатывания на частых событиях; (3) глобальный кулдаун между любыми
 * репликами. Ошибка и Hard Limit — важные: кулдаун перебивают.
 */
export type NokQuipKind =
  | "start" // задача стартовала (в Ноке контекст: wake/night/start)
  | "long" // прогон тянется дольше трёх минут
  | "done" // задача завершена (успех, без диффа/десятки)
  | "error" // прогон упал
  | "tab" // браузер: новая вкладка/навигация
  | "shot" // скриншот браузера/экрана
  | "shell" // shell-команда ушла
  | "yt" // YouTube: новое видео
  | "track" // смена трека (Spotify)
  | "edit" // запись файла
  | "py" // Code Interpreter
  | "sub" // субагент ушёл
  | "limit" // Hard Limit
  | "wake" // проснулся (в Ноке — контекст старта)
  | "night" // работа глубокой ночью (в Ноке — контекст старта)
  | "model" // смена модели
  | "path" // юзер печатает путь/файл проекта
  | "idle" // печатал и замолк > 30 с
  | "longtext"; // простыня текста в черновике

export const QUIP_KEYS: Record<NokQuipKind, MsgKey[]> = {
  start: [
    "mascot.quip.start1",
    "mascot.quip.start2",
    "mascot.quip.start3",
    "mascot.quip.start4",
    "mascot.quip.start5",
  ],
  long: [
    "mascot.quip.long1",
    "mascot.quip.long2",
    "mascot.quip.long3",
    "mascot.quip.long4",
    "mascot.quip.long5",
  ],
  done: [
    "mascot.quip.done1",
    "mascot.quip.done2",
    "mascot.quip.done3",
    "mascot.quip.done4",
    "mascot.quip.done5",
  ],
  error: ["mascot.quip.error", "mascot.quip.err2", "mascot.quip.err3", "mascot.quip.err4"],
  tab: ["mascot.quip.tab1", "mascot.quip.tab2", "mascot.quip.tab3", "mascot.quip.tab4"],
  shot: ["mascot.quip.shot1", "mascot.quip.shot2", "mascot.quip.shot3"],
  shell: [
    "mascot.quip.shell1",
    "mascot.quip.shell2",
    "mascot.quip.shell3",
    "mascot.quip.shell4",
  ],
  yt: ["mascot.quip.yt1", "mascot.quip.yt2", "mascot.quip.yt3", "mascot.quip.yt4"],
  track: ["mascot.quip.track1", "mascot.quip.track2", "mascot.quip.track3"],
  edit: ["mascot.quip.edit1", "mascot.quip.edit2", "mascot.quip.edit3"],
  py: ["mascot.quip.py1", "mascot.quip.py2", "mascot.quip.py3"],
  sub: ["mascot.quip.sub1", "mascot.quip.sub2", "mascot.quip.sub3"],
  limit: ["mascot.quip.limit1", "mascot.quip.limit2", "mascot.quip.limit3"],
  wake: ["mascot.quip.wake1", "mascot.quip.wake2", "mascot.quip.wake3"],
  night: ["mascot.quip.night1", "mascot.quip.night2", "mascot.quip.night3"],
  model: ["mascot.quip.model1", "mascot.quip.model2", "mascot.quip.model3"],
  path: ["mascot.quip.path1", "mascot.quip.path2", "mascot.quip.path3"],
  idle: ["mascot.quip.idle1", "mascot.quip.idle2", "mascot.quip.idle3"],
  longtext: ["mascot.quip.typelong1", "mascot.quip.typelong2", "mascot.quip.typelong3"],
};

/** Черновик похож на путь/файл проекта (реакция Нока «ого, ты знаешь
 *  устройство проекта»): абсолютный/относительный путь или файл с
 *  кодовым расширением. Различие файл↔путь не важно — реплика одна */
export function isPathLikeDraft(s: string): boolean {
  return (
    /(^|\s)[/\\][\w./\\-]+/.test(s) ||
    /[\w-]+\.(ts|tsx|rs|js|mjs|json|md|toml|css|html|py)\b/i.test(s)
  );
}

export const QUIP_CHANCE: Record<NokQuipKind, number> = {
  start: 0.7,
  long: 0.4,
  done: 1, // решение уже принято pickPostRunQuip
  error: 1,
  tab: 0.25,
  shot: 0.3,
  shell: 0.25,
  yt: 0.7,
  track: 0.4,
  edit: 0.25,
  py: 0.5,
  sub: 0.5,
  limit: 1,
  wake: 0.8,
  night: 0.6,
  model: 0.6,
  path: 0.6,
  idle: 0.7,
  longtext: 0.3,
};

/** Тихая пауза между репликами: активная работа не должна превращаться
 *  в болтовню. error/limit перебивают (важное — важнее молчания) */
export const QUIP_COOLDOWN_MS = 75_000;

export function shouldQuip(
  kind: NokQuipKind,
  lastAt: number,
  now: number,
  rnd: () => number = Math.random,
): boolean {
  if (kind !== "error" && kind !== "limit" && now - lastAt < QUIP_COOLDOWN_MS) {
    return false;
  }
  return rnd() < QUIP_CHANCE[kind];
}

/** Фабрика колод: на каждый пул — своя перетасованная колода, фраза не
 *  повторится, пока не кончится вся (rnd инъектится для тестов) */
export function makeQuipDecks(
  rnd: () => number = Math.random,
): (kind: NokQuipKind) => MsgKey {
  const decks = new Map<NokQuipKind, MsgKey[]>();
  return (kind) => {
    let deck = decks.get(kind);
    if (!deck || deck.length === 0) {
      deck = [...QUIP_KEYS[kind]];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
      }
      decks.set(kind, deck);
    }
    return deck.pop()!;
  };
}
