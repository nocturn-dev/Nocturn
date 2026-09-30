import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../locales";

/**
 * 2048: сетка 4×4, стрелки/WASD + свайпы, плитки с идентификаторами —
 * перемещение анимируется CSS-transform (плитка физически едет, а не
 * перерисовывается), слияния с pop-эффектом. Рекорд — в localStorage.
 */

interface Tile {
  id: number;
  r: number;
  c: number;
  v: number;
  /** Новый ход: pop-анимация появления */
  fresh: boolean;
  /** Результат слияния: pop-анимация на месте */
  merged: boolean;
}

type Dir = "up" | "down" | "left" | "right";

const BEST_KEY = "haloui-game-2048";
const SIZE = 4;

let nextId = 1;
const mkTile = (r: number, c: number, v: number): Tile => ({
  id: nextId++,
  r,
  c,
  v,
  fresh: true,
  merged: false,
});

function emptyCells(tiles: Tile[]): Array<[number, number]> {
  const taken = new Set(tiles.map((t) => t.r * SIZE + t.c));
  const out: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!taken.has(r * SIZE + c)) out.push([r, c]);
    }
  }
  return out;
}

function spawn(tiles: Tile[]): Tile[] {
  const cells = emptyCells(tiles);
  const cell = cells[Math.floor(Math.random() * cells.length)];
  if (!cell) return tiles;
  return [...tiles, mkTile(cell[0], cell[1], Math.random() < 0.9 ? 2 : 4)];
}

function lineIndices(dir: Dir): number[][] {
  // Порядок обхода линий: от стороны, в которую едем
  const lines: number[][] = [];
  for (let i = 0; i < SIZE; i++) {
    const line: number[] = [];
    for (let j = 0; j < SIZE; j++) {
      if (dir === "left") line.push(i * SIZE + j);
      else if (dir === "right") line.push(i * SIZE + (SIZE - 1 - j));
      else if (dir === "up") line.push(j * SIZE + i);
      else line.push((SIZE - 1 - j) * SIZE + i);
    }
    lines.push(line);
  }
  return lines;
}

/** Один ход: сжатие + слияния. Возвращает null, если ничего не сдвинулось */
function move(
  tiles: Tile[],
  dir: Dir,
): { tiles: Tile[]; gained: number; moved: boolean } | null {
  const byIndex = new Map(tiles.map((t) => [t.r * SIZE + t.c, t]));
  const result = new Map<number, Tile>();
  let gained = 0;
  let moved = false;

  for (const line of lineIndices(dir)) {
    const inLine = line.map((i) => byIndex.get(i)).filter(Boolean) as Tile[];
    let target = 0;
    let prev: Tile | null = null;
    for (const t of inLine) {
      const pos = line[target];
      if (pos === undefined) continue;
      const r = Math.floor(pos / SIZE);
      const c = pos % SIZE;
      if (prev && prev.v === t.v) {
        // Слияние: предыдущая плитка удваивается, эта исчезает. target НЕ
        // двигается — освободившийся слот занимает следующая плитка
        // (инкремент здесь оставлял дырки в линии и ломал доску)
        prev.v *= 2;
        prev.merged = true;
        gained += prev.v;
        result.set(prev.id, prev);
        moved = true;
        prev = null;
      } else {
        if (t.r !== r || t.c !== c) moved = true;
        const movedTile: Tile = { ...t, r, c, fresh: false, merged: false };
        result.set(movedTile.id, movedTile);
        prev = movedTile;
        target += 1;
      }
    }
  }

  if (!moved) return null;
  return { tiles: Array.from(result.values()), gained, moved };
}

/** Цвет плитки: оттенки акцента по величине */
function tileClass(v: number): string {
  const map: Record<number, string> = {
    2: "bg-halo-surface text-halo-muted",
    4: "bg-halo-surface/80 text-halo-text",
    8: "bg-halo-accent/20 text-halo-text",
    16: "bg-halo-accent/30 text-halo-text",
    32: "bg-halo-accent/40 text-halo-on-accent",
    64: "bg-halo-accent/55 text-halo-on-accent",
    128: "bg-halo-accent/70 text-halo-on-accent",
    256: "bg-halo-accent/85 text-halo-on-accent",
    512: "bg-halo-accent text-halo-on-accent",
    1024: "bg-halo-accent-deep text-halo-on-accent",
    2048: "bg-halo-accent-deep text-halo-on-accent ring-2 ring-halo-accent",
  };
  return map[v] ?? "bg-halo-accent-deep text-halo-on-accent";
}

