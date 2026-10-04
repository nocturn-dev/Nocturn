import { describe, expect, it } from "vitest";
import {
  makeQuipDecks,
  pickMood,
  pickPostRunQuip,
  QUIP_COOLDOWN_MS,
  QUIP_KEYS,
  shouldQuip,
} from "./nokMood";

/** Базовое «ничего не происходит» — каждый тест включает только свой флаг */
const base = {
  storming: false,
  anger: 0,
  waitingConfirm: false,
  errorFlash: false,
  surprised: false,
  scaring: false,
  flying: false,
  donePulse: false,
  pet: false,
  streaming: false,
  activity: null as string | null,
  asleep: false,
  tumble: false,
  coding: false,
  musicPlaying: false,
};

describe("pickMood — одиночные состояния", () => {
  const cases: Array<[Partial<typeof base>, string]> = [
    [{ storming: true }, "storm"],
    [{ anger: 5 }, "anger"],
    [{ waitingConfirm: true }, "waiting"],
    [{ errorFlash: true }, "error"],
    [{ surprised: true }, "surprised"],
    [{ scaring: true }, "scare"],
    [{ flying: true }, "fly"],
    [{ donePulse: true }, "done"],
    [{ pet: true }, "petting"],
    [{ streaming: true }, "streaming"],
    [{ streaming: true, activity: "fs_read" }, "thinking"],
    [{ asleep: true }, "sleeping"],
    [{ tumble: true }, "tumble"],
    [{ coding: true }, "coding"],
    [{ musicPlaying: true }, "groove"],
    [{}, "idle"],
  ];
  for (const [over, mood] of cases) {
    it(`${JSON.stringify(over)} → ${mood}`, () => {
      expect(pickMood({ ...base, ...over })).toBe(mood);
    });
  }
});

describe("pickMood — приоритеты", () => {
  it("шторм бьёт гнев", () => {
    expect(pickMood({ ...base, storming: true, anger: 12 })).toBe("storm");
  });
  it("гнев бьёт ожидание подтверждения", () => {
    expect(pickMood({ ...base, anger: 6, waitingConfirm: true })).toBe("anger");
  });
  it("ожидание подтверждения бьёт ошибку и стрим", () => {
    expect(pickMood({ ...base, waitingConfirm: true, errorFlash: true, streaming: true })).toBe("waiting");
  });
  it("ошибка бьёт удивление и самодеятельность", () => {
    expect(pickMood({ ...base, errorFlash: true, surprised: true, coding: true })).toBe("error");
  });
  it("полёт — команда пользователя: бьёт удивление и испуг", () => {
    expect(pickMood({ ...base, flying: true, surprised: true, scaring: true })).toBe("fly");
  });
  it("полёт бьёт конфетти завершения", () => {
    expect(pickMood({ ...base, flying: true, donePulse: true })).toBe("fly");
  });
  it("конфетти бьёт поглаживание", () => {
    expect(pickMood({ ...base, donePulse: true, pet: true })).toBe("done");
  });
  it("поглаживание бьёт стрим", () => {
    expect(pickMood({ ...base, pet: true, streaming: true })).toBe("petting");
  });
  it("сон бьёт самодеятельность", () => {
    expect(pickMood({ ...base, asleep: true, tumble: true, coding: true })).toBe("sleeping");
  });
  it("ноутбук бьёт музыку", () => {
    expect(pickMood({ ...base, coding: true, musicPlaying: true })).toBe("coding");
  });
});

describe("pickMood — границы", () => {
  it("anger 4 — ещё не злой (падает в следующий флаг)", () => {
    expect(pickMood({ ...base, anger: 4, musicPlaying: true })).toBe("groove");
  });
  it("anger 5 — уже злой", () => {
    expect(pickMood({ ...base, anger: 5 })).toBe("anger");
  });
  it("граница у 12 не решается здесь: шторм ставит storming", () => {
    // лесенка злости live в компоненте; pickMood видит только факт
    expect(pickMood({ ...base, anger: 12 })).toBe("anger");
  });
});

