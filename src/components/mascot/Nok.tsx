import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLang, type MsgKey } from "../../locales";
import { NOK_BASE, NOK_BLINK, NOK_COLS, NOK_ROWS } from "./nokSprites";

/**
 * Нок — светлячок-маскот Nocturn (PLAN.md §21). Живёт у композера:
 * сопровождает стриминг (свечение пульсирует в ритме typing-точек),
 * thinking (точки над головой — тот же темп индикатора), завершение прогона
 * (вспышка + конфетти, синхронно со звуком complete), сон при простое.
 * Клики: медленные — поглаживание (сердечки, свет теплеет), частые — лесенка
 * злости (янтарный warn → красный строб, улетает за экран, возвращается
 * через 30с). Палитра — theme-токены: перекрашивается во всех темах сам.
 * Reduce-motion глушится общими правилами index.css (спрайт статичен).
 */

type NokMood =
  | "storm" // улетел обиженным за экран
  | "anger" // лесенка злости
  | "surprised" // смена темы
  | "fly" // пасхалка «Эй Нок, полетай»
  | "tumble" // нелепость: «разучился летать»
  | "done" // вспышка завершения прогона
  | "petting" // поглаживание
  | "coding" // самодеятельность: ноутбук
  | "streaming"
  | "thinking"
  | "sleeping"
  | "idle";

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
  const [tumble, setTumble] = useState(false); // нелепость: «разучился летать»
  const [surprised, setSurprised] = useState(false); // смена темы
  const [quip, setQuip] = useState<string | null>(null); // реплика-пузырь

  const lastClickRef = useRef(0);
  const angerDecayRef = useRef<number | null>(null);
  const petTimerRef = useRef<number | null>(null);

  // Завершение прогона: вспышка + конфетти (переход streaming true→false)
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const was = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (was && !streaming) {
      setDonePulse(true);
      const t = window.setTimeout(() => setDonePulse(false), 1600);
      return () => window.clearTimeout(t);
    }
  }, [streaming]);

  // Сон: 5 минут без событий — Нок тлеет на краю композера
  useEffect(() => {
    if (streaming) {
      setAsleep(false);
      return;
    }
    const t = window.setTimeout(() => setAsleep(true), sleepAfterMs);
    return () => window.clearTimeout(t);
  }, [streaming, activity, clickTick, sleepAfterMs]);

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

  // Самодеятельность: в простое изредка что-то затевает — то ноутбук
  // достанет и «кодит» с репликами, то попытается летать и нелепо
  // спикирует у сайдбара с «Oooops…» (вариант — случайный)
  const CODE_QUIPS: MsgKey[] = [
    "mascot.quip.think",
    "mascot.quip.hello",
    "mascot.quip.todo",
    "mascot.quip.notabug",
    "mascot.quip.letter",
    "mascot.quip.npm",
    "mascot.quip.rs",
  ];
  useEffect(() => {
    if (streaming || !selfActivity) {
      setCoding(false);
      setTumble(false);
      setQuip(null);
      return;
    }
    let alive = true;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(window.setTimeout(() => alive && fn(), ms));
    };
    const pickQuip = (): MsgKey =>
      CODE_QUIPS[Math.floor(Math.random() * CODE_QUIPS.length)] ?? "mascot.quip.think";
    const schedule = (delay: number) => {
      t1 = window.setTimeout(() => {
        if (!alive) return;
        if (Math.random() < 0.6) {
          // Ноутбук: 7с печати с ротацией реплик, в финале — самокритика
          setCoding(true);
          setQuip(t(pickQuip()));
          const iv = window.setInterval(() => {
            if (alive) {
              setQuip(t(pickQuip()));
            }
          }, 2_200);
          timers.push(iv);
          later(() => {
            setCoding(false);
            window.clearInterval(iv);
            setQuip(t("mascot.quip.after"));
            later(() => setQuip(null), 2_800);
            schedule(18_000 + Math.random() * 25_000);
          }, 7_000);
        } else {
          // «Разучился летать»: взмах-взлёт, кувырок, шлёпается у сайдбара
          setTumble(true);
          later(() => setQuip(t("mascot.quip.oops")), 2_100);
          later(() => setQuip(null), 3_500);
          later(() => {
            setTumble(false);
            schedule(18_000 + Math.random() * 25_000);
          }, 2_600);
        }
      }, delay);
    };
    let t1 = 0;
    schedule(12_000 + Math.random() * 20_000);
    return () => {
      alive = false;
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(t1);
      setCoding(false);
      setTumble(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t и CODE_QUIPS стабильны по смыслу
  }, [streaming, selfActivity, activity, clickTick]);

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
    const t = window.setTimeout(() => setFlying(false), 9_000);
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

  const mood: NokMood = storming
    ? "storm"
    : anger >= 5
      ? "anger"
      : surprised
        ? "surprised"
        : flying
          ? "fly"
          : donePulse
            ? "done"
            : pet
              ? "petting"
              : streaming
                ? activity
                  ? "thinking"
                  : "streaming"
                : asleep
                  ? "sleeping"
                  : tumble
                    ? "tumble"
                    : coding
                      ? "coding"
                      : "idle";

  // Палитра клеток: кастомные цвета частей ("" — токен темы); статусные
  // цвета злости — семантика, кастом их не перебивает
  const hot = anger >= 10 ? RAGE : WARN;
  const bodyColor = colors?.body || "var(--halo-deep)";
  const lampFill = mood === "anger" ? hot : colors?.glow || "var(--halo-accent)";
  const wingColor = colors?.wing || "var(--halo-muted)";
  const eyeFill =
    mood === "anger"
      ? hot
      : blink || mood === "sleeping"
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
      title={t("mascot.name")}
      role="img"
      aria-label={t("mascot.name")}
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
              const big = ch === "e" && mood === "surprised";
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

      {/* Реплика-пузырёк (пасхалки/самодеятельность): молния не нужна —
          говорит сам за себя */}
      {quip && (
        <div className="nok-bubble anim-pop">{quip}</div>
      )}
    </div>
  );
}

/** Гард моргания: во сне глаза всегда закрыты — цикл не нужен */
function moodStableSleep(streaming: boolean, asleep: boolean): boolean {
  return !streaming && asleep;
}
