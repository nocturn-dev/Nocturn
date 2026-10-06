import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useLang, type MsgKey } from "../../locales";
import { motionScale } from "../../motion";
import { NOK_BASE, NOK_BLINK, NOK_COLS, NOK_FLY, NOK_ROWS } from "./nokSprites";
import { pickMood, makeQuipDecks, shouldQuip, type NokMood, type NokQuipKind, type PostRunQuip } from "./nokMood";

/** Реплика с подстановками: {n} — число, {name} — имя маскота (кастомное
 *  или локализованное «Нок»). Строки без плейсхолдеров проходят как есть */
function fmtQuip(
  t: (k: MsgKey, v?: Record<string, string | number>) => string,
  key: MsgKey,
  n: number | undefined,
  name: string,
): string {
  const vars: Record<string, string | number> = { name };
  if (n !== undefined) vars.n = n;
  return t(key, vars);
}

/**
 * Нок — светлячок-маскот Nocturn (PLAN.md §21). Живёт у композера:
 * сопровождает стриминг (свечение пульсирует в ритме typing-точек),
 * thinking (точки над головой — тот же темп индикатора), завершение прогона
 * (вспышка + конфетти, синхронно со звуком complete), сон при простое,
 * сон при свёрнутом окне. Статус-маячок агента: ждёт подтверждения ask_user
 * (знак вопроса, клик ведёт к вопросу) и ошибка прогона (восклицание,
 * красная лампа, клик скроллит к ошибке). Клики: медленные — поглаживание
 * (сердечки, свет теплеет), частые — лесенка злости (янтарный warn →
 * красный строб, улетает за экран, возвращается через 30с). В полёте
 * машет крыльями (второй кадр спрайта, кадры меняет CSS). Палитра —
 * theme-токены: перекрашивается во всех темах сам. Reduce-motion глушится
 * общими правилами index.css (спрайт статичен).
 */

/** Статусные цвета злости — семантика warn/error (сознательное исключение
 *  из theme-токенов, как палитры статусов в карточках) */
const WARN = "#fbbf24";
const RAGE = "#f87171";

/** Точка-конфетти: стартовый сдвиг и вектор разлёта */
const BURST: Array<{ x: number; y: number; dx: number; dy: number }> = [
  { x: 4.5, y: 4, dx: -5, dy: -4 },
  { x: 5.5, y: 4, dx: 5, dy: -5 },
  { x: 3, y: 6, dx: -6, dy: 1 },
  { x: 7, y: 6, dx: 6, dy: 0 },
  { x: 4, y: 8, dx: -4, dy: 4 },
  { x: 6, y: 8, dx: 4, dy: 4 },
  { x: 5, y: 3, dx: 0, dy: -6 },
  { x: 5.5, y: 7, dx: 1, dy: 5 },
];

/** Темп анимаций (настройка «Скорость анимации», --motion-scale 0.7/1/1.4
 *  на html). Таймеры выступлений обязаны идти в том же темпе, что их
 *  CSS-анимации (все они calc(Xs * var(--motion-scale))): при 1.4 полёт
 *  длится 12.6s, а фиксированный JS-таймер 9s рубил его на середине —
 *  forwards-анимация обрывалась классом, и Нок «телепортировался» на
 *  насест. Реализация живёт в src/motion.ts — общая с ask-ping в ChatArea
 */

