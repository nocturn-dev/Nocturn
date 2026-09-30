import { useEffect, useState } from "react";
import { useLang, type MsgKey } from "../../locales";
import Game2048 from "../../games/Game2048";
import GameMines from "../../games/GameMines";
import GameSnake from "../../games/GameSnake";

export type GameId = "2048" | "mines" | "snake";

/**
 * Раздел «Отдых»: три карточки с превью, «Играть» открывает игру прямо
 * внутри вкладки — настройки скрываются, остаётся игра и подсказка про ESC.
 * Рекорды — в localStorage (haloui-game-*), читаются заново при выходе из игры.
 */

function Preview2048() {
  const cells = [2, 4, 8, 16, 32, 64, 128, 256, 512];
  return (
    <div className="grid grid-cols-3 gap-1 p-3">
      {cells.map((v) => (
        <div
          key={v}
          className="flex aspect-square items-center justify-center rounded-md bg-halo-accent/15 text-[0.625rem] font-semibold text-halo-muted"
          style={{ opacity: 0.35 + (v / 512) * 0.65 }}
        >
          {v}
        </div>
      ))}
    </div>
  );
}

function PreviewMines() {
  return (
    <div className="grid grid-cols-4 gap-1 p-3">
      {["1", "🚩", "", "2", "", "3", "1", "", "💣", "2", "", "1", "", "1", "", ""].map((c, i) => (
        <div
          key={i}
          className="flex aspect-square items-center justify-center rounded-md bg-halo-surface/70 text-[0.6875rem] text-halo-muted"
        >
          {c}
        </div>
      ))}
    </div>
  );
}

function PreviewSnake() {
  return (
    <div className="grid grid-cols-8 gap-1 p-3">
      {Array.from({ length: 24 }).map((_, i) => {
        const snake = [10, 11, 12, 18].includes(i);
        const food = i === 21;
        return (
          <div
            key={i}
            className={`aspect-square rounded-[3px] ${
              snake
                ? "bg-halo-accent snake-preview-seg"
                : food
                  ? "bg-halo-accent/50"
                  : "bg-halo-surface/40"
            }`}
          />
        );
      })}
    </div>
  );
}

const PREVIEWS: Record<GameId, React.ReactNode> = {
  "2048": <Preview2048 />,
  mines: <PreviewMines />,
  snake: <PreviewSnake />,
};

// Названия игр — через локали: русские «Сапёр»/«Змейка» не должны
// показываться при en/zh/ja. 2048 — универсальное имя, мимо словаря
const TITLE_KEYS: Record<Exclude<GameId, "2048">, MsgKey> = {
  mines: "games.mines",
  snake: "games.snake",
};

function bestOf(game: GameId): string {
  const raw = localStorage.getItem(`haloui-game-${game}`);
  return raw ? String(game === "mines" ? `${raw}s` : raw) : "—";
}

export function RestSection({
  game,
  onGameChange,
}: {
  game: GameId | null;
  onGameChange: (g: GameId | null) => void;
}) {
  const { t } = useLang();
  const [, bump] = useState(0);

  // Рекорды на карточках: перечитываем при выходе из игры
  useEffect(() => {
    if (game === null) bump((v) => v + 1);
  }, [game]);

  if (game !== null) {
    return (
      <div className="mx-auto max-w-2xl">
        {/* Подсказка выхода */}
        <div className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-2.5">
          <p className="text-xs text-halo-muted">{t("game.escHint")}</p>
          <button
            onClick={() => onGameChange(null)}
            className="rounded-lg border border-halo-line px-3 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
          >
            {t("game.back")}
          </button>
        </div>
        {game === "2048" && <Game2048 />}
        {game === "mines" && <GameMines />}
        {game === "snake" && <GameSnake />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.rest")}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["2048", "mines", "snake"] as GameId[]).map((id) => (
          <div
            key={id}
            className="group overflow-hidden rounded-xl border border-halo-line bg-halo-surface/50 transition-[transform,border-color] duration-200 hover:-translate-y-1 hover:border-halo-accent/40"
          >
            {/* Превью игры */}
            <div className="border-b border-halo-line/60 bg-halo-deep/40">
              {PREVIEWS[id]}
            </div>
            <div className="p-3">
              <p className="text-sm font-medium text-halo-text">
                {id === "2048" ? "2048" : t(TITLE_KEYS[id])}
              </p>
              <p className="mt-0.5 text-[0.6875rem] text-halo-muted">
                {t("game.record", { n: bestOf(id) })}
              </p>
              <button
                onClick={() => onGameChange(id)}
                className="mt-2.5 w-full rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-3 py-1.5 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
              >
                {t("game.play")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
