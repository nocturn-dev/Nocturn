import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLang } from "../../locales";
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
  | "done" // вспышка завершения прогона
  | "petting" // поглаживание
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
}: {
  streaming: boolean;
  activity: string | null;
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
    const t = window.setTimeout(() => setAsleep(true), 5 * 60_000);
    return () => window.clearTimeout(t);
  }, [streaming, activity, clickTick]);

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

  // Порог ярости: улетает за экран, возвращается через 30с (остывший —
  // распад гнева ниже всё погасит)
  useEffect(() => {
    if (anger < 12 || storming) return;
    setStorming(true);
    const t = window.setTimeout(() => setStorming(false), 30_000);
    return () => window.clearTimeout(t);
  }, [anger, storming]);

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
    if (angerDecayRef.current) window.clearTimeout(angerDecayRef.current);
    angerDecayRef.current = window.setTimeout(() => setAnger(0), 10_000);
  };

  const mood: NokMood = storming
    ? "storm"
    : anger >= 5
      ? "anger"
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
              : "idle";

  // Палитра клеток по настроению (status-цвета злости — семантика)
  const hot = anger >= 10 ? RAGE : WARN;
  const lampFill = mood === "anger" ? hot : "var(--halo-accent)";
  const eyeFill =
    mood === "anger"
      ? hot
      : blink || mood === "sleeping"
        ? "var(--halo-deep)"
        : // Глаза = text-токен: светлая точка на тёмном теле в тёмных темах
          // и тёмная на deep-теле в светлых (bg в тёмной теме слишком близок
          // к deep — глаза пропадали)
          "var(--halo-text)";
  // Сон: лампа тлеет; поглаживание: свет теплеет (полная яркость)
  const glowBoost = mood === "sleeping" ? 0.35 : mood === "petting" ? 1.15 : 1;

  const cellFill = (ch: string): string =>
    ch === "a"
      ? lampFill
      : ch === "e"
        ? eyeFill
        : ch === "G" || ch === "g"
          ? lampFill
          : "var(--halo-deep)";
  const cellOpacity = (ch: string): number =>
    ch === "G" ? Math.min(0.85 * glowBoost, 1) : ch === "g" ? 0.32 * glowBoost : 1;

  const matrix = blink || mood === "sleeping" ? NOK_BLINK : NOK_BASE;

  if (mood === "storm") {
    // Улетел: гнев на пике — места нет, вернётся через 30с (см. эффект выше)
    return null;
  }

  return (
    <div
      className={`nok nok-${mood} select-none`}
      onClick={handleClick}
      title={t("mascot.name")}
      role="img"
      aria-label={t("mascot.name")}
    >
      <svg
        width={NOK_COLS * 3}
        height={NOK_ROWS * 3}
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
                  "--dx": `${p.dx}px`,
                  "--dy": `${p.dy}px`,
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

        {/* Тело: усики, голова, глаза + лампа-брюшко отдельной группой
            (пульс свечения — на группе, чтобы не спорить с opacity клеток) */}
        <g className="nok-body">
          {matrix.flatMap((row, y) =>
            [...row].flatMap((ch, x) => {
              if (ch === "." || ch === "G" || ch === "g") return [];
              return [
                <rect
                  key={`${x}:${y}`}
                  x={x}
                  y={y}
                  width={1}
                  height={1}
                  fill={cellFill(ch)}
                />,
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
      </svg>
    </div>
  );
}

/** Гард моргания: во сне глаза всегда закрыты — цикл не нужен */
function moodStableSleep(streaming: boolean, asleep: boolean): boolean {
  return !streaming && asleep;
}
