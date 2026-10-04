import { useLang } from "../../locales";
import { Nok } from "../mascot/Nok";
import { ToggleRow } from "./parts";

/**
 * Секция «Маскот» (PLAN.md §21): живая карточка с настоящим Ноком (клики
 * и реакции работают прямо в настройках) + настройки поведения. Размер и
 * свечение — ступени вместо слайдеров: детерминированные пресеты, ничего
 * не уезжает мимо сетки пикселей.
 */

const SIZES = [0.8, 1, 1.3];
const GLOWS = [0.7, 1, 1.5];

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
}) {
  const { t } = useLang();
  const segBtn = (active: boolean) =>
    `rounded-lg border px-2.5 py-1 text-xs transition-colors ${
      active
        ? "border-halo-accent/50 bg-halo-accent/10 text-halo-accent"
        : "border-halo-line text-halo-muted hover:text-halo-text"
    }`;

  return (
    <div className="mt-5">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("mascot.title")}</h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">{t("mascot.sectionDesc")}</p>

      {/* Живая карточка: настоящий Нок на моке композера — тыкай, он живой.
          Кнопка демо-полёта показывает пасхалку без чата */}
      <div className="relative mb-4 overflow-hidden rounded-xl border border-halo-line bg-halo-surface/40 px-4 pb-4 pt-2">
        <div className="relative h-24">
          <div className="absolute left-6 top-9">
            <Nok
              streaming={false}
              activity={null}
              scale={size}
              glowBoost={glow}
              selfActivity={selfActivity}
            />
          </div>
          <div className="absolute inset-x-8 bottom-2 flex h-9 items-center rounded-xl border border-halo-line bg-halo-deep/60 px-3">
            <span className="text-xs text-halo-muted/50">Write a message…</span>
          </div>
        </div>
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-halo-muted/70">
          {t("mascot.previewHint")}
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
