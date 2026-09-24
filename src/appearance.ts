/**
 * Кастомизация оформления (лёгкий блок): акцент, стиль тёмной темы,
 * масштаб интерфейса, шрифт терминала.
 *
 * Весь UI сидит на CSS-переменных halo-*, поэтому кастомизация — это
 * переопределение нескольких переменных на <html> + localStorage.
 */

import type { Theme } from "./types";

export type DarkStyle = "claude" | "midnight" | "sepia" | "abyss" | "storm" | "dusk" | "forest" | "rosewood";

export interface Appearance {
  /** Акцентный цвет, hex */
  accent: string;
  /** Палитра тёмного режима */
  style: DarkStyle;
  /** Масштаб интерфейса, % (rem root), 90–115 */
  scale: number;
  /** Интенсивность размытия стекла, px, 4–20 (при выключенном стекле не действует) */
  glassBlur: number;
  /** Размер шрифта терминала/консоли, px, 10–16 */
  termFont: number;
  /** Знак приложения: bold — широкая N с порезами, classic — тонкая */
  markStyle: "bold" | "classic";
  /** Отдельное стекло на сайдбаре (независимо от общего стекла) */
  sidebarGlass: boolean;
  /** Своё приветствие на пустом экране чата (пусто — стандартное по времени суток) */
  customGreeting?: string;
  /** Тема Official: строгий монохром (чёрный/серый/белый), одним тумблером */
  official: boolean;
  /** Official: чистый чёрный фон #000 (OLED-экраны) вместо #0a0a0a */
  officialOled: boolean;
  /** Official: ярче границы и вторичный текст (высокий контраст) */
  officialContrast: boolean;
  /** Official: обесцветить подсветку кода (серая шкала вместо синтакс-цветов) */
  officialMonoCode: boolean;
  /** Ambient-фон: процедурные сцены или своё видео поверх интерфейса */
  ambient: boolean;
  /** Ambient-сцена: glow — прежнее «дыхание акцента», video — свой файл */
  ambientScene: "glow" | "fog" | "snow" | "city" | "stars" | "video";
  /** Путь к видео пользователя (для scene === "video") */
  ambientVideo: string;
  /** Яркость ambient-слоя, 0.3–1 */
  ambientIntensity: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  accent: "#d97757",
  style: "claude",
  scale: 100,
  glassBlur: 14,
  termFont: 11.5,
  markStyle: "bold",
  sidebarGlass: false,
  customGreeting: "",
  official: false,
  officialOled: false,
  officialContrast: false,
  officialMonoCode: false,
  ambient: false,
  ambientScene: "glow",
  ambientVideo: "",
  ambientIntensity: 0.7,
};

const LS_KEY = "haloui-appearance";

export const AMBIENT_SCENES = [
  "glow",
  "fog",
  "snow",
  "city",
  "stars",
  "video",
] as const;

