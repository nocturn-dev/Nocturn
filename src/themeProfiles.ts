/**
 * Профили внешнего вида: именованный пресет (Theme + Appearance),
 * переключение одним кликом. Аналог API-профилей, но для оформления.
 *
 * Хранятся в localStorage под одним ключом; при загрузке мусорные записи
 * отбрасываются, частичные добираются дефолтами Appearance.
 */

import { AMBIENT_SCENES, type Appearance } from "./appearance";
import type { Theme } from "./types";

export interface ThemeProfile {
  id: string;
  name: string;
  theme: Theme;
  appearance: Appearance;
}

const LS_KEY = "haloui-theme-profiles";

const DARK_STYLES = [
  "claude",
  "midnight",
  "sepia",
  "abyss",
  "storm",
  "dusk",
  "forest",
  "rosewood",
] as const;

/** Разбор одной записи: не объект — мимо; поля добираются дефолтами appearance */
function parseProfile(raw: unknown): ThemeProfile | null {
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
      style: DARK_STYLES.includes(a.style as never) ? (a.style as Appearance["style"]) : "claude",
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
      ambient: a.ambient === true,
      ambientScene: AMBIENT_SCENES.includes(a.ambientScene as never)
        ? (a.ambientScene as Appearance["ambientScene"])
        : "glow",
      ambientVideo: typeof a.ambientVideo === "string" ? a.ambientVideo : "",
      ambientBrightness: num(a.ambientBrightness, 0.7, 0.3, 1),
      ambientDensity: num(a.ambientDensity, 0.7, 0.3, 1.5),
      ambientRender: a.ambientRender === "behind" ? "behind" : "front",
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
