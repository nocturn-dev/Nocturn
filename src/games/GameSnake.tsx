import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../locales";

/**
 * Змейка: canvas 21×21, стрелки/WASD, ускорение с ростом, пауза пробелом,
 * пауза при потере фокуса окна. Рендер в цветах темы (accent-змейка).
 */

const BEST_KEY = "haloui-game-snake";
const GRID = 21;
const CELL = 16;

interface Pt {
  x: number;
  y: number;
}

export default function GameSnake() {
  const { t } = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => Number(localStorage.getItem(BEST_KEY) ?? 0));
  const [over, setOver] = useState(false);
  const [paused, setPaused] = useState(false);

  // Игровое состояние — в рефах: rAF-цикл не должен пересоздаваться рендером
  const snakeRef = useRef<Pt[]>([{ x: 10, y: 10 }]);
  const dirRef = useRef<Pt>({ x: 1, y: 0 });
  const queuedRef = useRef<Pt[]>([]);
  const foodRef = useRef<Pt>({ x: 15, y: 10 });
  const accRef = useRef(0);
  const lastRef = useRef(0);
  const rafRef = useRef(0);
  const pausedRef = useRef(false);
  const overRef = useRef(false);
  const scoreRef = useRef(0);

  // Accent читается при КАЖДОЙ отрисовке из живого токена: чтение один раз
  // при монтировании оставляло старый цвет после смены темы при открытой
  // игре (аудит 2026-10-04); getComputedStyle в кадре дешёвый
  const readAccent = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--halo-accent").trim() ||
    "#d97757";

  const placeFood = () => {
    while (true) {
      const f = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
      if (!snakeRef.current.some((s) => s.x === f.x && s.y === f.y)) {
        foodRef.current = f;
        return;
      }
    }
  };

  const reset = useCallback(() => {
    snakeRef.current = [{ x: 10, y: 10 }];
    dirRef.current = { x: 1, y: 0 };
    queuedRef.current = [];
    accRef.current = 0;
    scoreRef.current = 0;
    setScore(0);
    setOver(false);
    overRef.current = false;
    setPaused(false);
    pausedRef.current = false;
    placeFood();
  }, []);

  useEffect(() => {
    reset();
  }, [reset]);

  // Клавиатура: стрелки/WASD — направление (с очередью, разворот запрещён),
  // пробел — пауза
  useEffect(() => {
    const DIRS: Record<string, Pt> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      KeyA: { x: -1, y: 0 },
      KeyD: { x: 1, y: 0 },
      KeyW: { x: 0, y: -1 },
      KeyS: { x: 0, y: 1 },
    };
    const onKey = (e: KeyboardEvent) => {
      const d = DIRS[e.code];
      if (d) {
        e.preventDefault();
        e.stopPropagation();
        // at(-1) — Safari 15.0–15.3 и старые WebKitGTK без метода: пол
        // сборки safari15 синтаксический, рантайм-методы он не полифиллит
        const q = queuedRef.current;
        const last = q[q.length - 1] ?? dirRef.current;
        // Разворот на 180° запрещён
        if (last.x + d.x !== 0 || last.y + d.y !== 0) {
          if (queuedRef.current.length < 2) queuedRef.current.push(d);
        }
      } else if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (!overRef.current) {
          pausedRef.current = !pausedRef.current;
          setPaused(pausedRef.current);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Пауза при потере фокуса окна
  useEffect(() => {
    const onBlur = () => {
      pausedRef.current = true;
      setPaused(true);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // Игровой цикл
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const px = GRID * CELL;
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
    ctx.scale(dpr, dpr);

    const draw = () => {
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.clearRect(0, 0, px, px);
      // Сетка-точки
      ctx.fillStyle = "rgba(128,128,128,0.15)";
      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          ctx.fillRect(c * CELL + CELL / 2 - 1, r * CELL + CELL / 2 - 1, 2, 2);
        }
      }
      // Еда
      ctx.fillStyle = readAccent();
      ctx.beginPath();
      ctx.arc(
        foodRef.current.x * CELL + CELL / 2,
        foodRef.current.y * CELL + CELL / 2,
        CELL / 2 - 3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      // Змейка: голова ярче
      const snake = snakeRef.current;
      for (let i = snake.length - 1; i >= 0; i--) {
        const s = snake[i];
        if (!s) continue;
        ctx.globalAlpha = i === 0 ? 1 : 0.45 + (0.5 * (snake.length - i)) / snake.length;
        ctx.fillStyle = readAccent();
        ctx.beginPath();
        // roundRect — WebKit 16.4+/Chromium 99: TypeError на старом WebKitGTK
        // убивал rAF-цикл навсегда (игра замирала); фолбэк — обычный rect
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2, 4);
        } else {
          ctx.rect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    let stepMs = 150;
    const tick = () => {
      const queued = queuedRef.current.shift();
      if (queued) {
        // Разворот на 180° запрещён относительно текущего направления
        if (dirRef.current.x + queued.x !== 0 || dirRef.current.y + queued.y !== 0) {
          dirRef.current = queued;
        }
      }
      const head = snakeRef.current[0];
      if (!head) return;
      const next: Pt = { x: head.x + dirRef.current.x, y: head.y + dirRef.current.y };
      // Стены и тело — смерть
      if (next.x < 0 || next.y < 0 || next.x >= GRID || next.y >= GRID || snakeRef.current.some((s) => s.x === next.x && s.y === next.y)) {
        overRef.current = true;
        setOver(true);
        if (scoreRef.current > Number(localStorage.getItem(BEST_KEY) ?? 0)) {
          localStorage.setItem(BEST_KEY, String(scoreRef.current));
          setBest(scoreRef.current);
        }
        return;
      }
      snakeRef.current.unshift(next);
      if (next.x === foodRef.current.x && next.y === foodRef.current.y) {
        scoreRef.current += 1;
        setScore(scoreRef.current);
        placeFood();
        // Ускорение с ростом
        stepMs = Math.max(70, 150 - scoreRef.current * 3);
      } else {
        snakeRef.current.pop();
      }
      draw();
    };

    const loop = (now: number) => {
      // Clamp: первый dt равен времени жизни страницы (rAF-timestamp), а
      // после паузы/фона копится огромный dt — без клампа змейка получала
      // тысячи тиков за кадр и умирала мгновенно
      const dt = Math.min(now - lastRef.current, 200);
      lastRef.current = now;
      if (!pausedRef.current && !overRef.current) {
        accRef.current += dt;
        while (accRef.current >= stepMs) {
          accRef.current -= stepMs;
          tick();
          if (overRef.current) break;
        }
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reset]);

  return (
    <div className="flex flex-col items-center">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.score")}: <b className="text-halo-text">{score}</b>
        </span>
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.record", { n: best })}
        </span>
        <button
          onClick={reset}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("game.restart")}
        </button>
      </div>
      <div className="relative">
        <canvas ref={canvasRef} className="rounded-xl border border-halo-line bg-halo-deep/60" />
        {(over || paused) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-halo-deep/85">
            <p className="text-lg font-semibold text-halo-text">
              {over ? t("game.over") : t("game.paused")}
            </p>
            {over && (
              <button
                onClick={reset}
                className="rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-4 py-1.5 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
              >
                {t("game.restart")}
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-2 text-[0.6875rem] text-halo-muted/60">WASD / ↑↓←→ · {t("game.spacePause")}</p>
    </div>
  );
}
