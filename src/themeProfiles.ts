/**
 * Профили внешнего вида: именованный пресет (Theme + Appearance),
 * переключение одним кликом. Аналог API-профилей, но для оформления.
 *
 * Хранятся в localStorage под одним ключом; при загрузке мусорные записи
 * отбрасываются, частичные добираются дефолтами Appearance.
 */

import { isAmbientScene, type Appearance } from "./appearance";
import { isCustomStyleId } from "./themeStyles";
import { STYLE_PALETTES } from "./themeStyles";
import type { Theme } from "./types";

export interface ThemeProfile {
  id: string;
  name: string;
  theme: Theme;
  appearance: Appearance;
}

const LS_KEY = "haloui-theme-profiles";

// Канонический список стилей - из данных themeStyles (включает 4 новых),
// иначе профили с новыми стилями отбрасывались бы валидатором
const DARK_STYLES: string[] = Object.keys(STYLE_PALETTES);

/** Разбор одной записи: не объект — мимо; поля добираются дефолтами appearance */
export function parseProfile(raw: unknown): ThemeProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name : "";
  if (!name.trim()) return null;
  const theme: Theme = p.theme === "light" ? "light" : "dark";
  const a = (typeof p.appearance === "object" && p.appearance !== null ? p.appearance : {}) as
    Partial<Appearance>;
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    id: typeof p.id === "string" && p.id ? p.id : `tp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    theme,
    appearance: {
      accent: typeof a.accent === "string" ? a.accent : "#d97757",
      // custom-* пропускается: на чужой машине (шеринг темы) палитры нет —
      // честная деградация в claude на уровне CSS, definition не возим
      style:
        typeof a.style === "string" &&
        (DARK_STYLES.includes(a.style) || isCustomStyleId(a.style))
          ? (a.style as Appearance["style"])
          : "claude",
      scale: num(a.scale, 100, 90, 115),
      glassBlur: num(a.glassBlur, 14, 4, 20),
      termFont: num(a.termFont, 11.5, 10, 16),
      markStyle: a.markStyle === "classic" ? "classic" : "bold",
      sidebarGlass: a.sidebarGlass === true,
      customGreeting: typeof a.customGreeting === "string" ? a.customGreeting : "",
      // Official-поля сохраняем, иначе применение профиля молча выключало бы тему
      official: a.official === true,
      officialOled: a.officialOled === true,
      officialContrast: a.officialContrast === true,
      officialMonoCode: a.officialMonoCode === true,
      fullClaude: a.fullClaude === true,
      // Настройки Full Claude возим вместе с темой: serif-чат/звёзды/стекло,
      // радиус и шрифты темы (пустая строка = системный стек)
      fullClaudeSerif: a.fullClaudeSerif ?? true,
      fullClaudeStars: a.fullClaudeStars === true,
      fullClaudeGlass: a.fullClaudeGlass === true,
      fullClaudeRadius: num(a.fullClaudeRadius, 1, 0.4, 1.6),
      fullClaudeUiFont: typeof a.fullClaudeUiFont === "string" ? a.fullClaudeUiFont : "",
      fullClaudeMonoFont:
        typeof a.fullClaudeMonoFont === "string" ? a.fullClaudeMonoFont : "",
      reduceMotion: a.reduceMotion === true,
      motionScale: typeof a.motionScale === 'number' ? a.motionScale : 1,
      ambient: a.ambient === true,
      ambientScene: isAmbientScene(a.ambientScene) ? a.ambientScene : "glow",
      ambientVideo: typeof a.ambientVideo === "string" ? a.ambientVideo : "",
      ambientBrightness: num(a.ambientBrightness, 0.7, 0.3, 1),
      ambientDensity: num(a.ambientDensity, 0.7, 0.3, 1.5),
      ambientRender: a.ambientRender === "behind" ? "behind" : "front",
      // Опциональные поля Appearance: если их НЕ добирать, применение профиля
      // молча сбрасывает конструктор градиента, обои и оба тумблера
      ambientGradFrom: typeof a.ambientGradFrom === "string" ? a.ambientGradFrom : undefined,
      ambientGradTo: typeof a.ambientGradTo === "string" ? a.ambientGradTo : undefined,
      ambientGradAngle: typeof a.ambientGradAngle === "number" ? a.ambientGradAngle : undefined,
      chatWallpaper: typeof a.chatWallpaper === "string" ? a.chatWallpaper : undefined,
      profileTheme: a.profileTheme === true,
      projectAccent: a.projectAccent === true,
      // Кастомизация (шаги 1-7): новые поля добираются дефолтами,
      // иначе применение профиля молча сбрасывало бы их
      radius: num(a.radius, 1, 0.4, 1.6),
      msgScale: num(a.msgScale, 1, 0.85, 1.4),
      density: num(a.density, 1, 0.6, 1.6),
      contentWidth: num(a.contentWidth, 768, 640, 1600),
      showMsgTime: a.showMsgTime === true,
      accentGradient: a.accentGradient === true,
      codeStyle: a.codeStyle === "light" ? "light" : "dark",
      codeTheme: typeof a.codeTheme === "string" ? a.codeTheme : "midnight",
      termPalette: typeof a.termPalette === "string" ? a.termPalette : "default",
      termOpacity: num(a.termOpacity, 1, 0.3, 1),
      termBlur: num(a.termBlur, 0, 0, 20),
      uiFont: typeof a.uiFont === "string" ? a.uiFont : "",
      monoFont: typeof a.monoFont === "string" ? a.monoFont : "",
    },
  };
}

/** Загрузка профилей из localStorage; мусор/ошибки → [] */
export function loadThemeProfiles(): ThemeProfile[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseProfile)
      .filter((p): p is ThemeProfile => p !== null);
  } catch {
    return [];
  }
}

/** Сохранение профилей в localStorage */
export function saveThemeProfiles(list: ThemeProfile[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