export function Nok({
  streaming,
  activity,
  sleepAfterMs = 5 * 60_000,
  stormReturnMs = 30_000,
  scale = 1,
  glowBoost: glowCfg = 1,
  selfActivity = true,
  flySeq = 0,
  homeSeq = 0,
  colors,
  themeKey,
  musicPlaying = false,
  settingsClosedSeq = 0,
  waitingConfirm = false,
  errorSeq = 0,
  mascotName = "",
  postRunQuip = null,
  event = null,
  napSeq = 0,
  onSignal,
}: {
  streaming: boolean;
  activity: string | null;
  /** Хвост для тестов/будущих настроек: простой до сна */
  sleepAfterMs?: number;
  /** Хвост для тестов/будущих настроек: сколько гуляет обиженным */
  stormReturnMs?: number;
  /** Масштаб спрайта (настройка «Маскот → Размер») */
  scale?: number;
  /** Множитель яркости свечения (настройка «Маскот → Свечение») */
  glowBoost?: number;
  /** Самодеятельность в простое: сам достаёт ноутбук и «кодит» */
  selfActivity?: boolean;
  /** Счётчик команд «Эй Нок, полетай» (пасхалка; рост seq — новый полёт) */
  flySeq?: number;
  /** Счётчик команд «домой» (досрочно сажает облёт) */
  homeSeq?: number;
  /** Кастомные цвета по частям ("" — токен темы) */
  colors?: { body?: string; glow?: string; wing?: string };
  /** Ключ темы: смена — Нок удивляется */
  themeKey?: string;
  /** Музыка играет (Spotify/YouTube) — наушники и качание */
  musicPlaying?: boolean;
  /** Настройки закрылись (счётчик) — выдыхает с облегчением */
  settingsClosedSeq?: number;
  /** Агент ждёт подтверждения (ask_user): знак вопроса, клик — сигнал чату */
  waitingConfirm?: boolean;
  /** Кастомное имя маскота (пусто — локализованное «Нок»): реплики с
   *  {name} подставляют его, title/aria тоже */
  mascotName?: string;
  /** Рост счётчика — прогон упал: тревожная вспышка + реплика */
  errorSeq?: number;
  /** Квип после завершения прогона (±дифф / «перерыв» / пул «готово») */
  postRunQuip?: PostRunQuip | null;
  /** Событие жизни (старт задачи, вкладка, shell, музыка…): рост seq —
   *  новое событие; шансы/кулдауны/колоды решаются внутри Нока */
  event?: { seq: number; kind: NokQuipKind } | null;
  /** Рост счётчика — «Спать» из меню */
  napSeq?: number;
  /** Клик в waiting/error ведёт к карточке (скролл/подсветка) — не гладит */
  onSignal?: (kind: "confirm" | "error") => void;
}) {
  const { t } = useLang();

  // —— переходные состояния ——
  const [blink, setBlink] = useState(false);
  const [donePulse, setDonePulse] = useState(false);
  const [pet, setPet] = useState(false);
  const [anger, setAnger] = useState(0); // 0..12, распадает за 10с тишины
  const [storming, setStorming] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [clickTick, setClickTick] = useState(0); // будильник сна от кликов
  const [coding, setCoding] = useState(false); // самодеятельность: ноутбук
  const [flying, setFlying] = useState(false); // пасхалка «полетай»
  const [scaring, setScaring] = useState(false); // «Бууу» с сайдбара
  const [tumble, setTumble] = useState(false); // нелепость: «разучился летать»
  const [surprised, setSurprised] = useState(false); // смена темы
  const [errorFlash, setErrorFlash] = useState(false); // прогон упал
  const [visTick, setVisTick] = useState(0); // свёрнутое окно: сон/пробуждение
  const [quips, setQuips] = useState<{ id: number; key: MsgKey; dx: number; n?: number; text: string }[]>([]);
  const quipIdRef = useRef(0);
  const quipTimerRef = useRef<number | null>(null);

  const lastClickRef = useRef(0);
  const angerDecayRef = useRef<number | null>(null);
  const petTimerRef = useRef<number | null>(null);

  // Плавающая реплика: всплыла над головой и тает (не засоряет ленту).
  // Поднята из эффекта самодеятельности: квипы теперь приходят и извне
  // (ошибка, завершение прогона, ожидание подтверждения)
  const displayName = mascotName.trim() || t("mascot.name");
  const spawnQuip = useCallback(
    (key: MsgKey, n?: number) => {
      const id = ++quipIdRef.current;
      setQuips([
        { id, key, dx: Math.round(Math.random() * 26 - 13), n, text: fmtQuip(t, key, n, displayName) },
      ]);
      if (quipTimerRef.current) window.clearTimeout(quipTimerRef.current);
      quipTimerRef.current = window.setTimeout(
        () => setQuips((q) => q.filter((x) => x.id !== id)),
        // Реплика живёт ровно столько, сколько её CSS-анимация (2.7s * scale)
        2_700 * motionScale(),
      );
    },
    [t, displayName],
  );
  // Latest-ref: эффект самодеятельности зовёт всегда СВЕЖИЙ spawnQuip, но
  // сам не перезапускается при смене языка/имени — иначе (регрессия 0e6d0dd,
  // №6 аудита v5) ре-ран эффекта гасил cleanup'ом таймеры завершения
  // кувырка/исуга/кодинга, а состояния те не сбрасывает: поза залипала
  const spawnQuipRef = useRef(spawnQuip);
  useEffect(() => {
    spawnQuipRef.current = spawnQuip;
  }, [spawnQuip]);
  useEffect(
    () => () => {
      if (quipTimerRef.current) window.clearTimeout(quipTimerRef.current);
    },
    [],
  );

  // Событийные квипы: колода без повторов на каждый пул + глобальный
  // кулдаун (анти-заучивание; механика в nokMood.ts)
  const quipDecksRef = useRef(makeQuipDecks());
  const lastQuipAtRef = useRef(0);
  const quipFromPool = useCallback(
    (kind: NokQuipKind) => {
      if (!shouldQuip(kind, lastQuipAtRef.current, Date.now())) return;
      lastQuipAtRef.current = Date.now();
      spawnQuip(quipDecksRef.current(kind));
    },
    [spawnQuip],
  );

  // Завершение прогона: вспышка + конфетти (переход streaming true→false).
  // Ошибка бьёт конфетти: её отыгрывает эффект errorSeq ниже
  const prevStreamingRef = useRef(streaming);
  const seenErrorRef = useRef(errorSeq);
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (was && !streaming) {
      if (errorSeq !== seenErrorRef.current) return;
      setDonePulse(true);
      const t = window.setTimeout(() => setDonePulse(false), 1_600 * motionScale());
      return () => window.clearTimeout(t);
    }
  }, [streaming, errorSeq]);

  // Прогон упал: тревожная вспышка — лампа краснеет, «!» над головой,
  // реплика из пула (важное — перебивает кулдаун); клик в этом состоянии
  // ведёт к карточке ошибки
  useEffect(() => {
    if (errorSeq <= seenErrorRef.current) return;
    seenErrorRef.current = errorSeq;
    setErrorFlash(true);
    setAsleep(false);
    quipFromPool("error");
    const t = window.setTimeout(() => setErrorFlash(false), 3_000);
    return () => window.clearTimeout(t);
  }, [errorSeq, quipFromPool]);

  // Квип после завершения (дифф / десятка / пул «готово»): решение
  // принимает ChatArea (pickPostRunQuip), фразу «готово» — колода здесь
  const seenPostRef = useRef(0);
  useEffect(() => {
    if (postRunQuip && postRunQuip.seq > seenPostRef.current) {
      seenPostRef.current = postRunQuip.seq;
      lastQuipAtRef.current = Date.now();
      const o = postRunQuip.outcome;
      if (o.kind === "diff") spawnQuip("mascot.quip.diff", o.n);
      else if (o.kind === "break") spawnQuip("mascot.quip.break", o.n);
      else spawnQuip(quipDecksRef.current("done"));
    }
  }, [postRunQuip, spawnQuip]);

  // События жизни: шансы/кулдаун внутри; старт задачи — контекстный пул
  // (спящий просыпается, глубокая ночь — ночной пул)
  const seenEventRef = useRef(0);
  useEffect(() => {
    if (!event || event.seq <= seenEventRef.current) return;
    seenEventRef.current = event.seq;
    if (event.kind === "start") {
      const hour = new Date().getHours();
      quipFromPool(asleep ? "wake" : hour <= 4 ? "night" : "start");
      return;
    }
    quipFromPool(event.kind);
  }, [event, quipFromPool, asleep]);

  // Агент ждёт подтверждения: просыпается + один квип на эпизод ожидания
  const prevWaitingRef = useRef(waitingConfirm);
  useEffect(() => {
    if (waitingConfirm && !prevWaitingRef.current) {
      setAsleep(false);
      spawnQuip("mascot.quip.wait");
    }
    prevWaitingRef.current = waitingConfirm;
  }, [waitingConfirm, spawnQuip]);

  // Свёрнутое окно: спит сразу, вернулись — проснулся. visTick перезапускает
  // таймеры сна и самодеятельности (их эффекты читают его в зависимостях)
  useEffect(() => {
    const onVis = () => {
      setAsleep(document.hidden);
      setVisTick((v) => v + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // «Спать» из меню: принудительная дремота до клика/стрима
  const prevNapRef = useRef(napSeq);
  useEffect(() => {
    if (napSeq > prevNapRef.current) setAsleep(true);
    prevNapRef.current = napSeq;
  }, [napSeq]);

  // Сон: 5 минут без событий — Нок тлеет на краю композера; visTick
  // перезапускает отсчёт после сворачивания/разворачивания окна
  useEffect(() => {
    if (streaming) {
      setAsleep(false);
      return;
    }
    const t = window.setTimeout(() => setAsleep(true), sleepAfterMs);
    return () => window.clearTimeout(t);
  }, [streaming, activity, clickTick, sleepAfterMs, visTick]);

  // Моргание: случайный цикл, пока не спит
  useEffect(() => {
    if (moodStableSleep(streaming, asleep)) return;
    let t1 = 0;
    let t2 = 0;
    const schedule = () => {
      t1 = window.setTimeout(() => {
        setBlink(true);
        t2 = window.setTimeout(() => {
          setBlink(false);
          schedule();
        }, 130);
      }, 2600 + Math.random() * 3400);
    };
    schedule();
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [streaming, asleep]);

  // Порог ярости: улетает. Сам влёт — эффект ниже; таймер возврата живёт
  // В ОТДЕЛЬНОМ эффекте по storming: раньше он заводился здесь и гасился
  // cleanup'ом этого же эффекта на ре-ране (storming сменился) — Нок
  // улетал навсегда
  useEffect(() => {
    if (anger < 12 || storming) return;
    setStorming(true);
  }, [anger, storming]);
  useEffect(() => {
    if (!storming) return;
    const t = window.setTimeout(() => {
      setStorming(false);
      // Возвращается обиженным (янтарные глаза), догорает за 10с
      setAnger(6);
      startAngerDecay();
    }, stormReturnMs);
    return () => window.clearTimeout(t);
  }, [storming, stormReturnMs]);

  // Самодеятельность: в простое изредка что-то затевает. Реплики — плавающие
  // и РЕДКИЕ: мысль может прилететь сама (ноутбука не будет), а может за
  // секунду ПЕРЕД ноутбуком («сначала мысль — потом дело»); если ноутбук
  // уже открыт — второй не достаётся. Падение: взлёт по центру, вращение,
  // шлёп именно в сайдбар с отскоком.
  // Deps ТОЛЬКО streaming/selfActivity: клики (поглаживание) и смена
  // activity не перезапускают планировщик — иначе cleanup убивал кувырок/
  // испуг на полпути (класс слетал — мгновенный снап на насест). Завершение
  // выступлений — в темпе CSS (3.2s/3.9s * --motion-scale)
  const CODE_QUIPS: MsgKey[] = [
    "mascot.quip.npm",
    "mascot.quip.rs",
    "mascot.quip.notabug",
  ];
  const THOUGHT_QUIPS: MsgKey[] = [
    "mascot.quip.todo",
    "mascot.quip.hello",
    "mascot.quip.think",
    "mascot.quip.letter",
  ];
  const pick = (pool: MsgKey[]): MsgKey =>
    pool[Math.floor(Math.random() * pool.length)] ?? "mascot.quip.think";
  useEffect(() => {
    // spawnQuip — через latest-ref (см. выше): ре-ран на смену t/displayName
    // здесь запрещён — cleanup гасит таймеры завершения выступлений, а
    // состояния не сбрасывает (№6 аудита v5, регрессия 0e6d0dd)
    const quip = (key: MsgKey, n?: number) => spawnQuipRef.current(key, n);
    if (streaming || !selfActivity) {
      setCoding(false);
      setTumble(false);
      setScaring(false);
      setQuips([]);
      return;
    }
    let alive = true;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(() => alive && fn(), ms));
    };
    const startCoding = () => {
      setCoding(true);
      // Серединная реплика во время кодинга — не всегда (шанс 40%)
      if (Math.random() < 0.4) later(() => quip(pick(CODE_QUIPS)), 3_200);
      later(() => {
        setCoding(false);
        quip("mascot.quip.after");
        schedule(18_000 + Math.random() * 25_000);
      }, 7_000);
    };
    const startTumble = () => {
      setTumble(true);
      // Шлёп о сайдбар ~2с: «Ооопс…» с отскоком
      later(() => quip("mascot.quip.oops"), 2_000);
      later(() => {
        setTumble(false);
        schedule(18_000 + Math.random() * 25_000);
      }, 3_400 * motionScale()); // анимация кувырка: 3.2s * scale
    };
    const startScare = () => {
      // «Бууу»: прыжок на середину сайдбара, краснеет, глаза по пять
      // копеек — потом колобком катится обратно на край композера
      setScaring(true);
      later(() => quip("mascot.quip.boo"), 1_400);
      later(() => {
        setScaring(false);
        schedule(18_000 + Math.random() * 25_000);
      }, 3_900 * motionScale()); // анимация испуга: 3.9s * scale
    };
    const schedule = (delay: number) => {
      t1 = window.setTimeout(() => {
        if (!alive) return;
        const roll = Math.random();
        if (roll < 0.4) {
          // Мысль сама по себе — ноутбука не будет
          quip(pick(THOUGHT_QUIPS));
          schedule(9_000 + Math.random() * 22_000);
        } else if (roll < 0.65) {
          // Ноутбук: в половине случаев мысль прилетает за секунду до
          if (Math.random() < 0.5) {
            quip(pick(THOUGHT_QUIPS));
            later(startCoding, 1_500);
          } else {
            startCoding();
          }
        } else if (roll < 0.8) {
          startTumble();
        } else {
          startScare();
        }
      }, delay);
    };
    let t1 = 0;
    schedule(10_000 + Math.random() * 18_000);
    // Состояния выступлений НЕ сбрасываем: их завершают СВОИ таймеры выше.
    // Re-run сюда приходит только при смене streaming/selfActivity — а та
    // ветка сбрасывает всё в гарде; на unmount состояния умирают с компонентом
    return () => {
      alive = false;
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(t1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spawnQuip через ref, пулы стабильны по смыслу
  }, [streaming, selfActivity]);

  // Настройки закрылись: «Фух» — перестали тыкать (глаза прикрыты сами
  // морганием: relief держит их закрытыми 1.4с)
  const [relief, setRelief] = useState(false);
  const prevSettingsRef = useRef(settingsClosedSeq);
  useEffect(() => {
    if (settingsClosedSeq > prevSettingsRef.current) {
      setRelief(true);
      const timer = window.setTimeout(() => setRelief(false), 1_400);
      // spawnQuip, а не прямой setQuips: таймер удаления — часть контракта
      // реплики (2.7s * scale), прямая запись оставляла узел в DOM навсегда
      // (аудит A4-6)
      spawnQuip("mascot.quip.relief");
      prevSettingsRef.current = settingsClosedSeq;
      return () => window.clearTimeout(timer);
    }
    prevSettingsRef.current = settingsClosedSeq;
    // t/displayName в deps: имя меняется редко, реплика одна — честные deps
  }, [settingsClosedSeq, t, displayName, spawnQuip]);

  // Удивление: смена темы — глаза по пять копеек и подпрыгивает
  const prevThemeRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (themeKey !== undefined && themeKey !== prevThemeRef.current) {
      if (prevThemeRef.current !== undefined) {
        setSurprised(true);
        const t = window.setTimeout(() => setSurprised(false), 1_700);
        prevThemeRef.current = themeKey;
        return () => window.clearTimeout(t);
      }
      prevThemeRef.current = themeKey;
    }
    prevThemeRef.current = themeKey;
  }, [themeKey]);

  // Пасхалка «Эй Нок, полетай»: рост flySeq — новый 9-секундный облёт чата
  const prevFlyRef = useRef(flySeq);
  useEffect(() => {
    if (flySeq > prevFlyRef.current) {
      setFlying(true);
      setAsleep(false);
    }
    prevFlyRef.current = flySeq;
  }, [flySeq]);
  useEffect(() => {
    if (!flying) return;
    // Полёт в темпе CSS-анимации (9s * --motion-scale), иначе обрыв вперёд
    const t = window.setTimeout(() => setFlying(false), 9_000 * motionScale());
    return () => window.clearTimeout(t);
  }, [flying]);
  // «Домой»: досрочная посадка по команде
  const prevHomeRef = useRef(homeSeq);
  useEffect(() => {
    if (homeSeq > prevHomeRef.current) setFlying(false);
    prevHomeRef.current = homeSeq;
  }, [homeSeq]);

  // Распад злости: 10с без тыканий — остыл (реф объявлен рядом с прочими
  // выше; хелпер дергается из кликов и из возврата обиженным)
  const startAngerDecay = () => {
    if (angerDecayRef.current) window.clearTimeout(angerDecayRef.current);
    angerDecayRef.current = window.setTimeout(() => setAnger(0), 10_000);
  };

  const handleClick = () => {
    // waiting/error — клик это навигация к карточке (скролл/подсветка),
    // не поглаживание: рука тянется к Ноку, чтобы ответить агенту
    if (waitingConfirm) {
      onSignal?.("confirm");
      return;
    }
    if (errorFlash) {
      onSignal?.("error");
      return;
    }
    const now = Date.now();
    const gap = now - lastClickRef.current;
    lastClickRef.current = now;
    setAsleep(false);
    setClickTick((v) => v + 1);
    if (gap < 300) {
      // Частые тыканья — злость; медленный темп, наоборот, остужает
      setAnger((a) => Math.min(a + 1, 12));
      setPet(false);
    } else {
      setAnger((a) => Math.max(0, a - 2));
      setPet(true);
      if (petTimerRef.current) window.clearTimeout(petTimerRef.current);
      petTimerRef.current = window.setTimeout(() => setPet(false), 1400);
    }
    startAngerDecay();
  };

  // Приоритеты настроений — чистая функция (nokMood.ts, табличные тесты)
  const mood: NokMood = pickMood({
    storming,
    anger,
    waitingConfirm,
    errorFlash,
    surprised,
    scaring,
    flying,
    donePulse,
    pet,
    streaming,
    activity,
    asleep,
    tumble,
    coding,
    musicPlaying,
  });

  // Палитра клеток: кастомные цвета частей ("" — токен темы); статусные
  // цвета злости/ошибки — семантика, кастом их не перебивает
  const hot = anger >= 10 ? RAGE : WARN;
  const bodyColor = colors?.body || "var(--halo-deep)";
  const lampFill =
    mood === "anger" || mood === "scare"
      ? hot
      : mood === "error"
        ? RAGE
        : colors?.glow || "var(--halo-accent)";
  const wingColor = colors?.wing || "var(--halo-muted)";
  const eyeFill =
    mood === "anger" || mood === "scare"
      ? hot
      : blink || mood === "sleeping" || relief
        ? bodyColor
        : // Глаза = text-токен: светлая точка на тёмном теле в тёмных темах
          // и тёмная на deep-теле в светлых (bg в тёмной теме слишком близок
          // к deep — глаза пропадали)
          "var(--halo-text)";
  // Сон: лампа тлеет; поглаживание: свет теплеет (полная яркость);
  // настройка «Свечение» множит всё
  const glowBoost =
    glowCfg * (mood === "sleeping" ? 0.35 : mood === "petting" ? 1.15 : 1);

  const cellFill = (ch: string): string =>
    ch === "a"
      ? lampFill
      : ch === "e"
        ? eyeFill
        : ch === "G" || ch === "g"
          ? lampFill
          : ch === "w"
            ? wingColor
            : bodyColor;
  const cellOpacity = (ch: string): number =>
    ch === "G" ? Math.min(0.85 * glowBoost, 1) : ch === "g" ? 0.32 * glowBoost : 1;

  const matrix = blink || mood === "sleeping" ? NOK_BLINK : NOK_BASE;

  // Улетевший остаётся смонтированным: обидчивый отлёт/возврат — CSS-переход
  // на обёртке (класс nok-storm), pointer-events гасятся, таймер вернёт

  return (
    <div
      className={`nok nok-${mood} select-none`}
      onClick={handleClick}
      title={displayName}
      role="img"
      aria-label={displayName}
      // --nok-scale: полётные сдвиги в CSS умножают на масштаб, чтобы
      // «крупный» Нок летел так же далеко относительно себя
      style={{ "--nok-scale": scale } as CSSProperties}
    >
      <svg
        width={NOK_COLS * 3 * scale}
        height={NOK_ROWS * 3 * scale}
        viewBox={`0 0 ${NOK_COLS} ${NOK_ROWS}`}
        shapeRendering="crispEdges"
        overflow="visible"
      >
        {/* Аура: мягкое пятно за телом, пульсирует вместе с лампой */}
        <g className="nok-aura">
          <ellipse
            cx={5}
            cy={7.5}
            rx={6.5}
            ry={4.5}
            fill={lampFill}
            opacity={0.16}
            style={{ filter: "blur(2.5px)" }}
          />
        </g>

        {/* Thinking-точки: тот же темп, что у typing-индикатора композера */}
        {mood === "thinking" && (
          <g className="nok-dots" fill="var(--halo-accent)">
            <rect className="nok-dot" x={2} y={-2.2} width={1} height={1} rx={0.5} />
            <rect
              className="nok-dot"
              x={4.5}
              y={-2.2}
              width={1}
              height={1}
              rx={0.5}
              style={{ animationDelay: "0.2s" }}
            />
            <rect
              className="nok-dot"
              x={7}
              y={-2.2}
              width={1}
              height={1}
              rx={0.5}
              style={{ animationDelay: "0.4s" }}
            />
          </g>
        )}

        {/* Жила ярости: две искры над головой на верхних ступенях гнева */}
        {mood === "anger" && (
          <g fill={hot}>
            <rect x={1.5} y={-1.4} width={1.4} height={0.6} transform="rotate(-24 2.2 -1.1)" />
            <rect x={6.9} y={-1.4} width={1.4} height={0.6} transform="rotate(24 7.6 -1.1)" />
          </g>
        )}

        {/* Ждёт подтверждения: знак вопроса над головой; клик ведёт к
            панели вопроса — рука тянется к Ноку, чтобы ответить агенту */}
        {mood === "waiting" && (
          <g className="nok-float" fill="var(--halo-accent)" transform="translate(3.7 -5.2)">
            <rect x={0} y={0} width={1} height={1} />
            <rect x={1} y={0} width={1} height={1} />
            <rect x={2} y={1} width={1} height={1} />
            <rect x={1} y={2} width={1} height={1} />
            <rect x={1} y={4} width={1} height={1} />
          </g>
        )}

        {/* Ошибка прогона: восклицание над головой, лампа — RAGE */}
        {mood === "error" && (
          <g className="nok-float" fill={RAGE} transform="translate(4.4 -6)">
            <rect x={0} y={0} width={1.2} height={2.8} />
            <rect x={0} y={3.8} width={1.2} height={1.2} />
          </g>
        )}

        {/* Конфетти завершения: разлёт + оседание */}
        {mood === "done" &&
          BURST.map((p, i) => (
            <rect
              key={i}
              className="nok-burst"
              x={p.x}
              y={p.y}
              width={0.9}
              height={0.9}
              fill={i % 3 === 0 ? WARN : i % 3 === 1 ? "var(--halo-accent)" : "var(--halo-text)"}
              style={
                {
                  "--dx": `${p.dx * scale}px`,
                  "--dy": `${p.dy * scale}px`,
                  animationDelay: `${i * 40}ms`,
                } as CSSProperties
              }
            />
          ))}

        {/* Сердечко поглаживания */}
        {mood === "petting" && (
          <g className="nok-float" fill="var(--halo-accent)" transform="translate(2.5 -6)">
            <rect x={0} y={0} width={1} height={1} />
            <rect x={2} y={0} width={1} height={1} />
            <rect x={-0.5} y={0.5} width={4} height={1.5} />
            <rect x={0.5} y={2} width={2} height={1} />
            <rect x={1.25} y={3} width={0.5} height={1} />
          </g>
        )}

        {/* Z-z-z сна: пара «зюек» из трёх пиксельных полосок */}
        {mood === "sleeping" && (
          <g fill="var(--halo-muted)">
            <g className="nok-z" transform="translate(7.5 -4.5)">
              <rect x={0} y={0} width={2.4} height={0.7} />
              <rect x={0.9} y={0.9} width={0.7} height={0.7} transform="rotate(45 1.25 1.25)" />
              <rect x={0} y={1.7} width={2.4} height={0.7} />
            </g>
            <g className="nok-z" transform="translate(10 -8) scale(0.7)" style={{ animationDelay: "1.2s" }}>
              <rect x={0} y={0} width={2.4} height={0.7} />
              <rect x={0.9} y={0.9} width={0.7} height={0.7} transform="rotate(45 1.25 1.25)" />
              <rect x={0} y={1.7} width={2.4} height={0.7} />
            </g>
          </g>
        )}

        {/* Тело: усики, голова, глаза (при удивлении — по пять копеек);
            крылышки мерцают отдельной группой; лампа-брюшко тоже отдельно
            (пульс свечения — на группе, чтобы не спорить с opacity клеток) */}
        <g className="nok-body">
          {matrix.flatMap((row, y) =>
            [...row].flatMap((ch, x) => {
              if (ch === "." || ch === "G" || ch === "g" || ch === "w") return [];
              const big =
                ch === "e" && (mood === "surprised" || mood === "scare" || mood === "error");
              return [
                <rect
                  key={`${x}:${y}`}
                  x={big ? x - 0.15 : x}
                  y={big ? y - 0.15 : y}
                  width={big ? 1.3 : 1}
                  height={big ? 1.3 : 1}
                  fill={cellFill(ch)}
                />,
              ];
            }),
          )}
        </g>
        <g className="nok-wings">
          {matrix.flatMap((row, y) =>
            [...row].flatMap((ch, x) => {
              if (ch !== "w") return [];
              return [
                <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={cellFill("w")} opacity={0.75} />,
              ];
            }),
          )}
        </g>
        {/* Полётный кадр крыльев (подняты): кадры низ/верх меняет CSS,
            компонент на взмахах не перерисовывается */}
        {mood === "fly" && (
          <g className="nok-wings-alt">
            {NOK_FLY.flatMap((row, y) =>
              [...row].flatMap((ch, x) => {
                if (ch !== "w") return [];
                return [
                  <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={cellFill("w")} opacity={0.75} />,
                ];
              }),
            )}
          </g>
        )}
        <g className="nok-lamp">
          {matrix.flatMap((row, y) =>
            [...row].flatMap((ch, x) => {
              if (ch !== "G" && ch !== "g") return [];
              return [
                <rect
                  key={`${x}:${y}`}
                  x={x}
                  y={y}
                  width={1}
                  height={1}
                  fill={lampFill}
                  opacity={cellOpacity(ch)}
                />,
              ];
            }),
          )}
        </g>

        {/* Наушники: под музыкой (Spotify/YouTube) — поёт в два пикселя */}
        {musicPlaying && mood !== "sleeping" && (
          <g className="nok-phones">
            <rect x={1.4} y={1.6} width={6.2} height={0.7} rx={0.35} fill={bodyColor} />
            <rect
              x={0.7}
              y={2}
              width={1.3}
              height={2}
              rx={0.5}
              fill={bodyColor}
              stroke={lampFill}
              strokeWidth={0.3}
            />
            <rect
              x={7}
              y={2}
              width={1.3}
              height={2}
              rx={0.5}
              fill={bodyColor}
              stroke={lampFill}
              strokeWidth={0.3}
            />
          </g>
        )}

        {/* Ноутбук самодеятельности: раскрыт перед Ноком, на «экране» —
            строчки кода (вспышат по очереди классом .nok-code) */}
        {mood === "coding" && (
          <g className="nok-laptop">
            <rect
              x={1.7}
              y={7.7}
              width={6.6}
              height={2.1}
              rx={0.3}
              fill="var(--halo-deep)"
              stroke="var(--halo-line)"
              strokeWidth={0.25}
            />
            <rect className="nok-code" x={2.4} y={8.2} width={1.5} height={0.5} fill="var(--halo-accent)" opacity={0.9} />
            <rect
              className="nok-code"
              x={4.3}
              y={8.2}
              width={0.9}
              height={0.5}
              fill="var(--halo-accent)"
              opacity={0.55}
              style={{ animationDelay: "0.25s" }}
            />
            <rect
              className="nok-code"
              x={2.4}
              y={8.95}
              width={2.3}
              height={0.5}
              fill="var(--halo-accent)"
              opacity={0.5}
              style={{ animationDelay: "0.5s" }}
            />
            <rect
              x={1.1}
              y={9.75}
              width={7.8}
              height={0.5}
              rx={0.25}
              fill="var(--halo-muted)"
            />
          </g>
        )}
      </svg>

      {/* Плавающие реплики: всплыли, растаяли — ленту не засоряют.
          {n} — подстановка числа (±строк диффа / задач за день) */}
      {quips.map((q) => (
        <div
          key={q.id}
          className="nok-quip"
          style={{ "--qx": `${q.dx}px` } as CSSProperties}
        >
          {q.text}
        </div>
      ))}
    </div>
  );
}

/** Гард моргания: во сне глаза всегда закрыты — цикл не нужен */
function moodStableSleep(streaming: boolean, asleep: boolean): boolean {
  return !streaming && asleep;
}
