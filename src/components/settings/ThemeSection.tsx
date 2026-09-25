import { useState } from "react";
import { useLang, MsgKey } from "../../locales";
import type { Theme } from "../../types";
import { ACCENT_PRESETS, appearanceTitleStyle, Appearance } from "../../appearance";
import type { ThemeProfile } from "../../themeProfiles";
import { dayPeriod } from "../../time";
import { pickVideoFile, ambientRegisterVideo } from "../../api";
import { StylePattern, Dropdown, CheckIcon } from "./parts";

const SHELL_LABELS: Record<"powershell" | "cmd" | "gitbash", string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  gitbash: "Git Bash",
};

export function ThemeSection({
  theme,
  glass,
  appearance,
  onAppearanceChange,
  termShell,
  onTermShellChange,
  themeProfiles,
  onThemeProfilesChange,
  onApplyThemeProfile,
  onThemeChange,
  onGlassChange,
  chatMark,
  onChatMarkChange,
  msgGlass,
  onMsgGlassChange,
}: {
  theme: Theme;
  glass: boolean;
  appearance: Appearance;
  onAppearanceChange: (a: Appearance) => void;
  termShell: string;
  onTermShellChange: (v: string) => void;
  /** Профили внешнего вида: лента чипов + сохранение текущего */
  themeProfiles: ThemeProfile[];
  onThemeProfilesChange: (list: ThemeProfile[]) => void;
  onApplyThemeProfile: (p: ThemeProfile) => void;
  onThemeChange: (t: Theme) => void;
  onGlassChange: (v: boolean) => void;
  chatMark: boolean;
  onChatMarkChange: (v: boolean) => void;
  msgGlass: boolean;
  onMsgGlassChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  // Инлайн-ввод имени нового профиля (окно prompt недоступно в sandbox)
  const [profileSaveOpen, setProfileSaveOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  // Стандартное приветствие по времени суток — подсказка в поле «своё
  // приветствие» (период считается так же, как в ChatArea, src/time.ts)
  const p = dayPeriod();
  const defaultGreetingKey =
    p === "morning"
      ? "chat.greetingMorning"
      : p === "afternoon"
        ? "chat.greetingAfternoon"
        : p === "evening"
          ? "chat.greetingEvening"
          : "chat.greetingNight";
  const darkStyles: { id: Appearance["style"]; key: string }[] = [
    { id: "claude", key: "themes.styleClaude" },
    { id: "midnight", key: "themes.styleMidnight" },
    { id: "sepia", key: "themes.styleSepia" },
    { id: "abyss", key: "themes.styleAbyss" },
    { id: "storm", key: "themes.styleStorm" },
    { id: "dusk", key: "themes.styleDusk" },
    { id: "forest", key: "themes.styleForest" },
    { id: "rosewood", key: "themes.styleRosewood" },
  ];
  // Активный профиль: theme и appearance полностью совпадают с текущими.
  // D18: поэлементная сверка вместо JSON.stringify — порядок ключей объекта
  // не должен влиять (изменение пути мутации гасило чип активности)
  const appearanceEqual = (a: typeof appearance, b: typeof appearance) =>
    Object.keys({ ...a, ...b }).every(
      (k) =>
        (a as unknown as Record<string, unknown>)[k] === (b as unknown as Record<string, unknown>)[k],
    );
  const activeProfileId =
    themeProfiles.find(
      (pr) => pr.theme === theme && appearanceEqual(pr.appearance, appearance),
    )?.id ?? null;
  // Сохранить текущие Theme + Appearance как новый профиль
  const saveThemeProfile = () => {
    const name = profileNameDraft.trim();
    if (!name) return;
    onThemeProfilesChange([
      ...themeProfiles,
      { id: `tp-${Date.now()}`, name, theme, appearance },
    ]);
    setProfileNameDraft("");
    setProfileSaveOpen(false);
  };

  return (
    // Компактная ширина по центру: контент не липнет к краям большого окна
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.themes")}</h3>

      {/* Тема Official: строгий монохром одним тумблером. Включённой теме
          принадлежат только её настройки ниже; обычные контролы темы скрыты */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("themes.official")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("themes.officialDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, official: !appearance.official })
          }
          title={t("themes.official")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.official ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              appearance.official ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Настройки самой Official: только то, что относится к ней */}
      {appearance.official && (
        <div className="mb-4 space-y-1 rounded-xl border border-halo-line px-3.5 py-3">
          <p className="text-xs font-medium text-halo-muted">
            {t("themes.officialSettings")}
          </p>
          {(
            [
              {
                key: "officialOled" as const,
                label: t("themes.officialOled"),
                desc: t("themes.officialOledDesc"),
              },
              {
                key: "officialContrast" as const,
                label: t("themes.officialContrast"),
                desc: t("themes.officialContrastDesc"),
              },
              {
                key: "officialMonoCode" as const,
                label: t("themes.officialMonoCode"),
                desc: t("themes.officialMonoCodeDesc"),
              },
            ] as const
          ).map((row) => (
            <div
              key={row.key}
              className="mt-1 flex items-center justify-between gap-3 rounded-lg px-1 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-halo-text">{row.label}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
                  {row.desc}
                </p>
              </div>
              <button
                onClick={() =>
                  onAppearanceChange({
                    ...appearance,
                    [row.key]: !appearance[row.key],
                  })
                }
                title={row.label}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  appearance[row.key] ? "bg-halo-accent" : "bg-halo-line"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
                    appearance[row.key] ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}

      {!appearance.official && (
        <>
      {/* Профили внешнего вида: переключение пресета одним кликом */}
      <div className="mb-4 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-halo-text">{t("themes.profiles")}</p>
          <button
            onClick={() => {
              setProfileSaveOpen((v) => !v);
              setProfileNameDraft("");
            }}
            title={t("themes.profileSave")}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              profileSaveOpen
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {t("themes.profileSave")}
          </button>
        </div>
        {profileSaveOpen && (
          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={profileNameDraft}
              onChange={(e) => setProfileNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveThemeProfile();
                if (e.key === "Escape") setProfileSaveOpen(false);
              }}
              placeholder={t("themes.profileNamePh")}
              className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <button
              onClick={saveThemeProfile}
              disabled={!profileNameDraft.trim()}
              title={t("themes.profileSave")}
              className="shrink-0 rounded-md border border-halo-line px-2 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:opacity-40"
            >
              ✓
            </button>
          </div>
        )}
        {themeProfiles.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {themeProfiles.map((pr) => (
              <span key={pr.id} className="relative inline-flex items-center">
                <button
                  onClick={() => onApplyThemeProfile(pr)}
                  title={t("themes.profileApply")}
                  className={`rounded-md border py-1 pl-2.5 pr-6 text-xs transition-colors ${
                    activeProfileId === pr.id
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {pr.name}
                </button>
                <button
                  onClick={() =>
                    onThemeProfilesChange(themeProfiles.filter((x) => x.id !== pr.id))
                  }
                  title={t("themes.profileDelete")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-0.5 text-[10px] leading-none text-halo-muted/70 transition-colors hover:text-red-400"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Светлая/тёмная: компактные карточки в один ряд */}
      <div className="grid grid-cols-2 gap-3">
        <ThemeCard
          name={t("themes.dark")}
          selected={theme === "dark"}
          onSelect={() => onThemeChange("dark")}
          bg="#262624"
          panel="#1f1e1d"
          text="#e8e6dc"
        />
        <ThemeCard
          name={t("themes.light")}
          selected={theme === "light"}
          onSelect={() => onThemeChange("light")}
          bg="#faf9f5"
          panel="#f2efe9"
          text="#262524"
        />
      </div>

      {/* Стиль тёмной темы: выпадающий список с живым превью выбранного */}
      <div className="mb-2 mt-4 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-halo-muted">{t("themes.style")}</p>
        <div className="flex items-center gap-2">
          {(() => {
            const preview = appearanceTitleStyle(appearance.style, "dark");
            return (
              <span
                className="flex h-6 w-10 items-center justify-center overflow-hidden rounded-md border border-halo-line"
                style={{ background: preview.bg }}
                aria-hidden
              >
                <span className="text-[22px] leading-none" style={{ color: preview.text, opacity: 0.6 }}>
                  <StylePattern id={appearance.style} />
                </span>
              </span>
            );
          })()}
          <Dropdown
            value={appearance.style}
            options={darkStyles.map((s) => ({ value: s.id, label: t(s.key as MsgKey) }))}
            onSelect={(v) => onAppearanceChange({ ...appearance, style: v as Appearance["style"] })}
            className="w-44"
          />
        </div>
      </div>

      {/* Акцентный цвет */}
      <p className="mb-2 mt-4 text-xs font-medium text-halo-muted">
        {t("themes.accent")}
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-halo-line p-2.5">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.hex}
            onClick={() => onAppearanceChange({ ...appearance, accent: p.hex })}
            title={p.hex}
            className={`size-7 rounded-full border-2 transition-transform hover:scale-110 ${
              appearance.accent.toLowerCase() === p.hex.toLowerCase()
                ? "border-halo-text"
                : "border-transparent"
            }`}
            style={{ background: p.hex }}
          />
        ))}
        <label
          className="ml-1 flex cursor-pointer items-center gap-2 rounded-full border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
          title={t("themes.accentCustom")}
        >
          <input
            type="color"
            value={appearance.accent}
            onChange={(e) => onAppearanceChange({ ...appearance, accent: e.target.value })}
            className="size-4 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          {t("themes.accentCustom")}
        </label>
      </div>
        </>
      )}

      {/* Превью кода: поверхности и подсветка обеих палитр; активная —
          тема текущего интерфейса (Official всегда тёмная) */}
      <p className="mb-2 mt-4 text-xs font-medium text-halo-muted">
        {t("themes.codepv")}
      </p>
      <p className="mb-2 text-xs leading-relaxed text-halo-muted/70">
        {t("themes.codepvDesc")}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <CodePreviewCard
          variant="light"
          title={t("themes.codepvLight")}
          active={!(theme === "dark" || appearance.official)}
        />
        <CodePreviewCard
          variant="dark"
          title={t("themes.codepvDark")}
          active={theme === "dark" || appearance.official}
        />
      </div>

      {/* Масштаб интерфейса */}
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.scale")}</p>
          <p className="text-[10px] text-halo-muted/60">{t("themes.scaleHint")}</p>
        </div>
        <input
          type="range"
          min={90}
          max={115}
          step={1}
          value={appearance.scale}
          onChange={(e) => onAppearanceChange({ ...appearance, scale: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-12 shrink-0 text-right text-xs text-halo-muted">{appearance.scale}%</span>
      </div>


      {!appearance.official && (
      <>
      {/* Знак приложения: новая широкая N или классическая */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.markStyle")}
          </p>
          <p className="text-[10px] leading-relaxed text-halo-muted/60">
            {t("themes.markStyleHint")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(["bold", "classic"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onAppearanceChange({ ...appearance, markStyle: v })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                appearance.markStyle === v
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(v === "bold" ? "themes.markBold" : "themes.markClassic")}
            </button>
          ))}
        </div>
      </div>
      </>
      )}

      {/* Оболочка терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.termShell")}
          </p>
          <p className="text-[10px] leading-relaxed text-halo-muted/60">
            {t("themes.termShellHint")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {(["auto", "powershell", "cmd", "gitbash"] as const).map((sh) => (
            <button
              key={sh}
              onClick={() => onTermShellChange(sh)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                termShell === sh
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {sh === "auto" ? t("themes.shellAuto") : SHELL_LABELS[sh]}
            </button>
          ))}
        </div>
      </div>

      {/* Шрифт терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.termFont")}</p>
          <p className="text-[10px] text-halo-muted/60">{t("themes.termFontHint")}</p>
        </div>
        <input
          type="range"
          min={10}
          max={16}
          step={0.5}
          value={appearance.termFont}
          onChange={(e) => onAppearanceChange({ ...appearance, termFont: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-14 shrink-0 text-right font-mono text-xs text-halo-muted">
          {appearance.termFont}px
        </span>
      </div>

      {!appearance.official && (
      <>
      {glass && (
        <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
          <div className="shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">
              {t("themes.glassBlur")}
            </p>
            <p className="text-[10px] text-halo-muted/60">{t("themes.glassBlurHint")}</p>
          </div>
          <input
            type="range"
            min={4}
            max={20}
            step={1}
            value={appearance.glassBlur}
            onChange={(e) =>
              onAppearanceChange({ ...appearance, glassBlur: Number(e.target.value) })
            }
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
            {appearance.glassBlur}px
          </span>
        </div>
      )}

      {/* Отдельное стекло на сайдбаре */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.sidebarGlass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.sidebarGlassDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, sidebarGlass: !appearance.sidebarGlass })
          }
          title={t("themes.sidebarGlass")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.sidebarGlass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              appearance.sidebarGlass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.glass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.glassDesc")}
          </p>
        </div>
        <button
          onClick={() => onGlassChange(!glass)}
          title={glass ? t("themes.glassOff") : t("themes.glassOn")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            glass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              glass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Своё приветствие: текст на пустом экране чата вместо стандартного */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("settings.customGreeting")}</p>
        <p className="mt-0.5 text-xs text-halo-muted">
          {t("settings.customGreetingHint")}
        </p>
        <input
          type="text"
          value={appearance.customGreeting ?? ""}
          onChange={(e) =>
            onAppearanceChange({ ...appearance, customGreeting: e.target.value })
          }
          placeholder={t(defaultGreetingKey as MsgKey)}
          className="mt-2.5 w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.chatMark")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.chatMarkDesc")}
          </p>
        </div>
        <button
          onClick={() => onChatMarkChange(!chatMark)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            chatMark ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              chatMark ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.msgGlass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.msgGlassDesc")}
          </p>
        </div>
        <button
          onClick={() => onMsgGlassChange(!msgGlass)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            msgGlass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              msgGlass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      </>
      )}

      {/* Ambient-фон: сцены или своё видео. Независим от темы — виден
          и в Halo, и в Official; на стриме ставится на паузу */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("themes.ambient")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("themes.ambientDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, ambient: !appearance.ambient })
          }
          title={t("themes.ambient")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.ambient ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              appearance.ambient ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {appearance.ambient && (
        <div className="mt-2.5 space-y-2.5 rounded-xl border border-halo-line px-3.5 py-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-halo-muted">
              {t("themes.ambientScene")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["glow", "themes.sceneGlow"],
                  ["fog", "themes.sceneFog"],
                  ["snow", "themes.sceneSnow"],
                  ["city", "themes.sceneCity"],
                  ["stars", "themes.sceneStars"],
                  ["video", "themes.sceneVideo"],
                ] as const
              ).map(([id, key]) => (
                <button
                  key={id}
                  onClick={() => onAppearanceChange({ ...appearance, ambientScene: id })}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    appearance.ambientScene === id
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {t(key as MsgKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Слой рендера: поверх интерфейса (с оверлеем) или за ним */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-halo-muted">
              {t("themes.ambientRender")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["front", "themes.ambientFront"],
                  ["behind", "themes.ambientBehind"],
                ] as const
              ).map(([id, key]) => (
                <button
                  key={id}
                  onClick={() => onAppearanceChange({ ...appearance, ambientRender: id })}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    appearance.ambientRender === id
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {t(key as MsgKey)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-halo-muted/70">
              {t("themes.ambientRenderHint")}
            </p>
          </div>

          {/* Яркость: сила свечения слоя (для видео — его прозрачность) */}
          <div className="flex items-center gap-3">
            <p className="shrink-0 text-xs font-medium text-halo-muted">
              {t("themes.ambientBrightness")}
            </p>
            <input
              type="range"
              min={0.3}
              max={1}
              step={0.05}
              value={appearance.ambientBrightness}
              onChange={(e) =>
                onAppearanceChange({
                  ...appearance,
                  ambientBrightness: Number(e.target.value),
                })
              }
              className="min-w-0 flex-1"
            />
            <span className="w-10 shrink-0 text-right text-xs text-halo-muted">
              {Math.round(appearance.ambientBrightness * 100)}%
            </span>
          </div>

          {/* Плотность: количество частиц/пятен/окон; для видео не имеет смысла */}
          {appearance.ambientScene !== "video" && (
            <div className="flex items-center gap-3">
              <p className="shrink-0 text-xs font-medium text-halo-muted">
                {t("themes.ambientDensity")}
              </p>
              <input
                type="range"
                min={0.3}
                max={1.5}
                step={0.05}
                value={appearance.ambientDensity}
                onChange={(e) =>
                  onAppearanceChange({
                    ...appearance,
                    ambientDensity: Number(e.target.value),
                  })
                }
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-right text-xs text-halo-muted">
                {Math.round(appearance.ambientDensity * 100)}%
              </span>
            </div>
          )}

          {appearance.ambientScene === "video" && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    const path = await pickVideoFile();
                    if (!path) return;
                    await ambientRegisterVideo(path);
                    onAppearanceChange({ ...appearance, ambientVideo: path });
                  } catch (e) {
                    window.alert(String(e));
                  }
                }}
                className="rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("themes.ambientVideoPick")}
              </button>
              <span className="min-w-0 truncate font-mono text-[10px] text-halo-muted">
                {appearance.ambientVideo.split(/[\\/]/).pop() ||
                  t("themes.ambientVideoNone")}
              </span>
            </div>
          )}
          {appearance.ambientScene === "video" && (
            <p className="text-[10px] leading-relaxed text-halo-muted/70">
              {t("themes.ambientVideoHint")}
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-halo-muted/70">
        {t("themes.note")}
      </p>
    </div>
  );
}


type CpTok = { c: string; v: string };
const CODEPV_LINES: CpTok[][] = [
  [
    { c: "kw", v: "const " },
    { c: "vr", v: "themePreview" },
    { c: "pl", v: ": " },
    { c: "ty", v: "ThemeConfig" },
    { c: "pl", v: " = {" },
  ],
  [
    { c: "pl", v: "  " },
    { c: "pr", v: "surface" },
    { c: "pl", v: ": " },
    { c: "st", v: '"sidebar"' },
    { c: "pl", v: "," },
  ],
  [
    { c: "pl", v: "  " },
    { c: "pr", v: "accent" },
    { c: "pl", v: ": " },
    { c: "st", v: '"#339CFF"' },
    { c: "pl", v: "," },
  ],
  [
    { c: "pl", v: "  " },
    { c: "pr", v: "contrast" },
    { c: "pl", v: ": " },
    { c: "nm", v: "45" },
    { c: "pl", v: "," },
  ],
  [{ c: "pl", v: "}" }],
];

/** Карточка превью: фиксированный сниппет с подсветкой под палитру.
    Цвета токенов — GitHub Light / Dark, задаются в index.css (.cp-*) */
export function CodePreviewCard({
  variant,
  title,
  active,
}: {
  variant: "light" | "dark";
  title: string;
  active: boolean;
}) {
  const { t } = useLang();
  return (
    <div className="rounded-xl border border-halo-line p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm text-halo-text">{title}</p>
          <p className="text-[10px] text-halo-muted/70">GitHub</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            active
              ? "bg-halo-accent text-halo-on-accent"
              : "border border-halo-line text-halo-muted"
          }`}
        >
          {active
            ? t("themes.codepvActive")
            : variant === "light"
              ? "Light"
              : "Dark"}
        </span>
      </div>
      <pre
        className={`codepv-pre ${
          variant === "light" ? "codepv-light" : "codepv-dark"
        }`}
      >
        {CODEPV_LINES.map((line, i) => (
          <span key={i}>
            {line.map((tok, j) => (
              <span key={j} className={`cp-${tok.c}`}>
                {tok.v}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

export function ThemeCard({
  name,
  selected,
  onSelect,
  bg,
  panel,
  text,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  bg: string;
  panel: string;
  text: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={`rounded-xl border p-2.5 text-left transition-colors ${
        selected
          ? "border-halo-accent"
          : "border-halo-line hover:border-halo-muted/50"
      }`}
    >
      {/* Мини-превью темы */}
      <div
        className="flex h-20 gap-1.5 rounded-lg p-1.5"
        style={{ background: bg }}
      >
        <div className="w-1/3 rounded" style={{ background: panel }} />
        <div className="flex-1 space-y-1.5">
          <div className="h-1.5 w-4/5 rounded" style={{ background: text, opacity: 0.75 }} />
          <div className="h-1.5 w-3/5 rounded" style={{ background: text, opacity: 0.35 }} />
          <div className="mt-2 h-4 w-2/5 rounded-md" style={{ background: "#d97757" }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-0.5">
        <span className="text-sm text-halo-text">{name}</span>
        {selected && (
          <span className="text-halo-accent">
            <CheckIcon />
          </span>
        )}
      </div>
    </button>
  );
}

/** Редактор allowlist (M5.2): команды, разрешённые «Всегда для задачи»,
    плюс глобальный просмотр разрешений всех задач */