export const ACCENT_PRESETS: { hex: string; deep: string }[] = [
  { hex: "#d97757", deep: "#bd5d3a" }, // терракота Claude
  { hex: "#5f87d4", deep: "#3f66b3" }, // синий
  { hex: "#7fbf5f", deep: "#5d9c40" }, // зелёный
  { hex: "#c07fd4", deep: "#a05fb5" }, // сиреневый
  { hex: "#d9a04a", deep: "#b87f2b" }, // янтарный
  { hex: "#5fc7d4", deep: "#3ba3b2" }, // бирюзовый
];

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const p = JSON.parse(raw) as Partial<Appearance>;
    return {
      accent: p.accent ?? DEFAULT_APPEARANCE.accent,
      style: p.style ?? DEFAULT_APPEARANCE.style,
      scale: clamp(p.scale ?? DEFAULT_APPEARANCE.scale, 90, 115),
      glassBlur: clamp(p.glassBlur ?? DEFAULT_APPEARANCE.glassBlur, 4, 20),
      termFont: clamp(p.termFont ?? DEFAULT_APPEARANCE.termFont, 10, 16),
      markStyle: p.markStyle === "classic" ? "classic" : "bold",
      sidebarGlass: p.sidebarGlass ?? DEFAULT_APPEARANCE.sidebarGlass,
      customGreeting:
        typeof p.customGreeting === "string"
          ? p.customGreeting
          : DEFAULT_APPEARANCE.customGreeting,
      official: p.official ?? DEFAULT_APPEARANCE.official,
      officialOled: p.officialOled ?? DEFAULT_APPEARANCE.officialOled,
      officialContrast: p.officialContrast ?? DEFAULT_APPEARANCE.officialContrast,
      officialMonoCode: p.officialMonoCode ?? DEFAULT_APPEARANCE.officialMonoCode,
      ambient: p.ambient ?? DEFAULT_APPEARANCE.ambient,
      ambientScene: AMBIENT_SCENES.includes(p.ambientScene as never)
        ? (p.ambientScene as Appearance["ambientScene"])
        : "glow",
      ambientVideo: typeof p.ambientVideo === "string" ? p.ambientVideo : "",
      ambientIntensity: clamp(
        p.ambientIntensity ?? DEFAULT_APPEARANCE.ambientIntensity,
        0.3,
        1,
      ),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(a: Appearance) {
  localStorage.setItem(LS_KEY, JSON.stringify(a));
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Затемнение hex-цвета для производной --halo-accent-deep */
function darken(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const r = Math.round(((v >> 16) & 255) * factor);
  const g = Math.round(((v >> 8) & 255) * factor);
  const b = Math.round((v & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Палитра темы Official — строгий монохром. Иерархия поверхностей
 * строится ступенями яркости (границы вместо теней), цвет остаётся
 * только для семантики: diff, статусы инструментов, ошибки.
 */
function officialPalette(a: Appearance): Record<string, string> {
  const soft = {
    "--halo-bg": "#0a0a0a",
    "--halo-deep": "#060606",
    "--halo-surface": "#141414",
    "--halo-raised": "#1d1d1d",
    "--halo-line": a.officialContrast ? "#3d3d3d" : "#262626",
    "--halo-text": "#fafafa",
    "--halo-muted": a.officialContrast ? "#c6c6c6" : "#a3a3a3",
    "--halo-hover": "rgba(255, 255, 255, 0.06)",
    "--halo-hover-strong": "rgba(255, 255, 255, 0.1)",
    "--halo-code-bg": "#0f0f0f",
    "--halo-accent": "#ececec",
    "--halo-accent-deep": "#8f8f8f",
    "--halo-on-accent": "#111111",
  };
  if (!a.officialOled) return soft;
  return {
    ...soft,
    "--halo-bg": "#000000",
    "--halo-deep": "#000000",
    "--halo-surface": "#0d0d0d",
    "--halo-raised": "#161616",
    "--halo-line": a.officialContrast ? "#333333" : "#1f1f1f",
    "--halo-code-bg": "#050505",
  };
}

/** Применяем кастомизацию к <html>; theme нужен дляrem-масштаба (не конфликтует) */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.style.setProperty("--halo-accent", a.accent);
  root.style.setProperty("--halo-accent-deep", darken(a.accent, 0.82));
  root.style.setProperty("--halo-term-font", `${a.termFont}px`);
  root.style.setProperty("--halo-blur", `${a.glassBlur}px`);
  // Вариант знака: NocturnMark переключается через CSS
  root.dataset.mark = a.markStyle;
  root.style.fontSize = `${a.scale}%`;
  root.classList.toggle("sidebar-glass", a.sidebarGlass);
  if (a.style === "claude") root.removeAttribute("data-style");
  else root.setAttribute("data-style", a.style);

  // Тема Official: монохромная палитра инлайном — inline-стили сильнее
  // и html.light, и data-style, и акцента выше, так что никакой каскадной
  // борьбы. Официальная тема всегда тёмная; при выключении все инлайн
  // переопределения снимаются, обычные темы живут как раньше.
  root.classList.toggle("official", a.official);
  root.classList.toggle("official-mono-code", a.official && a.officialMonoCode);
  root.classList.toggle("ambient", a.ambient);
  // Сцена: glow — базовое дыхание (body::before), остальные — слой в App.
  // Интенсивность через переменную, слой читает её из CSS
  if (a.ambient && a.ambientScene !== "glow") {
    root.setAttribute("data-ambient-scene", a.ambientScene);
  } else {
    root.removeAttribute("data-ambient-scene");
  }
  root.style.setProperty("--ambient-alpha", String(a.ambientIntensity));
  if (a.official) {
    const palette = officialPalette(a);
    for (const [k, v] of Object.entries(palette)) {
      root.style.setProperty(k, v);
    }
    // Принудительно тёмный color-scheme (перекрывает html.light)
    root.style.colorScheme = "dark";
  } else {
    root.classList.remove("official-oled", "official-contrast");
    // Акцент и его производную НЕ снимаем: они установлены выше для обычных тем
    for (const k of Object.keys(officialPalette(a))) {
      if (k === "--halo-accent" || k === "--halo-accent-deep") continue;
      root.style.removeProperty(k);
    }
    root.style.removeProperty("color-scheme");
  }
}

export function appearanceTitleStyle(style: DarkStyle, theme: Theme): { bg: string; panel: string; text: string } {
  // Мини-превью для карточек стиля в настройках
  if (style === "midnight") return { bg: "#141416", panel: "#1e1e21", text: "#e6e4ea" };
  if (style === "sepia") return { bg: "#2b2620", panel: "#332d26", text: "#ece3d2" };
  if (style === "abyss") return { bg: "#0c1616", panel: "#122020", text: "#dcebe6" };
  if (style === "storm") return { bg: "#10141c", panel: "#181d27", text: "#e2e7f0" };
  if (style === "dusk") return { bg: "#16121f", panel: "#1f1a2b", text: "#e9e4f2" };
  if (style === "forest") return { bg: "#101613", panel: "#182019", text: "#e4ece2" };
  if (style === "rosewood") return { bg: "#1a1214", panel: "#241a1d", text: "#f0e6e4" };
  return theme === "light"
    ? { bg: "#faf9f5", panel: "#f2efe9", text: "#262524" }
    : { bg: "#262624", panel: "#30302e", text: "#e8e6dc" };
}
