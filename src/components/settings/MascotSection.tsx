import { useLang, type MsgKey } from "../../locales";
import { Nok } from "../mascot/Nok";
import { NOK_ROWS } from "../mascot/nokSprites";
import { ToggleRow } from "./parts";

/**
 * Секция «Маскот» (PLAN.md §21): живая карточка с настоящим Ноком (клики
 * и реакции работают прямо в настройках) + настройки поведения и внешности.
 * Размер и свечение — ступени вместо слайдеров: детерминированные пресеты,
 * ничего не уезжает мимо сетки пикселей. Цвета частей — пипеткой, пусто —
 * токен темы.
 */

const SIZES = [0.8, 1, 1.3];
const GLOWS = [0.7, 1, 1.5];
/** Нейтральная заглушка для пипетки, пока часть красится токеном темы */
const FALLBACK_HEX: Record<"body" | "glow" | "wing", string> = {
  body: "#3d362e",
  glow: "#e8864a",
  wing: "#8a8178",
};

export function MascotSection({
  mascot,
  onMascotChange,
  size,
  onSizeChange,
  glow,
  onGlowChange,
  easter,
  onEasterChange,
  selfActivity,
  onSelfActivityChange,
  colors,
  onColorChange,
  themeKey,
}: {
  mascot: boolean;
  onMascotChange: (v: boolean) => void;
  /** Масштаб спрайта (0.8 / 1 / 1.3) */
  size: number;
  onSizeChange: (v: number) => void;
  /** Множитель свечения (0.7 / 1 / 1.5) */
  glow: number;
  onGlowChange: (v: number) => void;
  /** Пасхальные команды в чате («Эй Нок, …») */
  easter: boolean;
  onEasterChange: (v: boolean) => void;
  /** Самодеятельность в простое (ноутбук и т.п.) */
  selfActivity: boolean;
  onSelfActivityChange: (v: boolean) => void;
  /** Кастомные цвета частей ("" — токен темы) */
  colors: { body?: string; glow?: string; wing?: string };
  onColorChange: (part: "body" | "glow" | "wing", v: string) => void;
  /** Тема: смена в соседней вкладке — Нок в превью удивляется */
  themeKey: "dark" | "light";
}) {
  const { t } = useLang();
  const segBtn = (active: boolean) =>
    `rounded-lg border px-2.5 py-1 text-xs transition-colors ${
      active
        ? "border-halo-accent/50 bg-halo-accent/10 text-halo-accent"
        : "border-halo-line text-halo-muted hover:text-halo-text"
    }`;
  const colorRow = (part: "body" | "glow" | "wing", key: MsgKey) => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-halo-text">{t(key)}</span>
      <span className="flex items-center gap-2">
        {!colors[part] && (
          <span className="text-[0.625rem] text-halo-muted/60">{t("mascot.colorTheme")}</span>
        )}
        {/* «По теме»: сброс кастома — цвет вернётся к токену */}
        {colors[part] && (
          <button
            onClick={() => onColorChange(part, "")}
            className="rounded-lg border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            {t("mascot.colorTheme")}
          </button>
        )}
        <input
          type="color"
          value={colors[part] || FALLBACK_HEX[part]}
          onChange={(e) => onColorChange(part, e.target.value)}
          className="size-6 shrink-0 cursor-pointer rounded border border-halo-line bg-transparent"
          aria-label={t(key)}
        />
      </span>
    </div>
  );

  return (
    <div className="mt-5">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("mascot.title")}</h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">{t("mascot.sectionDesc")}</p>

      {/* Живая карточка: настоящий Нок на моке композера — тыкай, он живой.
          Посадка масштабо-зависима: при «Крупном» не наезжает на поле */}
      <div className="relative mb-4 overflow-hidden rounded-xl border border-halo-line bg-halo-surface/40 px-4 pb-4 pt-2">
        <div className="relative h-24">
          <div
            className="absolute left-6 z-10"
            style={{ top: 36 - NOK_ROWS * 3 * size + 3 }}
          >
            <Nok
              streaming={false}
              activity={null}
              scale={size}
              glowBoost={glow}
              selfActivity={selfActivity}
              colors={colors}
              themeKey={themeKey}
            />
          </div>
          <div className="absolute inset-x-8 bottom-2 flex h-9 items-center rounded-xl border border-halo-line bg-halo-deep/60 px-3">
            <span className="text-xs text-halo-muted/50">Write a message…</span>
          </div>
        </div>
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-halo-muted/70">
          {t("mascot.previewHint")}
        </p>
        <p className="mt-2 border-t border-halo-line/60 pt-2 text-[0.625rem] italic leading-relaxed text-halo-muted/50">
          {t("mascot.lore")}
        </p>
      </div>

      <ToggleRow
        label={t("mascot.enabled")}
        desc={t("mascot.enabledDesc")}
        on={mascot}
        onChange={onMascotChange}
      />

      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("mascot.size")}</p>
        <div className="mt-2 flex gap-1.5">
          {SIZES.map((v, i) => (
            <button key={v} onClick={() => onSizeChange(v)} className={segBtn(size === v)}>
              {t(i === 0 ? "mascot.sizeS" : i === 1 ? "mascot.sizeM" : "mascot.sizeL")}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("mascot.glow")}</p>
        <div className="mt-2 flex gap-1.5">
          {GLOWS.map((v, i) => (
            <button key={v} onClick={() => onGlowChange(v)} className={segBtn(glow === v)}>
              {t(i === 0 ? "mascot.glowDim" : i === 1 ? "mascot.glowNormal" : "mascot.glowBright")}
            </button>
          ))}
        </div>
      </div>

      {/* Раскраска по частям: пусто — токены темы */}
      <div className="mt-2.5 space-y-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        {colorRow("body", "mascot.colorBody")}
        {colorRow("glow", "mascot.colorGlow")}
        {colorRow("wing", "mascot.colorWing")}
      </div>

      <div className="mt-2.5">
        <ToggleRow
          label={t("mascot.easter")}
          desc={t("mascot.easterDesc")}
          on={easter}
          onChange={onEasterChange}
        />
      </div>
      <div className="mt-2.5">
        <ToggleRow
          label={t("mascot.self")}
          desc={t("mascot.selfDesc")}
          on={selfActivity}
          onChange={onSelfActivityChange}
        />
      </div>
    </div>
  );
}
