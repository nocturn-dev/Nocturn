import { useEffect, useState } from "react";
import { useLang, MsgKey } from "../../locales";
import type { Theme } from "../../types";
import { ACCENT_PRESETS, ambientGradientDefaults, appearanceTitleStyle, Appearance, FULL_CLAUDE_PALETTE } from "../../appearance";
import { STYLE_PALETTES } from "../../themeStyles";
import type { ThemeProfile } from "../../themeProfiles";
import { dayPeriod } from "../../time";
import {
  pickVideoFile,
  ambientRegisterVideo,
  pickFontFile,
  fontImport,
  fontList,
  fontDelete,
  type CustomFont,
  pickImageFile,
  wallpaperRegister,
  pickSaveFile,
  pickJsonFile,
  chatExportWrite,
  settingsImportRead,
} from "../../api";
import { parseProfile } from "../../themeProfiles";
import ContextMenu from "../ContextMenu";
import { readUserCss, writeUserCss } from "../../userCss";
import {
  CUSTOM_FIELDS,
  isValidHex,
  loadCustomStyles,
  newCustomStyle,
  PALETTE_VAR_NAMES,
  resolvePalette,
  saveCustomStyles,
  type CustomStyleDef,
  type StylePalette,
} from "../../themeStyles";
import { isWindows } from "../../platform";
import { registerCustomFonts, UI_FONT_PRESETS, MONO_FONT_PRESETS } from "../../fonts";
import { CODE_THEMES, CODE_THEME_IDS } from "../../codeThemes";
import { TERMINAL_PALETTES } from "../../vt";
import { StylePattern, Dropdown, CheckIcon, ToggleRow } from "./parts";

const SHELL_LABELS: Record<"powershell" | "cmd" | "gitbash", string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  gitbash: "Git Bash",
};

/** Пресеты цвета знака N (Кастомизация → Брендинг); пусто = фирменный
 *  градиент. Терракота — фирменный акцент, ivory — монохромный вариант */