describe("pickPostRunQuip", () => {
  it("дифф: полшанса при изменённых строках", () => {
    expect(
      pickPostRunQuip({ failed: false, changedLines: 214, runsToday: 1, hidden: false, rnd: () => 0.4 }),
    ).toEqual({ kind: "diff", n: 214 });
    expect(
      pickPostRunQuip({ failed: false, changedLines: 214, runsToday: 1, hidden: false, rnd: () => 0.6 }),
    ).toBeNull();
  });
  it("каждая 10-я задача дня — «перерыв» (если дифф не выпал)", () => {
    expect(
      pickPostRunQuip({ failed: false, changedLines: 0, runsToday: 10, hidden: false, rnd: () => 0.9 }),
    ).toEqual({ kind: "break", n: 10 });
    expect(
      pickPostRunQuip({ failed: false, changedLines: 0, runsToday: 9, hidden: false, rnd: () => 0.9 }),
    ).toBeNull();
  });
  it("иначе — пул «готово» с полшанса", () => {
    expect(
      pickPostRunQuip({ failed: false, changedLines: 0, runsToday: 1, hidden: false, rnd: () => 0.4 }),
    ).toEqual({ kind: "done" });
    expect(
      pickPostRunQuip({ failed: false, changedLines: 0, runsToday: 1, hidden: false, rnd: () => 0.6 }),
    ).toBeNull();
  });
  it("ошибка — никакой бодрой реплики (тревогу отыгрывает errorFlash)", () => {
    expect(
      pickPostRunQuip({ failed: true, changedLines: 214, runsToday: 10, hidden: false, rnd: () => 0 }),
    ).toBeNull();
  });
  it("скрытое окно — реплика не нужна", () => {
    expect(
      pickPostRunQuip({ failed: false, changedLines: 214, runsToday: 10, hidden: true, rnd: () => 0 }),
    ).toBeNull();
  });
});

describe("makeQuipDecks — без повторов, пока колода не прокрутится", () => {
  it("все фразы пула выходят ровно по разу за цикл", () => {
    const next = makeQuipDecks(() => 0.42);
    const keys = QUIP_KEYS.start;
    const drawn: string[] = [];
    for (let i = 0; i < keys.length; i++) drawn.push(next("start"));
    // За один цикл колоды повторов нет
    expect(new Set(drawn).size).toBe(keys.length);
    expect(drawn.sort()).toEqual([...keys].sort());
    // Колода перетасовалась и снова полная
    const secondCycle = new Set<string>();
    for (let i = 0; i < keys.length; i++) secondCycle.add(next("start"));
    expect(secondCycle.size).toBe(keys.length);
  });
  it("разные пулы независимы", () => {
    const next = makeQuipDecks(() => 0.1);
    const a = next("shell");
    const b = next("shell");
    expect(a).not.toBe(b);
    expect(QUIP_KEYS.shell).toContain(a);
  });
});

describe("shouldQuip — кулдаун и шансы", () => {
  const now = 1_000_000;
  it("в кулдауне обычное событие не срабатывает даже при rnd=0", () => {
    expect(shouldQuip("shell", now - QUIP_COOLDOWN_MS + 1, now, () => 0)).toBe(false);
  });
  it("после кулдауна решает шанс", () => {
    expect(shouldQuip("shell", now - QUIP_COOLDOWN_MS - 1, now, () => 0.2)).toBe(true);
    expect(shouldQuip("shell", now - QUIP_COOLDOWN_MS - 1, now, () => 0.3)).toBe(false);
  });
  it("error и limit перебивают кулдаун", () => {
    expect(shouldQuip("error", now, now, () => 0.5)).toBe(true);
    expect(shouldQuip("limit", now, now, () => 0.5)).toBe(true);
  });
});
