import { useState } from "react";
import { ACCENT_PRESETS } from "../appearance";
import { loadCustomStyles } from "../themeStyles";
import type { ModelInfo } from "../api";
import { PROVIDERS } from "../api";
import type { PromptPreset } from "../presets";
import type { Appearance } from "../appearance";
import type { Theme } from "../types";
import ProviderIcon from "./ProviderIcon";
import { useLang } from "../locales";

/**
 * Быстрые настройки (поповер из композера): модель, роль, тема,
 * стекло, масштаб — частотное под рукой, остальное в «Настройках».
 */

interface QuickSettingsProps {
  model: string;
  models: ModelInfo[];
  onModel: (id: string) => void;
  /** Усилие размышлений: off/low/high/max */
  effort: "off" | "low" | "high" | "max";
  onEffortChange: (e: "off" | "low" | "high" | "max") => void;
  promptPresets: PromptPreset[];
  customPresets: PromptPreset[];
  onApplyPreset: (text: string) => void;
  theme: Theme;
  appearance: Appearance;
  onThemeChange: (t: Theme) => void;
  onAppearanceChange: (a: Appearance) => void;
  glass: boolean;
  onGlassChange: (v: boolean) => void;
  onClose: () => void;
}

export default function QuickSettings({
  model,
  models,
  onModel,
  effort,
  onEffortChange,
  promptPresets,
  customPresets,
  onApplyPreset,
  theme,
  appearance,
  onThemeChange,
  onAppearanceChange,
  glass,
  onGlassChange,
  onClose,
}: QuickSettingsProps) {
  const { t } = useLang();
  const [tab, setTab] = useState<"model" | "role" | "look">("model");

  const tabs: { id: typeof tab; label: string }[] = [
    { id: "model", label: t("qs.model") },
    { id: "role", label: t("qs.role") },
    { id: "look", label: t("qs.look") },
  ];

  const darkStyles: { id: Appearance["style"]; label: string }[] = [
    { id: "claude", label: t("themes.styleClaude") },
    { id: "midnight", label: t("themes.styleMidnight") },
    { id: "sepia", label: t("themes.styleSepia") },
    { id: "abyss", label: t("themes.styleAbyss") },
    { id: "storm", label: t("themes.styleStorm") },
    { id: "dusk", label: t("themes.styleDusk") },
    // Конструктор (идея №3): свои стили всегда под рукой во вкладке «Вид»
    ...loadCustomStyles().map((s) => ({ id: s.id as Appearance["style"], label: s.name })),
  ];

  // Reasoning effort: уровни усилия размышлений (off — не отправлять)
  const efforts: { id: typeof effort; label: string }[] = [
    { id: "off", label: t("qs.effortOff") },
    { id: "low", label: t("qs.effortLow") },
    { id: "high", label: t("qs.effortHigh") },
    { id: "max", label: t("qs.effortMax") },
  ];

  return (
    <>
      {/* Клик вне — закрыть */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="glass-pane anim-pop absolute bottom-full right-0 z-40 mb-2 w-80 overflow-hidden rounded-xl border border-halo-line bg-halo-deep/95 shadow-2xl"
      >
        {/* Вкладки */}
        <div className="flex border-b border-halo-line/60 p-1.5">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                tab === tb.id
                  ? "bg-halo-accent/15 text-halo-accent"
                  : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="scroll-slim max-h-72 overflow-y-auto p-2.5">
          {tab === "model" && (
            <div className="space-y-1">
              {models.length === 0 && (
                <p className="px-1 py-2 text-xs text-halo-muted/70">
                  {t("qs.noModels")}
                </p>
              )}              {models.slice(0, 40).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    onModel(m.id);
                    onClose();
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    m.id === model
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                  }`}
                >
                  <ProviderIcon modelId={m.id} size={15} />
                  <span className="min-w-0 flex-1 truncate font-mono">{m.id}</span>
                  {m.vision && (
                    <span className="shrink-0 rounded bg-sky-400/15 px-1 py-0.5 text-[9px] text-sky-400">
                      vision
                    </span>
                  )}
                </button>
              ))}
              {models.length > 40 && (
                <p className="px-1 pt-1 text-[10px] text-halo-muted/50">
                  {t("qs.moreInSettings")}
                </p>
              )}

              {/* Reasoning effort: усилие размышлений поддерживающих моделей */}
              <div className="pt-2">
                <p className="mb-1.5 px-0.5 text-[10px] uppercase tracking-wider text-halo-muted/60">
                  {t("qs.effort")}
                </p>
                <div className="flex rounded-lg border border-halo-line p-0.5">
                  {efforts.map((ef) => (
                    <button
                      key={ef.id}
                      onClick={() => onEffortChange(ef.id)}
                      className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
                        effort === ef.id
                          ? "bg-halo-accent/15 font-medium text-halo-accent"
                          : "text-halo-muted hover:text-halo-text"
                      }`}
                    >
                      {ef.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "role" && (
            <div className="flex flex-wrap gap-1.5">
              {[...promptPresets, ...customPresets].map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onApplyPreset(p.text);
                    onClose();
                  }}
                  title={p.text}
                  className="rounded-full border border-halo-line bg-halo-surface/60 px-2.5 py-1 text-xs text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                >
                  {p.name}
                </button>
              ))}
              {promptPresets.length + customPresets.length === 0 && (
                <p className="px-1 py-2 text-xs text-halo-muted/70">{t("qs.noRoles")}</p>
              )}
            </div>
          )}

          {tab === "look" && (
            <div className="space-y-3">
              {/* Тема */}
              <div>
                <p className="mb-1.5 px-0.5 text-[10px] uppercase tracking-wider text-halo-muted/60">
                  {t("qs.theme")}
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {darkStyles.map((st) => {
                    const active = theme === "dark" && appearance.style === st.id;
                    return (
                      <button
                        key={st.id}
                        onClick={() => {
                          onThemeChange("dark");
                          onAppearanceChange({ ...appearance, style: st.id });
                        }}
                        className={`rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                          active
                            ? "border-halo-accent text-halo-accent"
                            : "border-halo-line text-halo-muted hover:text-halo-text"
                        }`}
                      >
                        {st.label}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => onThemeChange("light")}
                    className={`rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                      theme === "light"
                        ? "border-halo-accent text-halo-accent"
                        : "border-halo-line text-halo-muted hover:text-halo-text"
                    }`}
                  >
                    {t("themes.light")}
                  </button>
                  <button
                    onClick={() => onGlassChange(!glass)}
                    className={`rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                      glass
                        ? "border-halo-accent text-halo-accent"
                        : "border-halo-line text-halo-muted hover:text-halo-text"
                    }`}
                  >
                    {t("themes.glass")}
                  </button>
                </div>
              </div>

              {/* Акцентный цвет: 6 пресетов тем + свой */}
              <div>
                <p className="mb-1.5 px-0.5 text-[10px] uppercase tracking-wider text-halo-muted/60">
                  {t("themes.accent")}
                </p>
                <div className="flex items-center gap-1.5 px-0.5">
                  {ACCENT_PRESETS.map((a) => (
                    <button
                      key={a.hex}
                      onClick={() => onAppearanceChange({ ...appearance, accent: a.hex })}
                      style={{ backgroundColor: a.hex }}
                      title={a.hex}
                      className={`size-5 rounded-full border transition-transform hover:scale-110 ${
                        appearance.accent.toLowerCase() === a.hex.toLowerCase()
                          ? "border-halo-text"
                          : "border-transparent"
                      }`}
                    />
                  ))}
                  <input
                    type="color"
                    value={appearance.accent}
                    onChange={(e) =>
                      onAppearanceChange({ ...appearance, accent: e.target.value })
                    }
                    title={t("themes.accentCustom")}
                    className="h-5 w-7 cursor-pointer rounded border border-halo-line bg-transparent"
                  />
                </div>
              </div>

              {/* Масштаб */}
              <div>
                <div className="mb-1 flex items-center justify-between px-0.5">
                  <p className="text-[10px] uppercase tracking-wider text-halo-muted/60">
                    {t("themes.scale")}
                  </p>
                  <span className="text-[10px] text-halo-muted">{appearance.scale}%</span>
                </div>
                <input
                  type="range"
                  min={90}
                  max={115}
                  step={5}
                  value={appearance.scale}
                  onChange={(e) =>
                    onAppearanceChange({ ...appearance, scale: Number(e.target.value) })
                  }
                  className="w-full accent-[var(--halo-accent)]"
                />
              </div>

              {/* Провайдер — короткая ссылка на полный список */}
              <p className="px-0.5 text-[10px] text-halo-muted/50">
                {t("qs.providerHint")} {PROVIDERS.length} · {t("qs.slashHint")} /provider
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
