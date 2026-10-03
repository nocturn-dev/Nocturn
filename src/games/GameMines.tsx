import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { BombIcon, FlagIcon, MineFaceIcon, TimerIcon } from "../components/cards/icons";

/**
 * Сапёр: 9×9, 10 мин. Первый клик всегда безопасен (мины расставляются
 * после него, вокруг первой клетки чисто), ПКМ — флажок, таймер с первого
 * клика, лучшее время — в localStorage. Рендер — классический: рамка с
 * шапкой (мины/смайлик/таймер), «выпуклые» нераскрытые клетки, поле после
 * конца игры остаётся полностью видимым (весь смысл проигрыша — видеть мины).
 */

const SIZE = 9;
const MINES = 10;
const BEST_KEY = "haloui-game-mines";

interface Cell {
  mine: boolean;
  revealed: boolean;
  flag: boolean;
  n: number;
}

type State = "idle" | "playing" | "won" | "lost";

const emptyBoard = (): Cell[] =>
  Array.from({ length: SIZE * SIZE }, () => ({ mine: false, revealed: false, flag: false, n: 0 }));

const neighbors = (i: number): number[] => {
  const r = Math.floor(i / SIZE);
  const c = i % SIZE;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) out.push(nr * SIZE + nc);
    }
  }
  return out;
};

/** Расставить мины, не задевая первую клетку и её соседей */
function placeMines(board: Cell[], safe: number): Cell[] {
  const next = board.map((c) => ({ ...c }));
  const banned = new Set([safe, ...neighbors(safe)]);
  let placed = 0;
  while (placed < MINES) {
    const i = Math.floor(Math.random() * SIZE * SIZE);
    const cell = next[i];
    if (!cell || cell.mine || banned.has(i)) continue;
    cell.mine = true;
    placed += 1;
  }
  for (let i = 0; i < next.length; i++) {
    const cell = next[i];
    if (!cell) continue;
    cell.n = neighbors(i).filter((j) => next[j]?.mine).length;
  }
  return next;
}

/** Открыть клетку с flood-fill по нулям; возвращает board + подорвался ли */
function reveal(board: Cell[], start: number): { board: Cell[]; boom: boolean } {
  const next = board.map((c) => ({ ...c }));
  const first = next[start];
  if (!first) return { board: next, boom: false };
  if (first.mine) {
    for (const c of next) if (c.mine) c.revealed = true;
    return { board: next, boom: true };
  }
  const stack = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const c = next[i];
    if (!c || c.revealed || c.flag) continue;
    c.revealed = true;
    if (c.n === 0 && !c.mine) {
      for (const j of neighbors(i)) {
        if (!next[j]?.revealed && !next[j]?.flag) stack.push(j);
      }
    }
  }
  return { board: next, boom: false };
}

/** Цвет цифры: классическая гамма, приглушённая под тему */
const numClass = (n: number): string => {
  const map: Record<number, string> = {
    1: "text-sky-300",
    2: "text-emerald-300",
    3: "text-red-300",
    4: "text-violet-300",
    5: "text-amber-300",
    6: "text-teal-300",
    7: "text-halo-text",
    8: "text-halo-muted",
  };
  return map[n] ?? "text-halo-text";
};

