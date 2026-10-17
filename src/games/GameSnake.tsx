import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { isGameInputTarget, useBest } from "./gameCommon";

/**
 * Змейка: canvas 21×21, стрелки/WASD/тач, ускорение с ростом, пауза пробелом,
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
  const [best, updateBest] = useBest(BEST_KEY);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
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
  const wonRef = useRef(false);
  const scoreRef = useRef(0);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  // Accent кэшируется в ref и обновляется наблюдателем: вызов getComputedStyle
  // на каждом кадре 60 FPS создавал лишнюю нагрузку на движок стилей
  const accentRef = useRef("#d97757");
  useEffect(() => {
    const updateAccent = () => {
      accentRef.current =
        getComputedStyle(document.documentElement).getPropertyValue("--halo-accent").trim() ||
        "#d97757";
    };
    updateAccent();
    const mo = new MutationObserver(updateAccent);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => mo.disconnect();
  }, []);

  const placeFood = useCallback(() => {
    const snake = snakeRef.current;
    const occupied = new Set(snake.map((s) => s.x * GRID + s.y));
    const free: Pt[] = [];
    for (let x = 0; x < GRID; x++) {
      for (let y = 0; y < GRID; y++) {
        if (!occupied.has(x * GRID + y)) {
          free.push({ x, y });
        }
      }
    }
    // Если свободного места не осталось — победа без бесконечного цикла
    if (free.length === 0) {
      overRef.current = true;
      wonRef.current = true;
      setOver(true);
      setWon(true);
      updateBest(scoreRef.current, "max");
      return;
    }
    const idx = Math.floor(Math.random() * free.length);
    foodRef.current = free[idx]!;
  }, [updateBest]);

  const reset = useCallback(() => {
    snakeRef.current = [{ x: 10, y: 10 }];
    dirRef.current = { x: 1, y: 0 };
    queuedRef.current = [];
    accRef.current = 0;
    scoreRef.current = 0;
    setScore(0);
    setOver(false);
    setWon(false);
    overRef.current = false;
    wonRef.current = false;
    setPaused(false);
    pausedRef.current = false;
    placeFood();
  }, [placeFood]);

  useEffect(() => {
    reset();
  }, [reset]);

  // Клавиатура: стрелки/WASD — направление (с очередью, разворот запрещён),
  // пробел — пауза. Игнорируем ввод, если фокус в инпуте или текстовой зоне
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
      if (isGameInputTarget(e.target)) return;
      const d = DIRS[e.code];
      if (d) {
        e.preventDefault();
        e.stopPropagation();
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

  // Тач-управление и свайпы по полю игры
  const onPointerDown = (e: React.PointerEvent) => {
    swipeRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || overRef.current || pausedRef.current) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    const d: Pt =
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? { x: 1, y: 0 }
          : { x: -1, y: 0 }
        : dy > 0
          ? { x: 0, y: 1 }
          : { x: 0, y: -1 };
    const q = queuedRef.current;
    const last = q[q.length - 1] ?? dirRef.current;
    if (last.x + d.x !== 0 || last.y + d.y !== 0) {
      if (queuedRef.current.length < 2) queuedRef.current.push(d);
    }
  };

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

    // Синхронизация масштабирования canvas с учетом DPI и перемещения между мониторами
    const syncCanvasDims = () => {
      const dpr = window.devicePixelRatio || 1;
      const px = GRID * CELL;
      canvas.width = px * dpr;
      canvas.height = px * dpr;
      canvas.style.width = `${px}px`;
      canvas.style.height = `${px}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    syncCanvasDims();

    let dprMq: MediaQueryList | null = null;
    const updateDprListener = () => {
      dprMq?.removeEventListener("change", syncCanvasDims);
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dpr)`);
      dprMq.addEventListener("change", () => {
        syncCanvasDims();
        updateDprListener();
      });
    };
    updateDprListener();

    const px = GRID * CELL;
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
      const accent = accentRef.current;
      // Еда
      ctx.fillStyle = accent;
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
        ctx.fillStyle = accent;
        ctx.beginPath();
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
        if (dirRef.current.x + queued.x !== 0 || dirRef.current.y + queued.y !== 0) {
          dirRef.current = queued;
        }
      }
      const head = snakeRef.current[0];
      if (!head) return;
      const next: Pt = { x: head.x + dirRef.current.x, y: head.y + dirRef.current.y };
      // Стены и тело — смерть
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= GRID ||
        next.y >= GRID ||
        snakeRef.current.some((s) => s.x === next.x && s.y === next.y)
      ) {
        overRef.current = true;
        setOver(true);
        updateBest(scoreRef.current, "max");
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
    };

    const loop = (now: number) => {
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
      // draw вызывается строго один раз за кадр цикла, без повторного вызова внутри tick()
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      dprMq?.removeEventListener("change", syncCanvasDims);
    };
  }, [placeFood, reset, updateBest]);

  return (
    <div className="flex flex-col items-center">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.score")}: <b className="text-halo-text">{score}</b>
        </span>
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.record", { n: best ?? 0 })}
        </span>
        <button
          onClick={reset}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("game.restart")}
        </button>
      </div>
      <div
        className="relative touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="rounded-xl border border-halo-line bg-halo-deep/60" />
        {(over || paused) && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-halo-deep/85">
            <p className="text-lg font-semibold text-halo-text">
              {won ? t("game.win") : over ? t("game.over") : t("game.paused")}
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
      <p className="mt-2 text-[0.6875rem] text-halo-muted/60">WASD / ↑↓←→ / свайп · {t("game.spacePause")}</p>
    </div>
  );
}