export default function Game2048() {
  const { t } = useLang();
  const [tiles, setTiles] = useState<Tile[]>(() => spawn(spawn([])));
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => Number(localStorage.getItem(BEST_KEY) ?? 0));
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  const [wonShown, setWonShown] = useState(false);
  const historyRef = useRef<{ tiles: Tile[]; score: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    nextId = 1;
    const fresh = spawn(spawn([]));
    tilesRef.current = fresh;
    setTiles(fresh);
    setScore(0);
    setOver(false);
    setWon(false);
    setWonShown(false);
    historyRef.current = null;
  }, []);

  // Зеркало доски: расчёт хода снаружи setTiles — сайд-эффекты внутри
  // updater'а StrictMode вызывает дважды (ход применялся по два раза)
  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const doMove = useCallback(
    (dir: Dir) => {
      if (over) return;
      const cur = tilesRef.current;
      const res = move(cur, dir);
      if (!res) return;
      historyRef.current = { tiles: cur, score };
      const withNew = spawn(res.tiles);
      tilesRef.current = withNew;
      setTiles(withNew);
      if (res.gained > 0) {
        const nextScore = score + res.gained;
        setScore(nextScore);
        if (nextScore > best) {
          setBest(nextScore);
          localStorage.setItem(BEST_KEY, String(nextScore));
        }
      }
      if (!won && withNew.some((tl) => tl.v >= 2048)) {
        setWon(true);
        setWonShown(true);
      }
      // Проигрыш: нет пустых клеток и ни один ход невозможен
      if (emptyCells(withNew).length === 0) {
        const stuck = (["up", "down", "left", "right"] as Dir[]).every(
          (d) => move(withNew, d) === null,
        );
        if (stuck) setOver(true);
      }
    },
    [over, score, best, won],
  );

  // Клавиатура: стрелки/WASD — ход, Enter — сброс после конца
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, Dir> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
        KeyA: "left",
        KeyD: "right",
        KeyW: "up",
        KeyS: "down",
      };
      const dir = map[e.code];
      if (dir) {
        e.preventDefault();
        e.stopPropagation();
        doMove(dir);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doMove]);

  // Свайпы мышью/тачем по полю
  const onPointerDown = (e: React.PointerEvent) => {
    swipeRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  const undo = () => {
    const h = historyRef.current;
    if (!h) return;
    historyRef.current = null;
    setTiles(h.tiles);
    setScore(h.score);
    setOver(false);
  };

  return (
    <div className="flex flex-col items-center">
      {/* Счёт */}
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.score")}: <b className="text-halo-text">{score}</b>
        </span>
        <span className="rounded-lg border border-halo-line bg-halo-surface/60 px-3 py-1.5 text-xs text-halo-muted">
          {t("game.record", { n: best })}
        </span>
        <button
          onClick={undo}
          disabled={!historyRef.current}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("game.undo")}
        </button>
        <button
          onClick={reset}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("game.restart")}
        </button>
      </div>

      {/* Поле */}
      <div
        ref={boardRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        className="relative aspect-square w-full max-w-[380px] touch-none select-none rounded-xl border border-halo-line bg-halo-deep p-2"
      >
        <div className="relative h-full w-full">
          {tiles.map((tl) => (
            <div
              key={tl.id}
              className="absolute p-1"
              style={{
                width: "25%",
                height: "25%",
                transform: `translate(${tl.c * 100}%, ${tl.r * 100}%)`,
                transition: "transform 110ms ease-out",
              }}
            >
              <div
                className={`flex h-full w-full items-center justify-center rounded-lg font-semibold tabular-nums ${tileClass(tl.v)} ${
                  tl.fresh || tl.merged ? "anim-pop" : ""
                }`}
              >
                {tl.v}
              </div>
            </div>
          ))}
          {/* Оверлеи конца/победы */}
          {(over || (won && wonShown)) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-halo-deep/85">
              <p className="text-lg font-semibold text-halo-text">
                {over ? t("game.over") : t("game.win")}
              </p>
              {won && wonShown && !over && (
                <button
                  onClick={() => setWonShown(false)}
                  className="rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-4 py-1.5 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
                >
                  {t("game.continue")}
                </button>
              )}
              <button
                onClick={reset}
                className="rounded-lg border border-halo-line px-4 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("game.restart")}
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-[0.6875rem] text-halo-muted/60">WASD / ↑↓←→ / свайп</p>
    </div>
  );
}