export default function GameMines() {
  const { t } = useLang();
  const [board, setBoard] = useState<Cell[]>(emptyBoard);
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState(() => {
    const raw = localStorage.getItem(BEST_KEY);
    return raw ? Number(raw) : null;
  });
  const timerRef = useRef(0);

  // Таймер: тикает в playing, чистится при размонтировании/смене состояния
  useEffect(() => {
    if (state !== "playing") return;
    timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timerRef.current);
  }, [state]);

  const reset = useCallback(() => {
    setBoard(emptyBoard());
    setState("idle");
    setSeconds(0);
  }, []);

  const click = (i: number) => {
    if (state === "won" || state === "lost") return;
    const cell = board[i];
    if (!cell || cell.flag || cell.revealed) return;
    let nextBoard = board;
    if (state === "idle") {
      nextBoard = placeMines(board, i);
      setState("playing");
    }
    const { board: revealedBoard, boom } = reveal(nextBoard, i);
    if (boom) {
      setBoard(revealedBoard);
      setState("lost");
      return;
    }
    setBoard(revealedBoard);
    // Победа: все не-мины открыты
    const safeLeft = revealedBoard.filter((c) => !c.mine && !c.revealed).length;
    if (safeLeft === 0) {
      setState("won");
      setBest((b) => {
        if (b !== null && b <= seconds) return b;
        localStorage.setItem(BEST_KEY, String(seconds));
        return seconds;
      });
    }
  };

  const flag = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    if (state !== "playing" && state !== "idle") return;
    if (board[i]?.revealed) return;
    setBoard((prev) => prev.map((c, j) => (j === i ? { ...c, flag: !c.flag } : c)));
  };

  // Классика: мины минус поставленные флажки (может уйти в минус — так и
  // в оригинале; двойной учёт показывал бред вроде 19 при десяти минах)
  const flagsLeft = MINES - board.filter((c) => c.flag).length;


  return (
    <div className="flex flex-col items-center">
      {best !== null && (
        <p className="mb-2 text-[0.6875rem] text-halo-muted/70">
          {t("game.record", { n: `${best}s` })}
        </p>
      )}

      {/* Классическая рамка: шапка (мины / смайлик-рестарт / таймер) + поле */}
      <div className="relative rounded-2xl border-2 border-halo-line bg-halo-deep p-3 shadow-2xl">
        <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-halo-line bg-halo-surface/60 px-3 py-2">
          <span className="flex items-center gap-1 rounded-lg bg-halo-deep px-2.5 py-1 font-mono text-sm font-bold tabular-nums text-red-400 ring-1 ring-halo-line/60">
            <span className="text-red-400"><FlagIcon /></span>
            {String(Math.max(0, flagsLeft)).padStart(2, "0")}
          </span>
          <button
            onClick={reset}
            title={t("game.restart")}
            className="flex size-9 items-center justify-center rounded-lg border border-halo-line bg-halo-raised text-lg transition-transform hover:scale-110 active:scale-95"
          >
            <MineFaceIcon mood={state === "lost" ? "lost" : state === "won" ? "won" : "play"} />
          </button>
          <span className="flex items-center gap-1 rounded-lg bg-halo-deep px-2.5 py-1 font-mono text-sm font-bold tabular-nums text-red-400 ring-1 ring-halo-line/60">
            <span className="text-halo-muted"><TimerIcon /></span>
            {String(seconds).padStart(3, "0")}
          </span>
        </div>

        {/* Баннер конца игры: без затемнения поля — весь смысл проигрыша
            в том, чтобы увидеть мины */}
        {(state === "won" || state === "lost") && (
          <div
            className={`mb-2 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
              state === "won"
                ? "bg-emerald-400/10 text-emerald-300"
                : "bg-red-400/10 text-red-300"
            }`}
          >
            <span>{state === "won" ? t("game.win") : t("game.over")}</span>
            <button
              onClick={reset}
              className="rounded-md border border-halo-line px-2.5 py-1 text-[0.6875rem] text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("game.restart")}
            </button>
          </div>
        )}

        <div
          className="relative grid select-none gap-[3px] rounded-lg bg-halo-deep p-[3px]"
          style={{ gridTemplateColumns: `repeat(${SIZE}, 36px)` }}
        >
          {board.map((cell, i) => (
            <button
              key={i}
              onClick={() => click(i)}
              onContextMenu={(e) => flag(e, i)}
              className={`flex size-9 items-center justify-center text-[0.8125rem] font-bold leading-none ${
                cell.revealed
                  ? cell.mine
                    ? "bg-red-400/30 text-red-300"
                    : "bg-halo-deep ring-1 ring-inset ring-halo-line/25"
                  : // Нераскрытая — «выпуклая» кнопка, как в классике:
                    // светлый верх/лево, тёмный низ/право (через inset-тени —
                    // каскадные border-цвета в Tailwind перекрывают друг друга)
                    "bg-halo-raised shadow-[inset_1px_1px_0_rgba(255,255,255,0.14),inset_-1px_-1px_0_rgba(0,0,0,0.35)] hover:brightness-125"
              }`}
            >
              {cell.flag && !cell.revealed ? (
                <span className="text-red-400"><FlagIcon /></span>
              ) : cell.revealed ? (
                cell.mine ? (
                  <span className="text-halo-text"><BombIcon /></span>
                ) : cell.n > 0 ? (
                  <span className={numClass(cell.n)}>{cell.n}</span>
                ) : (
                  ""
                )
              ) : (
                ""
              )}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[0.6875rem] text-halo-muted/60">{t("game.minesFlagHint")}</p>
    </div>
  );
}