const MARK_COLOR_PRESETS = ["#d97757", "#f0efec", "#38c7ee", "#a78bfa", "#4ade80", "#f4abab"];

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
  mascot,
  onMascotChange,
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
  /** Маскот Нок у композера (кастомизация) */
  mascot: boolean;
  onMascotChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  // Жёсткие темы (Official / Full Claude): пока активна любая, обычные
  // контролы кастомизации скрыты — у тем свои палитры и свои настройки
  const hardTheme = appearance.official || appearance.fullClaude;
  // Инлайн-ввод имени нового профиля (окно prompt недоступно в sandbox)
  const [profileSaveOpen, setProfileSaveOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  // ПКМ-меню профиля и инлайн-переименование (см. карточку «Профили темы»)
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [profileRenamingId, setProfileRenamingId] = useState<string | null>(null);
  const [profileRenameDraft, setProfileRenameDraft] = useState("");
  // Конструктор собственных тёмных стилей (идея №3): список + редактор
  const [customStyles, setCustomStyles] = useState<CustomStyleDef[]>(() => loadCustomStyles());
  const [editor, setEditor] = useState<{ draft: CustomStyleDef; isNew: boolean } | null>(null);
  // Двухшаговое удаление чипа: первый клик — подсветка, второй — удаление
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Живое превью черновика: инлайн-переменные на html — высший приоритет
  // каскада, витрина красится мгновенно; закрытие редактора детерминированно
  // снимает все 10 переменных
  useEffect(() => {
    const root = document.documentElement;
    if (!editor) {
      for (const k of Object.keys(PALETTE_VAR_NAMES) as (keyof StylePalette)[]) {
        root.style.removeProperty(PALETTE_VAR_NAMES[k]);
      }
      return;
    }
    for (const k of Object.keys(PALETTE_VAR_NAMES) as (keyof StylePalette)[]) {
      root.style.setProperty(PALETTE_VAR_NAMES[k], editor.draft.dark[k]);
    }
    return () => {
      for (const k of Object.keys(PALETTE_VAR_NAMES) as (keyof StylePalette)[]) {
        root.style.removeProperty(PALETTE_VAR_NAMES[k]);
      }
    };
  }, [editor]);

  const setEditorField = (f: (typeof CUSTOM_FIELDS)[number], v: string) => {
    if (!editor) return;
    setEditor({
      ...editor,
      draft: { ...editor.draft, dark: { ...editor.draft.dark, [f]: v } },
    });
  };

  const editorValid =
    editor !== null &&
    editor.draft.name.trim().length > 0 &&
    CUSTOM_FIELDS.every((f) => isValidHex(editor.draft.dark[f]));

  const openCustomEditor = (draft: CustomStyleDef, isNew: boolean) => {
    setDeletingId(null);
    setEditor({ draft, isNew });
  };

  const createCustom = () => {
    const base =
      resolvePalette(appearance.style, "dark") ?? resolvePalette("claude", "dark")!;
    openCustomEditor(newCustomStyle(t("themes.customNewName"), base), true);
  };

  const saveCustomEditor = () => {
    if (!editor || !editorValid) return;
    const list = editor.isNew
      ? [...customStyles, editor.draft]
      : customStyles.map((s) => (s.id === editor.draft.id ? editor.draft : s));
    setCustomStyles(list);
    saveCustomStyles(list); // + перегенерация <style id="halo-custom-styles">
    // Новый стиль сразу применяется; правка применённого остаётся применённой
    if (editor.isNew || appearance.style === editor.draft.id) {
      onAppearanceChange({ ...appearance, style: editor.draft.id });
    }
    setEditor(null);
  };

  const deleteCustom = (id: string) => {
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    setDeletingId(null);
    const list = customStyles.filter((s) => s.id !== id);
    setCustomStyles(list);
    saveCustomStyles(list);
    // Удалён применённый — откат на базу (иначе data-style без палитры)
    if (appearance.style === id) {
      onAppearanceChange({ ...appearance, style: "claude" });
    }
  };
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
  // Пользовательские шрифты: список из манифеста + импорт/удаление
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [userCss, setUserCss] = useState(readUserCss);
  useEffect(() => {
    void fontList()
      .then(setCustomFonts)
      .catch(() => {});
  }, []);
  const importFont = async () => {
    try {
      const path = await pickFontFile();
      if (!path) return;
      const f = await fontImport(path);
      await registerCustomFonts(); // FontFace до применения семейства
      setCustomFonts((prev) => [...prev, f]);
    } catch (e) {
      window.alert(String(e));
    }
  };
  // Экспорт профиля темы: JSON без машинно-специфичных полей (локальные
  // пути обоев и поведенческие тумблеры в файл не идут)
  const exportThemeProfile = async (pr: ThemeProfile) => {
    try {
      const slug =
        pr.name
          .toLowerCase()
          .replace(/[^a-z0-9\u0430-\u044f\u0451]+/gi, "-")
          .replace(/^-+|-+$/g, "") || "theme";
      const path = await pickSaveFile(`nocturn-theme-${slug}.json`);
      if (!path) return;
      const {
        chatWallpaper: _cw,
        profileTheme: _pt,
        projectAccent: _pa,
        ...look
      } = pr.appearance;
      const payload = {
        kind: "nocturn-theme",
        version: 1,
        name: pr.name,
        theme: pr.theme,
        appearance: look,
      };
      await chatExportWrite(path, JSON.stringify(payload, null, 2));
    } catch (e) {
      window.alert(String(e));
    }
  };

  // Импорт профиля темы: валидация kind + parseProfile (дефолты/мусор)
  const importThemeProfile = async () => {
    try {
      const path = await pickJsonFile();
      if (!path) return;
      const raw = await settingsImportRead(path);
      const obj = raw as Record<string, unknown>;
      if (obj.kind !== "nocturn-theme") {
        window.alert(t("themes.profileImportBad"));
        return;
      }
      const profile = parseProfile(obj);
      if (!profile) {
        window.alert(t("themes.profileImportBad"));
        return;
      }
      onThemeProfilesChange([...themeProfiles, profile]);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const pickWallpaper = async () => {
    try {
      const path = await pickImageFile();
      if (!path) return;
      await wallpaperRegister(path); // asset-скоуп до рендера
      onAppearanceChange({ ...appearance, chatWallpaper: path });
    } catch (e) {
      window.alert(String(e));
    }
  };

  const removeFont = async (id: string) => {
    try {
      await fontDelete(id);
    } catch {
      // манифест недоступен — список обновится при следующем открытии
    }
    setCustomFonts((prev) => prev.filter((f) => f.id !== id));
  };

  const darkStyles: { id: Appearance["style"]; key: string }[] = [
    { id: "claude", key: "themes.styleClaude" },
    { id: "midnight", key: "themes.styleMidnight" },
    { id: "sepia", key: "themes.styleSepia" },
    { id: "abyss", key: "themes.styleAbyss" },
    { id: "storm", key: "themes.styleStorm" },
    { id: "dusk", key: "themes.styleDusk" },
    { id: "forest", key: "themes.styleForest" },
    { id: "rosewood", key: "themes.styleRosewood" },
    { id: "ocean", key: "themes.styleOcean" },
    { id: "amethyst", key: "themes.styleAmethyst" },
    { id: "espresso", key: "themes.styleEspresso" },
    { id: "carbon", key: "themes.styleCarbon" },
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
      {
        // uuid, не Date.now(): два профиля в одну миллисекунду получали
        // одинаковый id — дубли React-ключей (см. useApiSettings)
        id: `tp-${crypto.randomUUID()}`,
        name,
        theme,
        appearance,
      },
    ]);
    setProfileNameDraft("");
    setProfileSaveOpen(false);
  };

  // Правка существующего профиля (ПКМ по чипу): раньше смена пары тумблеров
  // требовала «создать новый + удалить старый»
  // Перезаписать профиль текущими Theme+Appearance: id и имя сохраняются,
  // снимок обновляется целиком (тот же контракт, что у «Сохранить текущий»)
  const overwriteThemeProfile = (id: string) => {
    onThemeProfilesChange(
      themeProfiles.map((pr) => (pr.id === id ? { ...pr, theme, appearance } : pr)),
    );
  };
  const renameThemeProfile = (id: string) => {
    const name = profileRenameDraft.trim();
    if (!name) return;
    onThemeProfilesChange(
      themeProfiles.map((pr) => (pr.id === id ? { ...pr, name } : pr)),
    );
    setProfileRenamingId(null);
  };

  return (
    // Компактная ширина по центру: контент не липнет к краям большого окна
    <div className="mx-auto max-w-2xl">

      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gPresets")}</p>

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
          <button
            onClick={() => void importThemeProfile()}
            title={t("themes.profileImport")}
            className="rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
          >
            {t("themes.profileImport")}
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
                // isComposing: энтер подтверждения IME не сохраняет черновик
                if (e.key === "Enter" && !e.nativeEvent.isComposing) saveThemeProfile();
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
            {themeProfiles.map((pr) =>
              profileRenamingId === pr.id ? (
                // Инлайн-переименование (из ПКМ-меню): Enter — сохранить
                // (isComposing!), Esc/блюр — отмена
                <input
                  key={pr.id}
                  type="text"
                  autoFocus
                  value={profileRenameDraft}
                  onChange={(e) => setProfileRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) renameThemeProfile(pr.id);
                    if (e.key === "Escape") setProfileRenamingId(null);
                  }}
                  onBlur={() => setProfileRenamingId(null)}
                  className="w-36 rounded-md border border-halo-accent/60 bg-halo-surface px-2 py-1 text-xs text-halo-text outline-none"
                />
              ) : (
                <span key={pr.id} className="relative inline-flex items-center">
                  <button
                    onClick={() => onApplyThemeProfile(pr)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // Открываем ПОД чипом (по его прямоугольнику), а не в
                      // точке курсора: меню в точке клика наезжало на
                      // название профиля
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setProfileMenu({ x: r.left, y: r.bottom + 6, id: pr.id });
                    }}
                    title={`${t("themes.profileApply")}\n${t("themes.profileMenuHint")}`}
                    className={`rounded-md border py-1 pl-2.5 pr-10 text-xs transition-colors ${
                      activeProfileId === pr.id
                        ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                        : "border-halo-line text-halo-muted hover:text-halo-text"
                    }`}
                  >
                    {pr.name}
                  </button>
                  <button
                    onClick={() => void exportThemeProfile(pr)}
                    title={t("themes.profileExport")}
                    className="absolute right-5 top-1/2 -translate-y-1/2 rounded px-0.5 text-[0.625rem] leading-none text-halo-muted/70 transition-colors hover:text-halo-accent"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() =>
                      onThemeProfilesChange(themeProfiles.filter((x) => x.id !== pr.id))
                    }
                    title={t("themes.profileDelete")}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-0.5 text-[0.625rem] leading-none text-halo-muted/70 transition-colors hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              ),
            )}
          </div>
        )}
      </div>

      {/* ПКМ-меню профиля: правка существующего снимка вместо
          «создать новый + удалить старый» */}
      {profileMenu && (
        <ContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          onClose={() => setProfileMenu(null)}
          items={[
            {
              label: t("themes.profileRename"),
              onSelect: () => {
                const pr = themeProfiles.find((p) => p.id === profileMenu.id);
                setProfileRenameDraft(pr?.name ?? "");
                setProfileRenamingId(profileMenu.id);
              },
            },
            {
              label: t("themes.profileOverwrite"),
              onSelect: () => overwriteThemeProfile(profileMenu.id),
            },
            {
              label: t("themes.profileExport"),
              onSelect: () => {
                const pr = themeProfiles.find((p) => p.id === profileMenu.id);
                if (pr) void exportThemeProfile(pr);
              },
            },
            {
              label: t("themes.profileDelete"),
              danger: true,
              separator: true,
              onSelect: () =>
                onThemeProfilesChange(themeProfiles.filter((x) => x.id !== profileMenu.id)),
            },
          ]}
        />
      )}

      {/* Тема из профиля и акцент проекта: оба opt-in */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.integration")}</p>
        <div className="mt-2">
          <ToggleRow
            label={t("themes.profileTheme")}
            desc={t("themes.profileThemeHint")}
            on={appearance.profileTheme ?? false}
            onChange={(v) => onAppearanceChange({ ...appearance, profileTheme: v })}
          />
        </div>
        <div className="mt-1.5">
          <ToggleRow
            label={t("themes.projectAccent")}
            desc={t("themes.projectAccentHint")}
            on={appearance.projectAccent ?? false}
            onChange={(v) => onAppearanceChange({ ...appearance, projectAccent: v })}
          />
        </div>
      </div>

      {/* Тема Official: строгий монохром одним тумблером. Включённой теме
          принадлежат только её настройки ниже; обычные контролы темы скрыты */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("themes.official")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("themes.officialDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            // Жёсткие темы взаимоисключимы: включение одной выключает другую
            onAppearanceChange({
              ...appearance,
              official: !appearance.official,
              fullClaude: false,
            })
          }
          title={t("themes.official")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.official ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              appearance.official ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Full Claude — третья жёсткая тема (вне каскада кастомизации): класс
          html.full-claude + тег #halo-full-claude с палитрой и пинами
          (appearance.ts, fullClaudeCss). Настройки темы — в карточке ниже;
          глобальные контролы и Official на неё не действуют */}
      <div className="mt-1.5 mb-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("themes.fullClaude")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("themes.fullClaudeDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            // Включение Full Claude гасит Official (и наоборот — см. выше)
            onAppearanceChange({
              ...appearance,
              fullClaude: !appearance.fullClaude,
              official: false,
            })
          }
          title={t("themes.fullClaude")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.fullClaude ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              appearance.fullClaude ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Витрина Full Claude: мини-макет СТРУКТУРЫ Claude Desktop —
          тёмный сайдбар-полоска, лента с пузырём пользователя и композер.
          Клик включает тему; на включённой теме скрыта (вся она и есть превью).
          Цвета — из FULL_CLAUDE_PALETTE, те же, что инжектирует тег темы */}
      {!appearance.fullClaude && (
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, fullClaude: true, official: false })
          }
          className="mt-1.5 mb-4 w-full rounded-xl border border-halo-line p-2.5 text-left transition-colors hover:border-halo-muted/50"
        >
          <div
            className="flex h-24 gap-1.5 overflow-hidden rounded-lg border p-0"
            style={{
              background: FULL_CLAUDE_PALETTE.bg,
              borderColor: FULL_CLAUDE_PALETTE.line,
            }}
          >
            {/* Сайдбар: темнее фона, с активным чатом-пилюлей */}
            <div
              className="flex w-1/4 flex-col gap-1 rounded-l-lg p-1.5"
              style={{ background: FULL_CLAUDE_PALETTE.deep }}
            >
              <div
                className="h-1 w-4/5 rounded"
                style={{ background: FULL_CLAUDE_PALETTE.text, opacity: 0.45 }}
              />
              <div
                className="h-1 w-3/5 rounded"
                style={{ background: FULL_CLAUDE_PALETTE.text, opacity: 0.25 }}
              />
              <div
                className="mt-1 h-3.5 w-full rounded-md"
                style={{ background: "rgba(255, 255, 255, 0.1)" }}
              />
            </div>
            {/* Лента: пузырь пользователя справа, строки ответа, композер */}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
              <div
                className="ml-auto h-4 w-2/5 rounded-md"
                style={{ background: FULL_CLAUDE_PALETTE.raised }}
              />
              <div
                className="h-1.5 w-4/5 rounded"
                style={{ background: FULL_CLAUDE_PALETTE.text, opacity: 0.6 }}
              />
              <div
                className="h-1.5 w-3/5 rounded"
                style={{ background: FULL_CLAUDE_PALETTE.text, opacity: 0.3 }}
              />
              <div
                className="mt-auto flex h-4 items-center rounded-md border px-1.5"
                style={{
                  background: FULL_CLAUDE_PALETTE.surface,
                  borderColor: FULL_CLAUDE_PALETTE.line,
                }}
              >
                <div
                  className="h-1 w-1/3 rounded"
                  style={{ background: FULL_CLAUDE_PALETTE.text, opacity: 0.25 }}
                />
              </div>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between px-0.5">
            <span className="text-sm text-halo-text">{t("themes.fullClaudeShort")}</span>
            <span
              className="size-2.5 rounded-full"
              style={{ background: FULL_CLAUDE_PALETTE.accent }}
            />
          </div>
        </button>
      )}

      {/* Настройки самой Full Claude: действуют ТОЛЬКО внутри темы.
          Перенесены те глобальные тумблеры, что ложатся на специфику
          Claude (шрифт ответов, стекло, скругления, шрифты), плюс свои */}
      {appearance.fullClaude && (
        <div className="mt-1.5 mb-4 rounded-xl border border-halo-line px-3.5 py-3">
          <p className="text-xs font-medium text-halo-muted">{t("themes.fcSettings")}</p>

          <div className="mt-1">
            <ToggleRow
              label={t("themes.fcSerif")}
              desc={t("themes.fcSerifDesc")}
              on={appearance.fullClaudeSerif ?? true}
              onChange={(v) => onAppearanceChange({ ...appearance, fullClaudeSerif: v })}
            />
          </div>
          <div className="mt-1.5">
            <ToggleRow
              label={t("themes.fcGlass")}
              desc={t("themes.fcGlassDesc")}
              on={appearance.fullClaudeGlass ?? false}
              onChange={(v) => onAppearanceChange({ ...appearance, fullClaudeGlass: v })}
            />
          </div>

          {/* Скругления внутри темы: глобальный слайдер радиуса не действует */}
          <div className="mt-2 flex items-center gap-3 rounded-lg px-2.5 py-2">
            <div className="shrink-0">
              <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.fcRadius")}</p>
              <p className="text-[0.625rem] text-halo-muted/60">{t("themes.fcRadiusHint")}</p>
            </div>
            <input
              type="range"
              min={0.4}
              max={1.6}
              step={0.1}
              value={appearance.fullClaudeRadius ?? 1}
              onChange={(e) =>
                onAppearanceChange({ ...appearance, fullClaudeRadius: Number(e.target.value) })
              }
              className="min-w-0 flex-1"
            />
            <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
              {(appearance.fullClaudeRadius ?? 1).toFixed(1)}×
            </span>
          </div>

          {/* Шрифты внутри темы: системный стек по умолчанию */}
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="shrink-0 text-sm text-halo-text">{t("themes.fontUi")}</span>
            <Dropdown
              value={appearance.fullClaudeUiFont ?? ""}
              options={[
                { value: "", label: t("themes.fontSystem") },
                ...UI_FONT_PRESETS.map((f) => ({ value: f.stack, label: f.label })),
                ...customFonts.map((f) => ({ value: f.family, label: f.name })),
              ]}
              onSelect={(v) => onAppearanceChange({ ...appearance, fullClaudeUiFont: v })}
              className="w-60"
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="shrink-0 text-sm text-halo-text">{t("themes.fontMono")}</span>
            <Dropdown
              value={appearance.fullClaudeMonoFont ?? ""}
              options={[
                { value: "", label: t("themes.fontSystem") },
                ...MONO_FONT_PRESETS.map((f) => ({ value: f.stack, label: f.label })),
                ...customFonts.map((f) => ({ value: f.family, label: f.name })),
              ]}
              onSelect={(v) => onAppearanceChange({ ...appearance, fullClaudeMonoFont: v })}
              className="w-60"
            />
          </div>
        </div>
      )}

      {/* Настройки самой Official: только то, что относится к ней */}
      {appearance.official && (
        <div className="mt-1.5 mb-4 space-y-1 rounded-xl border border-halo-line px-3.5 py-3">
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
                  className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
                    appearance[row.key] ? "left-4.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}

      {!hardTheme && (
        <>
      {/* Светлая/тёмная: компактные карточки в один ряд */}
      <div className="grid grid-cols-2 gap-3">
        {/* Превью базовой темы — из эталонных данных палитры (themeStyles),
            а не литералов: копии расползались с реальной темой */}
        <ThemeCard
          name={t("themes.dark")}
          selected={theme === "dark"}
          onSelect={() => onThemeChange("dark")}
          bg={STYLE_PALETTES.claude.dark.bg}
          panel={STYLE_PALETTES.claude.dark.deep}
          text={STYLE_PALETTES.claude.dark.text}
          accent={appearance.accent}
        />
        <ThemeCard
          name={t("themes.light")}
          selected={theme === "light"}
          onSelect={() => onThemeChange("light")}
          bg={STYLE_PALETTES.claude.light.bg}
          panel={STYLE_PALETTES.claude.light.deep}
          text={STYLE_PALETTES.claude.light.text}
          accent={appearance.accent}
        />
      </div>

      {/* Авто-тема: opt-in. Выключена — тема только ручная */}
      <div className="mt-4 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.auto")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("themes.autoHint")}
        </p>
        <div className="mt-2 flex gap-2">
          {(
            [
              ["off", "themes.autoOff"],
              ["system", "themes.autoSystem"],
              ["schedule", "themes.autoSchedule"],
            ] as const
          ).map(([mode, key]) => {
            const active = (appearance.themeAuto ?? "off") === mode;
            return (
              <button
                key={mode}
                onClick={() => onAppearanceChange({ ...appearance, themeAuto: mode })}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? "border-halo-accent bg-halo-accent/10 text-halo-text"
                    : "border-halo-line text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                }`}
              >
                {t(key)}
              </button>
            );
          })}
        </div>
        {(appearance.themeAuto ?? "off") === "schedule" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-4 text-xs text-halo-muted">
            <label className="flex items-center gap-1.5">
              {t("themes.autoDay")}
              <input
                type="time"
                value={appearance.autoDay ?? "08:00"}
                onChange={(e) =>
                  onAppearanceChange({ ...appearance, autoDay: e.target.value })
                }
                className="rounded-lg border border-halo-line bg-halo-surface px-2 py-1 text-xs text-halo-text"
              />
            </label>
            <label className="flex items-center gap-1.5">
              {t("themes.autoNight")}
              <input
                type="time"
                value={appearance.autoNight ?? "20:00"}
                onChange={(e) =>
                  onAppearanceChange({ ...appearance, autoNight: e.target.value })
                }
                className="rounded-lg border border-halo-line bg-halo-surface px-2 py-1 text-xs text-halo-text"
              />
            </label>
          </div>
        )}
        {(appearance.themeAuto ?? "off") !== "off" && (
          <p className="mt-2 text-xs text-halo-muted">
            {t("themes.autoNow")}{" "}
            {t(theme === "light" ? "themes.light" : "themes.dark")}
          </p>
        )}
      </div>

      {/* Палитра/геометрия/шрифты — часть гейта выше: при жёстких темах
          (Official/Full Claude) скрыты целиком, у темы свои акцент,
          скругления и шрифты — иначе задваивалось (фидбек владельца) */}
      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gPalette")}</p>

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
                <span className="text-[1.375rem] leading-none" style={{ color: preview.text, opacity: 0.6 }}>
                  <StylePattern id={appearance.style} />
                </span>
              </span>
            );
          })()}
          <Dropdown
            value={appearance.style}
            options={[
              ...darkStyles.map((s) => ({ value: s.id, label: t(s.key as MsgKey) })),
              ...customStyles.map((s) => ({ value: s.id, label: s.name })),
            ]}
            onSelect={(v) => onAppearanceChange({ ...appearance, style: v as Appearance["style"] })}
            className="w-44"
          />
        </div>
      </div>

      {/* Свои стили (конструктор, идея №3): чипы + редактор с живым превью.
          Пустой список — блок остаётся, но без чипов: точка входа всегда видна */}
      <div className="mb-4 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-halo-text">{t("themes.customTitle")}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
              {t("themes.customHint")}
            </p>
          </div>
          <button
            onClick={createCustom}
            className="shrink-0 rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
          >
            + {t("themes.customCreate")}
          </button>
        </div>

        {customStyles.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {customStyles.map((s) => {
              const active = appearance.style === s.id;
              const deleting = deletingId === s.id;
              return (
                <span
                  key={s.id}
                  onMouseLeave={() => setDeletingId((prev) => (prev === s.id ? null : prev))}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${
                    active
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted"
                  }`}
                >
                  <button
                    onClick={() => onAppearanceChange({ ...appearance, style: s.id })}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="size-3 shrink-0 rounded-sm border border-halo-line"
                      style={{ background: resolvePalette(s.id, "dark")?.bg }}
                      aria-hidden
                    />
                    {s.name}
                  </button>
                  <button
                    onClick={() => openCustomEditor(s, false)}
                    title={t("themes.customEdit")}
                    className="opacity-50 transition-colors hover:opacity-100"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L3.5 16.5 2 22l5.5-1.5Z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => deleteCustom(s.id)}
                    title={deleting ? t("themes.customDeleteConfirm") : t("themes.customDelete")}
                    className={`transition-colors ${
                      deleting ? "text-red-400" : "opacity-50 hover:opacity-100"
                    }`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {editor && (
          <div className="mt-3 rounded-lg border border-halo-line bg-halo-surface/30 p-3">
            <label className="block text-xs text-halo-muted">
              {t("themes.customName")}
              <input
                value={editor.draft.name}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    draft: { ...editor.draft, name: e.target.value.slice(0, 40) },
                  })
                }
                placeholder={t("themes.customNamePh")}
                className="mt-1 w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
            </label>
            <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2">
              {CUSTOM_FIELDS.map((f) => {
                const value = editor.draft.dark[f];
                const ok = isValidHex(value);
                return (
                  <label key={f} className="flex items-center gap-2 text-xs text-halo-muted">
                    <input
                      type="color"
                      value={ok ? value : "#000000"}
                      onChange={(e) => setEditorField(f, e.target.value)}
                      className="size-6 shrink-0 cursor-pointer rounded border border-halo-line bg-transparent"
                      aria-label={t(`themes.customColor${f.charAt(0).toUpperCase()}${f.slice(1)}` as MsgKey)}
                    />
                    <span className="w-20 shrink-0">
                      {t(`themes.customColor${f.charAt(0).toUpperCase()}${f.slice(1)}` as MsgKey)}
                    </span>
                    <input
                      value={value}
                      onChange={(e) => setEditorField(f, e.target.value)}
                      spellCheck={false}
                      className={`w-24 rounded-md border bg-halo-surface px-1.5 py-1 font-mono text-xs text-halo-text outline-none transition-colors ${
                        ok
                          ? "border-halo-line focus:border-halo-accent/60"
                          : "border-red-400/60"
                      }`}
                    />
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setEditor(null)}
                className="rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("prompts.cancel")}
              </button>
              <button
                onClick={saveCustomEditor}
                disabled={!editorValid}
                className="rounded-md bg-halo-accent px-2.5 py-1 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {editor.isNew ? t("themes.customCreate") : t("themes.customSave")}
              </button>
            </div>
          </div>
        )}
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
      {/* Акцент-градиент: opt-in, только заливка bg-элементов.
          Обводка-карточка — как у остальных блоков секции (фидбек 26.09) */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <ToggleRow
          label={t("themes.accentGradient")}
          desc={t("themes.accentGradientHint")}
          on={appearance.accentGradient ?? false}
          onChange={(v) => onAppearanceChange({ ...appearance, accentGradient: v })}
        />
      </div>




      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gGeometry")}</p>

      {/* Масштаб интерфейса */}
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.scale")}</p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.scaleHint")}</p>
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

      {/* Скругления углов: множитель к радиусам Tailwind */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.radius")}</p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.radiusHint")}</p>
        </div>
        <input
          type="range"
          min={0.4}
          max={1.6}
          step={0.1}
          value={appearance.radius ?? 1}
          onChange={(e) => onAppearanceChange({ ...appearance, radius: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
          {(appearance.radius ?? 1).toFixed(1)}×
        </span>
      </div>

      {/* Шрифты: интерфейс и код/терминал + свои шрифты */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.fonts")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("themes.fontImportHint")}
        </p>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="shrink-0 text-sm text-halo-text">{t("themes.fontUi")}</span>
          <Dropdown
            value={appearance.uiFont ?? ""}
            options={[
              { value: "", label: t("themes.fontSystem") },
              ...UI_FONT_PRESETS.map((f) => ({ value: f.stack, label: f.label })),
              ...customFonts.map((f) => ({ value: f.family, label: f.name })),
            ]}
            onSelect={(v) => onAppearanceChange({ ...appearance, uiFont: v })}
            className="w-60"
          />
        </div>

        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="shrink-0 text-sm text-halo-text">{t("themes.fontMono")}</span>
          <Dropdown
            value={appearance.monoFont ?? ""}
            options={[
              { value: "", label: t("themes.fontSystem") },
              ...MONO_FONT_PRESETS.map((f) => ({ value: f.stack, label: f.label })),
              ...customFonts.map((f) => ({ value: f.family, label: f.name })),
            ]}
            onSelect={(v) => onAppearanceChange({ ...appearance, monoFont: v })}
            className="w-60"
          />
        </div>

        <div className="mt-2.5 border-t border-halo-line pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-halo-muted">{t("themes.fontImport")}</p>
            <button
              onClick={() => void importFont()}
              className="rounded-lg border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
            >
              {t("themes.fontImportBtn")}
            </button>
          </div>
          {customFonts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {customFonts.map((f) => (
                <span
                  key={f.id}
                  className="flex items-center gap-1 rounded-full border border-halo-line py-0.5 pl-2.5 pr-1 text-xs text-halo-text"
                >
                  {f.name}
                  <button
                    onClick={() => void removeFont(f.id)}
                    title={t("themes.fontRemove")}
                    className="rounded-full px-1 text-halo-muted transition-colors hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Чтение: текст ответов, плотность, ширина колонки, время — одна карточка */}
      <div className="mt-4 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.reading")}</p>

        <div className="mt-2.5 flex items-center gap-3">
          <div className="w-40 shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.msgScale")}</p>
            <p className="text-[0.625rem] leading-tight text-halo-muted/60">{t("themes.msgScaleHint")}</p>
          </div>
          <input
            type="range"
            min={0.85}
            max={1.4}
            step={0.05}
            value={appearance.msgScale ?? 1}
            onChange={(e) => onAppearanceChange({ ...appearance, msgScale: Number(e.target.value) })}
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
            {Math.round((appearance.msgScale ?? 1) * 100)}%
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <div className="w-40 shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.density")}</p>
            <p className="text-[0.625rem] leading-tight text-halo-muted/60">{t("themes.densityHint")}</p>
          </div>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.1}
            value={appearance.density ?? 1}
            onChange={(e) => onAppearanceChange({ ...appearance, density: Number(e.target.value) })}
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
            {(appearance.density ?? 1).toFixed(1)}×
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <div className="w-40 shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.contentWidth")}</p>
            <p className="text-[0.625rem] leading-tight text-halo-muted/60">{t("themes.contentWidthHint")}</p>
          </div>
          <input
            type="range"
            min={640}
            max={1600}
            step={40}
            value={appearance.contentWidth ?? 768}
            onChange={(e) => onAppearanceChange({ ...appearance, contentWidth: Number(e.target.value) })}
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs text-halo-muted">{appearance.contentWidth ?? 768}px</span>
        </div>

        <div className="mt-2 border-t border-halo-line pt-1">
          <ToggleRow
            label={t("themes.msgTime")}
            desc={t("themes.msgTimeHint")}
            on={appearance.showMsgTime ?? false}
            onChange={(v) => onAppearanceChange({ ...appearance, showMsgTime: v })}
          />
        </div>
        {/* Claude-чтение: фичи из Full Claude, портированные в глобальные */}
        <div className="mt-2 border-t border-halo-line pt-1">
          <ToggleRow
            label={t("themes.serifChat")}
            desc={t("themes.serifChatHint")}
            on={appearance.serifChat ?? false}
            onChange={(v) => onAppearanceChange({ ...appearance, serifChat: v })}
          />
        </div>
        <div className="mt-1">
          <ToggleRow
            label={t("themes.inlineClaude")}
            desc={t("themes.inlineClaudeHint")}
            on={appearance.inlineCodeClaude ?? false}
            onChange={(v) => onAppearanceChange({ ...appearance, inlineCodeClaude: v })}
          />
        </div>
      </div>

        </>
      )}

      {!hardTheme && (
      <>
      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gEffects")}</p>
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              glass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {glass && (
        <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
          <div className="shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">
              {t("themes.glassBlur")}
            </p>
            <p className="text-[0.625rem] text-halo-muted/60">{t("themes.glassBlurHint")}</p>
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              appearance.sidebarGlass ? "left-4.5" : "left-0.5"
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              msgGlass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Маскот Нок (PLAN.md §21): светлячок у композера */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("mascot.title")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("mascot.desc")}
          </p>
        </div>
        <button
          onClick={() => onMascotChange(!mascot)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            mascot ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              mascot ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Шиммер-переливание текста: медленный градиентный сдвиг по
          background-clip: text (эпический эффект на строгих тёмных тонах) */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.textShimmer")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.textShimmerDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, textShimmer: !appearance.textShimmer })
          }
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.textShimmer ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              appearance.textShimmer ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Пара цветов переливания: от → к (поток гоняет эти два цвета) */}
      {appearance.textShimmer && (
        <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
          <div className="shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">
              {t("themes.shimFrom")} → {t("themes.shimTo")}
            </p>
          </div>
          <input
            type="color"
            value={appearance.shimmerFrom ?? "#d97757"}
            onChange={(e) =>
              onAppearanceChange({ ...appearance, shimmerFrom: e.target.value })
            }
            className="h-7 w-10 cursor-pointer rounded border border-halo-line bg-transparent"
            title={t("themes.shimFrom")}
          />
          <input
            type="color"
            value={appearance.shimmerTo ?? "#5f87d4"}
            onChange={(e) =>
              onAppearanceChange({ ...appearance, shimmerTo: e.target.value })
            }
            className="h-7 w-10 cursor-pointer rounded border border-halo-line bg-transparent"
            title={t("themes.shimTo")}
          />
          <span className="ml-auto text-[0.625rem] tabular-nums text-halo-muted/60">
            {appearance.shimmerFrom} → {appearance.shimmerTo}
          </span>
        </div>
      )}

      {/* Motion/Reduced: форс-глушение анимаций поверх системной настройки
          (canvas-сцены ставит на паузу App через paused у AmbientLayer) */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("themes.reduceMotion")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("themes.reduceMotionHint")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, reduceMotion: !(appearance.reduceMotion ?? false) })
          }
          title={t("themes.reduceMotion")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.reduceMotion ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              appearance.reduceMotion ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Подсветка кода: компактный блок — темы с мини-превью реальных цветов
          вместо двух громоздких карточек (фидбек 26.09). В Full Claude
          подсветка своя (midnight) — карточка скрыта вместе с секцией */}
      <div className="mt-4 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-halo-text">{t("themes.codeTheme")}</p>
            <p className="mt-0.5 text-[0.625rem] leading-relaxed text-halo-muted/60">
              {t("themes.codePickHint")}
            </p>
          </div>
          {/* Светлый/тёмный код: компактный переключатель в шапке блока.
              Связан с код-темой: раздельные контролы давали светлую гамму
              синтаксиса на тёмном фоне (и наоборот) — нечитаемые блоки */}
          <div className="flex shrink-0 gap-1">
            {(["light", "dark"] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  const lightTheme = (appearance.codeTheme ?? "midnight") === "light";
                  const nextTheme =
                    v === "light"
                      ? lightTheme
                        ? appearance.codeTheme
                        : "light"
                      : lightTheme
                        ? "midnight"
                        : appearance.codeTheme;
                  onAppearanceChange({ ...appearance, codeStyle: v, codeTheme: nextTheme });
                }}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  (appearance.codeStyle ?? "dark") === v
                    ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {v === "light" ? t("themes.codepvLight") : t("themes.codepvDark")}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2.5">
          <Dropdown
            value={appearance.codeTheme ?? "midnight"}
            options={CODE_THEME_IDS.map((id) => ({
              value: id,
              label: (
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{CODE_THEMES[id]?.label ?? id}</span>
                  <CodeThemeSwatch id={id} />
                </span>
              ),
            }))}
            onSelect={(v) =>
              // Синхронный codeStyle: светлые код-темы требуют светлый фон
              onAppearanceChange({
                ...appearance,
                codeTheme: v,
                codeStyle: v === "light" ? "light" : "dark",
              })
            }
            className="w-full"
          />
        </div>
      </div>
      </>
      )}

      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gBranding")}</p>
      {/* Знак приложения: стиль и цвет. Виден всегда — знак вне палитрового
          каскада (как data-mark), цвет действует и в жёстких темах */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.markStyle")}
          </p>
          <p className="text-[0.625rem] leading-relaxed text-halo-muted/60">
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

      {/* Цвет знака N: пресеты + свой цвет; пустой выбор = фирменный
          градиент. Действует во всех темах, включая жёсткие */}
      <div className="mt-2.5 rounded-xl border border-halo-line p-2.5">
        <p className="px-0.5 text-sm text-halo-text">{t("themes.markColor")}</p>
        <p className="mt-0.5 px-0.5 text-[0.625rem] leading-relaxed text-halo-muted/60">
          {t("themes.markColorHint")}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onAppearanceChange({ ...appearance, markColor: "" })}
            title={t("themes.markReset")}
            className={`flex size-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 ${
              (appearance.markColor ?? "") === ""
                ? "border-halo-text"
                : "border-transparent"
            }`}
            style={{ background: "linear-gradient(135deg, #38C7EE, #254EE1)" }}
          />
          {MARK_COLOR_PRESETS.map((hex) => (
            <button
              key={hex}
              onClick={() => onAppearanceChange({ ...appearance, markColor: hex })}
              title={hex}
              className={`size-7 rounded-full border-2 transition-transform hover:scale-110 ${
                (appearance.markColor ?? "").toLowerCase() === hex.toLowerCase()
                  ? "border-halo-text"
                  : "border-transparent"
              }`}
              style={{ background: hex }}
            />
          ))}
          <label
            className="ml-1 flex cursor-pointer items-center gap-2 rounded-full border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
            title={t("themes.accentCustom")}
          >
            <input
              type="color"
              value={appearance.markColor || "#d97757"}
              onChange={(e) =>
                onAppearanceChange({ ...appearance, markColor: e.target.value })
              }
              className="size-4 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            {t("themes.accentCustom")}
          </label>
        </div>
      </div>

      {!hardTheme && (
        <>
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              chatMark ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      </>
      )}

      {!hardTheme && (
      <>
      {/* Обои чата: картинка за лентой, opt-in. В жёстких темах скрыты —
          темы держат монолитные заливки */}
      <div className="mt-4 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.wallpaper")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("themes.wallpaperHint")}
        </p>
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => void pickWallpaper()}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("themes.wallpaperPick")}
          </button>
          {(appearance.chatWallpaper ?? "") !== "" && (
            <button
              onClick={() => onAppearanceChange({ ...appearance, chatWallpaper: "" })}
              className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
            >
              {t("themes.wallpaperClear")}
            </button>
          )}
        </div>
      </div>
      </>
      )}

      {/* Ambient-фон: сцены или своё видео. Независим от темы — виден
          и в Halo, и в Official; на стриме ставится на паузу. В Full Claude
          скрыт и не действует — тема держит чистые монолитные заливки */}
      {!appearance.fullClaude && (
        <>
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
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
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
                  // Градиент перед видео: видео — последний пункт списка
                  ["gradient", "themes.sceneGradient"],
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
            <p className="mt-1.5 text-[0.625rem] leading-relaxed text-halo-muted/70">
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

          {appearance.ambientScene === "gradient" && (
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {/* Пустые цвета = дефолт из живой темы (ambientGradientDefaults),
                  тот же, что рисует слой: раньше в инпутах был зашитый синий */}
              <label className="flex items-center gap-1.5 text-xs text-halo-muted">
                {t("themes.gradFrom")}
                <input
                  type="color"
                  value={appearance.ambientGradFrom ?? ambientGradientDefaults().from}
                  onChange={(e) =>
                    onAppearanceChange({ ...appearance, ambientGradFrom: e.target.value })
                  }
                  className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-halo-muted">
                {t("themes.gradTo")}
                <input
                  type="color"
                  value={appearance.ambientGradTo ?? ambientGradientDefaults().to}
                  onChange={(e) =>
                    onAppearanceChange({ ...appearance, ambientGradTo: e.target.value })
                  }
                  className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
                />
              </label>
              <label className="col-span-2 flex items-center gap-2">
                <span className="shrink-0">{t("themes.gradAngle")}</span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={appearance.ambientGradAngle ?? 135}
                  onChange={(e) =>
                    onAppearanceChange({ ...appearance, ambientGradAngle: Number(e.target.value) })
                  }
                  className="min-w-0 flex-1"
                />
                <span className="w-10 shrink-0 text-right">{appearance.ambientGradAngle ?? 135}°</span>
              </label>
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
              <span className="min-w-0 truncate font-mono text-[0.625rem] text-halo-muted">
                {appearance.ambientVideo.split(/[\\/]/).pop() ||
                  t("themes.ambientVideoNone")}
              </span>
            </div>
          )}
          {appearance.ambientScene === "video" && (
            <p className="text-[0.625rem] leading-relaxed text-halo-muted/70">
              {t("themes.ambientVideoHint")}
            </p>
          )}
        </div>
      )}
        </>
      )}

      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gTerminal")}</p>

      {/* Оболочка терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.termShell")}
          </p>
          <p className="text-[0.625rem] leading-relaxed text-halo-muted/60">
            {isWindows() ? t("themes.termShellHint") : t("themes.termShellHintUnix")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {(isWindows()
            ? (["auto", "powershell", "cmd", "gitbash"] as const)
            : (["auto"] as const)
          ).map((sh) => (
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
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.termFontHint")}</p>
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

      {/* ANSI-палитра терминала */}
      <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.termPalette")}</p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.termPaletteHint")}</p>
        </div>
        <Dropdown
          value={appearance.termPalette ?? "default"}
          options={Object.keys(TERMINAL_PALETTES).map((id) => ({
            value: id,
            label: id === "default" ? t("themes.termPaletteDefault") : id,
          }))}
          onSelect={(v) => onAppearanceChange({ ...appearance, termPalette: v })}
          className="w-44"
        />
      </div>

      {/* Непрозрачность фона терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.termOpacity")}</p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.termOpacityHint")}</p>
        </div>
        <input
          type="range"
          min={0.3}
          max={1}
          step={0.05}
          value={appearance.termOpacity ?? 1}
          onChange={(e) => onAppearanceChange({ ...appearance, termOpacity: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
          {Math.round((appearance.termOpacity ?? 1) * 100)}%
        </span>
      </div>

      {/* Блюр фона терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.termBlur")}</p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("themes.termBlurHint")}</p>
        </div>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={appearance.termBlur ?? 0}
          onChange={(e) => onAppearanceChange({ ...appearance, termBlur: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-12 shrink-0 text-right text-xs text-halo-muted">{appearance.termBlur ?? 0}px</span>
      </div>

      <p className="mb-2 mt-6 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-halo-muted/60">{t("themes.gAdvanced")}</p>

      {/* Пользовательский CSS: textarea -> <style>, только локальный UI */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.userCss")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("themes.userCssHint")}
        </p>
        <textarea
          value={userCss}
          onChange={(e) => {
            setUserCss(e.target.value);
            writeUserCss(e.target.value);
          }}
          spellCheck={false}
          rows={5}
          placeholder={':root { --halo-accent: #7c4dff; }'}
          className="scroll-slim mt-2 min-h-24 w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/40 focus:border-halo-accent/60"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[0.625rem] text-halo-muted/50">CSS · auto-save</span>
          <button
            onClick={() => {
              setUserCss("");
              writeUserCss("");
            }}
            className="rounded-lg border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("themes.userCssReset")}
          </button>
        </div>
      </div>

      {/* Скорость анимаций: один множитель на все токены движения.
          «Меньше движения» (выше по разделу) полностью выключает анимации */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("themes.motionSpeed")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
          {t("themes.motionSpeedDesc")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              [0.7, "themes.motionFast"],
              [1, "themes.motionNormal"],
              [1.4, "themes.motionSmooth"],
            ] as const
          ).map(([scale, key]) => (
            <button
              key={key}
              onClick={() => onAppearanceChange({ ...appearance, motionScale: scale })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                (appearance.motionScale ?? 1) === scale
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-3 text-xs text-halo-muted/70">

        {t("themes.note")}
      </p>
    </div>
  );
}

/** Мини-превью темы подсветки: двухстрочный мини-дифф (−старая +новая) в
    реальных цветах темы. Цвета парсятся из css темы (hljs-классы) */
interface CodeThemeColors {
  kw: string;
  str: string;
  addBg: string;
  delBg: string;
}

function codeThemeColors(css: string): CodeThemeColors {
  const pickColor = (...classes: string[]): string => {
    for (const c of classes) {
      const m = css.match(new RegExp("\\.hljs-" + c + "\\s*\\{[^}]*?color:\\s*([^;}]+)", "i"));
      if (m?.[1]) return m[1].trim();
    }
    return "#9a9a9a";
  };
  const pickBg = (cls: string, fallback: string): string => {
    const m = css.match(
      new RegExp("\\.hljs-" + cls + "[^{}]*\\{[^}]*?background(?:-color)?:\\s*([^;}]+)", "i"),
    );
    return m?.[1]?.trim() ?? fallback;
  };
  return {
    kw: pickColor("keyword", "built_in", "title"),
    str: pickColor("string", "regexp", "attr"),
    addBg: pickBg("addition", "rgba(63, 185, 80, 0.22)"),
    delBg: pickBg("deletion", "rgba(218, 54, 51, 0.22)"),
  };
}

function CodeThemeSwatch({ id }: { id: string }) {
  const theme = CODE_THEMES[id];
  if (!theme) return null;
  const { kw, str, addBg, delBg } = codeThemeColors(theme.css);
  return (
    <span className="shrink-0 overflow-hidden rounded font-mono text-[0.5625rem] leading-[1.5]">
      <span className="block px-1.5" style={{ background: delBg }}>
        <span style={{ color: kw }}>- </span>
        <span style={{ color: str }}>"old"</span>
      </span>
      <span className="block px-1.5" style={{ background: addBg }}>
        <span style={{ color: kw }}>+ </span>
        <span style={{ color: str }}>"new"</span>
      </span>
    </span>
  );
}

export function ThemeCard({
  name,
  selected,
  onSelect,
  bg,
  panel,
  text,
  accent,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  bg: string;
  panel: string;
  text: string;
  accent: string;
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
          <div className="mt-2 h-4 w-2/5 rounded-md" style={{ background: accent }} />
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
