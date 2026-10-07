/**
 * Кастомизация оформления (лёгкий блок): акцент, стиль тёмной темы,
 * масштаб интерфейса, шрифт терминала.
 *
 * Весь UI сидит на CSS-переменных halo-*, поэтому кастомизация — это
 * переопределение нескольких переменных на <html> + localStorage.
 */

import type { Theme } from "./types";
import {
  applyCustomStyles,
  buildThemeCss,
  isCustomStyleId,
  loadCustomStyles,
  resolvePalette,
  STYLE_PALETTES,
  type CustomStyleId,
} from "./themeStyles";
import { applyCodeTheme, CODE_THEME_IDS } from "./codeThemes";
import { STORAGE_KEYS } from "./storageKeys";
import { TERMINAL_PALETTES } from "./vt";

export type DarkStyle =
  | "claude"
  | "midnight"
  | "sepia"
  | "abyss"
  | "storm"
  | "dusk"
  | "forest"
  | "rosewood"
  | "ocean"
  | "amethyst"
  | "espresso"
  | "carbon";

export interface Appearance {
  /** Акцентный цвет, hex */
  accent: string;
  /** Палитра тёмного режима (встроенная или custom-<id> из конструктора) */
  style: DarkStyle | CustomStyleId;
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
  /** Full Claude: полная реплика Claude Desktop (палитра + компонентный слой).
   *  Сознательно вне каскада кастомизации: ни Global-тумблеры, ни Official
   *  на неё не влияют. Взаимоисключима с Official */
  fullClaude: boolean;
  /** Настройки самой Full Claude — действуют только внутри темы */
  /** Чат-ответы серифом (Georgia-стек, как у Claude) — дефолт on */
  fullClaudeSerif: boolean;
  /** Стекло внутри темы (глобальный тумблер стекла игнорируется) — off */
  fullClaudeGlass: boolean;
  /** Масштаб скруглений внутри темы (дефолт 1 = 6–8px по ТЗ) */
  fullClaudeRadius: number;
  /** Шрифт UI внутри темы (пусто = системный гротеск) */
  fullClaudeUiFont: string;
  /** Моно внутри темы (пусто = системный стек) */
  fullClaudeMonoFont: string;
  /** Шрифт ответов серифом (Georgia-стек, как у Claude) — глобальный тумблер;
   *  в жёстких темах не действует (у Full Claude свой fullClaudeSerif) */
  serifChat?: boolean;
  /** Inline-код в стиле Claude: тёплый чип с красноватым ink (red-200/600) */
  inlineCodeClaude?: boolean;
  /** Шиммер-переливание текста (медленный градиентный сдвиг по
   *  background-clip: text) на приветствии пустого экрана */
  textShimmer?: boolean;
  /** Пара цветов переливания (от → к), #rrggbb */
  shimmerFrom?: string;
  shimmerTo?: string;
  /** Цвет знака N (hex); пусто — фирменный градиент циан→синий.
   *  Вне палитрового каскада: действует и в жёстких темах (как data-mark) */
  markColor?: string;
  /** Motion/Reduced: принудительно заглушить анимации интерфейса
   *  (поверх системной prefers-reduced-motion) */
  reduceMotion?: boolean;
  /** Множитель скорости анимаций (0.7 быстро / 1 обычное / 1.4 плавно) */
  motionScale?: number;
  /** Ambient-фон: процедурные сцены или своё видео поверх интерфейса */
  ambient: boolean;
  /** Ambient-сцена: glow — прежнее «дыхание акцента», video — свой файл */
  ambientScene: "glow" | "fog" | "snow" | "city" | "stars" | "video" | "gradient";
  /** Путь к видео пользователя (для scene === "video") */
  ambientVideo: string;
  /** Яркость ambient-слоя: сила свечения, 0.3–1 */
  ambientBrightness: number;
  /** Плотность сцены: количество частиц/пятен/окон, 0.3–1.5 */
  ambientDensity: number;
  /** Слой рендера: front — поверх интерфейса (с оверлеем), behind — за ним */
  ambientRender: "front" | "behind";
  /** Авто-тема: off — вручную; system — как в ОС; schedule — по времени суток */
  themeAuto?: "off" | "system" | "schedule";
  /** Расписание авто-темы: светлая с (HH:MM) */
  autoDay?: string;
  /** Расписание авто-темы: тёмная с (HH:MM) */
  autoNight?: string;
  /** Масштаб текста ответов модели, множитель 0.85–1.4 (1 = как было) */
  msgScale?: number;
  /** Плотность ленты: множитель вертикальных отступов 0.6–1.6 (1 = как было) */
  density?: number;
  /** Ширина колонки сообщений, px 640–1600 (768 = как было, max-w-3xl) */
  contentWidth?: number;
  /** Показывать время в шапке ответов модели (когда оно известно) */
  showMsgTime?: boolean;
  /** Фон код-блоков независимо от темы интерфейса: dark — как в палитре стиля */
  codeStyle?: "dark" | "light";
  /** Масштаб скруглений углов 0.4-1.6 (1 = значения Tailwind) */
  radius?: number;
  /** Акцент-градиент: заливка кнопок/пузырей градиентом accent->deep */
  accentGradient?: boolean;
  /** Обои чата: путь к картинке за лентой сообщений ("" — выключено) */
  chatWallpaper?: string;
  /** Opt-in: при переключении профиля применяется сохранённое в нём оформление */
  profileTheme?: boolean;
  /** Opt-in: при выборе проекта применяется его акцент */
  projectAccent?: boolean;
  /** Конструктор ambient-градиента: цвета и угол (сцена gradient) */
  ambientGradFrom?: string;
  ambientGradTo?: string;
  ambientGradAngle?: number;
  /** Семейство шрифта интерфейса: стек пресета или family импортированного
   *  шрифта; "" — системный (значение подставляется только из наших списков) */
  uiFont?: string;
  /** Семейство шрифта кода и терминала; "" — системный моно */
  monoFont?: string;
  /** Палитра подсветки кода (codeThemes.ts) */
  codeTheme?: string;
  /** ANSI-палитра терминала (vt.ts TERMINAL_PALETTES) */
  termPalette?: string;
  /** Непрозрачность фона терминала 0.3-1 (1 = как было) */
  termOpacity?: number;
  /** Блюр фона терминала, px 0-20 (0 = как было) */
  termBlur?: number;
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
  fullClaude: false,
  fullClaudeSerif: true,
  fullClaudeGlass: false,
  fullClaudeRadius: 1,
  fullClaudeUiFont: "",
  fullClaudeMonoFont: "",
  serifChat: false,
  inlineCodeClaude: false,
  textShimmer: false,
  shimmerFrom: "#d97757",
  shimmerTo: "#5f87d4",
  markColor: "",
  /** Motion/Reduced: принудительно заглушить анимации интерфейса
   *  (поверх системной prefers-reduced-motion) */
  reduceMotion: false,
  motionScale: 1,
  ambient: false,
  ambientScene: "glow",
  ambientVideo: "",
  ambientBrightness: 0.7,
  ambientDensity: 0.7,
  ambientRender: "front",
};

const LS_KEY = STORAGE_KEYS.appearance;

export const AMBIENT_SCENES = [
  "glow",
  "fog",
  "snow",
  "city",
  "stars",
  "gradient",
  "video",
] as const;

/** Guard для сцен с диска/профиля: вместо includes(x as never) — честное
 *  сужение типа (unknown на входе, ambientScene на выходе) */
export function isAmbientScene(v: unknown): v is Appearance["ambientScene"] {
  return (AMBIENT_SCENES as readonly string[]).includes(v as string);
}

// S11: поле deep удалено — нигде не читалось (реально применяется
// darken(accent, 0.82) в applyAppearance), значения в данных расходились
// с рендером и вводили в заблуждение
export const ACCENT_PRESETS: { hex: string }[] = [
  { hex: "#d97757" }, // терракота Claude
  { hex: "#5f87d4" }, // синий
  { hex: "#7fbf5f" }, // зелёный
  { hex: "#c07fd4" }, // сиреневый
  { hex: "#d9a04a" }, // янтарный
  { hex: "#5fc7d4" }, // бирюзовый
];

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const p = JSON.parse(raw) as Partial<Appearance>;
    return {
      accent: p.accent ?? DEFAULT_APPEARANCE.accent,
      // Ссылка на удалённый кастомный стиль откатывается на дефолт — иначе
      // data-style висит без палитры и пользователь видит «сломанный» стиль
      style:
        typeof p.style === "string" &&
        (p.style in STYLE_PALETTES ||
          (isCustomStyleId(p.style) &&
            loadCustomStyles().some((s) => s.id === p.style)))
          ? (p.style as Appearance["style"])
          : DEFAULT_APPEARANCE.style,
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
      reduceMotion: p.reduceMotion ?? DEFAULT_APPEARANCE.reduceMotion,
      // clamp: шкала слайдера ThemeSection 0.7/1/1.4; кривое значение с
      // диска/профиля иначе уходило в --motion-scale сырым (аудит 07.10 A6-11)
      motionScale: clamp(p.motionScale ?? 1, 0.7, 1.4),
      officialOled: p.officialOled ?? DEFAULT_APPEARANCE.officialOled,
      officialContrast: p.officialContrast ?? DEFAULT_APPEARANCE.officialContrast,
      officialMonoCode: p.officialMonoCode ?? DEFAULT_APPEARANCE.officialMonoCode,
      fullClaude: p.fullClaude ?? DEFAULT_APPEARANCE.fullClaude,
      fullClaudeSerif: p.fullClaudeSerif ?? DEFAULT_APPEARANCE.fullClaudeSerif,
      fullClaudeGlass: p.fullClaudeGlass ?? DEFAULT_APPEARANCE.fullClaudeGlass,
      fullClaudeRadius: clamp(
        p.fullClaudeRadius ?? DEFAULT_APPEARANCE.fullClaudeRadius,
        0.4,
        1.6,
      ),
      fullClaudeUiFont: typeof p.fullClaudeUiFont === "string" ? p.fullClaudeUiFont : "",
      fullClaudeMonoFont:
        typeof p.fullClaudeMonoFont === "string" ? p.fullClaudeMonoFont : "",
      serifChat: p.serifChat ?? DEFAULT_APPEARANCE.serifChat,
      inlineCodeClaude:
        p.inlineCodeClaude ?? DEFAULT_APPEARANCE.inlineCodeClaude,
      textShimmer: p.textShimmer ?? DEFAULT_APPEARANCE.textShimmer,
      shimmerFrom:
        typeof p.shimmerFrom === "string" && /^#[0-9a-fA-F]{6}$/.test(p.shimmerFrom)
          ? p.shimmerFrom
          : DEFAULT_APPEARANCE.shimmerFrom,
      shimmerTo:
        typeof p.shimmerTo === "string" && /^#[0-9a-fA-F]{6}$/.test(p.shimmerTo)
          ? p.shimmerTo
          : DEFAULT_APPEARANCE.shimmerTo,
      markColor: typeof p.markColor === "string" ? p.markColor : "",
      ambient: p.ambient ?? DEFAULT_APPEARANCE.ambient,
      ambientScene: isAmbientScene(p.ambientScene) ? p.ambientScene : "glow",
      ambientVideo: typeof p.ambientVideo === "string" ? p.ambientVideo : "",
      ambientBrightness: clamp(
        p.ambientBrightness ?? DEFAULT_APPEARANCE.ambientBrightness,
        0.3,
        1,
      ),
      ambientDensity: clamp(
        p.ambientDensity ?? DEFAULT_APPEARANCE.ambientDensity,
        0.3,
        1.5,
      ),
      ambientRender: p.ambientRender === "behind" ? "behind" : "front",
      themeAuto:
        p.themeAuto === "system" || p.themeAuto === "schedule" ? p.themeAuto : "off",
      autoDay: typeof p.autoDay === "string" ? p.autoDay : "08:00",
      autoNight: typeof p.autoNight === "string" ? p.autoNight : "20:00",
      msgScale: clamp(p.msgScale ?? 1, 0.85, 1.4),
      density: clamp(p.density ?? 1, 0.6, 1.6),
      contentWidth: clamp(p.contentWidth ?? 768, 640, 1600),
      showMsgTime: p.showMsgTime ?? false,
      codeStyle: p.codeStyle === "light" ? "light" : "dark",
      radius: clamp(p.radius ?? 1, 0.4, 1.6),
      accentGradient: p.accentGradient ?? false,
      chatWallpaper: typeof p.chatWallpaper === "string" ? p.chatWallpaper : "",
      profileTheme: p.profileTheme ?? false,
      projectAccent: p.projectAccent ?? false,
      ambientGradFrom: typeof p.ambientGradFrom === "string" ? p.ambientGradFrom : "#16213e",
      ambientGradTo: typeof p.ambientGradTo === "string" ? p.ambientGradTo : "#0f3460",
      ambientGradAngle: clamp(p.ambientGradAngle ?? 135, 0, 360),
      uiFont: typeof p.uiFont === "string" ? p.uiFont : "",
      monoFont: typeof p.monoFont === "string" ? p.monoFont : "",
      codeTheme: CODE_THEME_IDS.includes(p.codeTheme as string)
        ? (p.codeTheme as string)
        : "midnight",
      // Белый список — из TERMINAL_PALETTES (единая точка, не дублированный
      // литерал: четвёртая палитра в vt.ts раньше молча сбрасывалась на
      // default при старте)
      termPalette: (Object.keys(TERMINAL_PALETTES) as string[]).includes(
        p.termPalette as string,
      )
        ? (p.termPalette as string)
        : "default",
      termOpacity: clamp(p.termOpacity ?? 1, 0.3, 1),
      termBlur: clamp(p.termBlur ?? 0, 0, 20),
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
  const v = parseInt(m[1] ?? "", 16);
  const r = Math.round(((v >> 16) & 255) * factor);
  const g = Math.round(((v >> 8) & 255) * factor);
  const b = Math.round((v & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// ---------- Цветовые утилиты для производных слоёв (ambient-сцены) ----------

export type Rgb = [number, number, number];

/** Разбор hex (#rgb/#rrggbb); не-hex значения (oklch, названия) — null:
 *  вызывающая сторона деградирует на дефолт палитры */
export function parseHexColor(v: string): Rgb | null {
  const s = v.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(s) ?? /^#([0-9a-f]{3})$/i.exec(s);
  if (!m) return null;
  const h = m[1] ?? "";
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Линейная интерполяция a→b, t ∈ [0..1] */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

export function rgbCss(c: Rgb): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** RGB → HSL (h 0-360, s/l 0-1) */
export function rgbToHsl(c: Rgb): [number, number, number] {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** HSL → RGB */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Оттенок ambient-сцен из палитры СТИЛЯ: hue берётся у поверхностей
 * (deep/bg), насыщенность форсируется — «Шторм» даёт холодный синий рендер,
 * espresso тёплый, carbon остаётся нейтральным. Акцент сознательно не
 * участвует в окрашивании: дефолтный терракотовый акцент на синем стиле
 * давал коричневый рендер (фидбек 29.09). Фолбэк для нейтральных
 * поверхностей — hue акцента, если он сам не нейтральный.
 */
export function sceneTint(deep: Rgb, bg: Rgb, accent: Rgb): Rgb {
  const base = mixRgb(deep, bg, 0.5);
  const [, surfS, surfL] = rgbToHsl(base);
  if (surfS >= 0.06) return hslToRgb(rgbToHsl(base)[0], 0.45, clamp(surfL, 0.12, 0.22));
  const [accH, accS] = rgbToHsl(accent);
  if (accS >= 0.12) return hslToRgb(accH, 0.45, 0.16);
  return base;
}

/** Живое значение токена темы как Rgb: инлайн-переопределения Official и
 *  производные акценты applyAppearance применяет до любого чтения */
export function cssVarColor(name: string, fallback: string): Rgb {
  if (typeof window === "undefined") return parseHexColor(fallback) ?? ([0, 0, 0] as Rgb);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return parseHexColor(raw) ?? parseHexColor(fallback) ?? ([0, 0, 0] as Rgb);
}

/** Дефолт ambient-градиента из живой темы (сцена gradient без явно
 *  выбранных пользователем цветов): оттенок стиля поверх deep, не зашитый
 *  синий. Единая точка для слоя и инпутов конструктора */
export function ambientGradientDefaults(): { from: string; to: string } {
  const deep = cssVarColor("--halo-deep", "#1f1e1d");
  const accent = cssVarColor("--halo-accent", "#d97757");
  const tint = sceneTint(deep, cssVarColor("--halo-bg", "#262624"), accent);
  return { from: rgbCss(mixRgb(tint, deep, 0.25)), to: rgbCss(deep) };
}

/**
 * Палитра темы Official — строгий монохром. Иерархия поверхностей
 * строится ступенями яркости (границы вместо теней), цвет остаётся
 * только для семантики: diff, статусы инструментов, ошибки.
 *
 * Отдаётся CSS-текстом для отдельного тега <style id="halo-official">,
 * а НЕ инлайном на корне: инлайн-палитру сносила зачистка
 * предпросмотных переменных в редакторе кастомных стилей (ThemeSection,
 * PALETTE_VAR_NAMES) — тема «сбрасывалась» при каждом входе в настройки,
 * оставляя смесь чёрного/серого/синего/белого. Специфичности: палитры
 * стилей — html[data-style]:not(.light) = 0-2-1, :root.official — 0-2-0,
 * поэтому без !important палитра стиля закономерно била бы тег (урок
 * аудита каскада); !important + перенос тега в конец head — последняя
 * инстанция каскада.
 */
export function officialCss(oled: boolean, contrast: boolean): string {
  const line = oled
    ? contrast
      ? "#333333"
      : "#1f1f1f"
    : contrast
      ? "#3d3d3d"
      : "#262626";
  const muted = contrast ? "#c6c6c6" : "#a3a3a3";
  const bg = oled ? "#000000" : "#0a0a0a";
  const deep = oled ? "#000000" : "#060606";
  const surface = oled ? "#0d0d0d" : "#141414";
  const raised = oled ? "#161616" : "#1d1d1d";
  const codeBg = oled ? "#050505" : "#0f0f0f";
  // !important обязателен: правила стилей (buildThemeCss) идут селектором
  // html[data-style="…"]:not(.light) — специфичность 0-2-1, ВЫШЕ :root.official
  // (0-2-0), и без important Storm/Midnight перекрывали монохром целиком
  // («в Official темы не меняются»). Редактор кастомных стилей при Official
  // скрыт, конфликтов с превью нет.
  return [
    ":root.official {",
    `  --halo-bg: ${bg} !important;`,
    `  --halo-deep: ${deep} !important;`,
    `  --halo-surface: ${surface} !important;`,
    `  --halo-raised: ${raised} !important;`,
    `  --halo-line: ${line} !important;`,
    "  --halo-text: #fafafa !important;",
    `  --halo-muted: ${muted} !important;`,
    "  --halo-hover: rgba(255, 255, 255, 0.06) !important;",
    "  --halo-hover-strong: rgba(255, 255, 255, 0.1) !important;",
    `  --halo-code-bg: ${codeBg} !important;`,
    "  --halo-accent: #ececec !important;",
    "  --halo-accent-deep: #8f8f8f !important;",
    "  --halo-on-accent: #111111 !important;",
    "  color-scheme: dark;",
    "}",
  ].join("\n");
}

/**
 * Палитра Full Claude в одном месте: генератор CSS и витрина-превью читают
 * одни и те же значения. Источник — ЖИВОЙ CSS claude.ai (тёмная тема, ramps
 * cds-gray из shared-styles, снято через Browser Use + пипетку со скрина
 * владельца): основной фон gray-850 #151515, сайдбар темнее — gray-870
 * #111111, композер/карточки gray-800 #20201f (тёплый), пузырь = 5% белого
 * поверх фона ≈ #212121, текст gray-50 #f0efec (тёплый ivory), вторичный
 * gray-300 #a5a49a. Акцент — фирменный cds-clay #d97757.
 */
export const FULL_CLAUDE_PALETTE = {
  bg: "#151515",
  deep: "#111111",
  surface: "#20201f",
  raised: "#212121",
  line: "rgba(255, 255, 255, 0.08)",
  text: "#f0efec",
  muted: "#a5a49a",
  accent: "#d97757",
  accentDeep: "#bd5d3a",
  codeBg: "#1b1b1d",
  /** Inline-код: ink = cds-red-200, подложка = 5% белого (cds-alpha-1) */
  codeInk: "#f4abab",
} as const;

/**
 * Палитра и базовые блоки темы Full Claude — реплика Claude Desktop:
 * ультра-тёмный уголь, графитовые карточки с едва холодным отливом,
 * терракотовый акцент, мягкие полупрозрачные границы. Всегда тёмная.
 *
 * Механика — точная копия officialCss: отдельный тег <style id=
 * "halo-full-claude"> в конце head, все палитровые переменные с !important
 * (data-style палитры 0-2-1 и инлайн на корне иначе пробивали бы :root,
 * см. урок Official). Тема вне каскада кастомизации: переменные «Чтения»
 * (масштаб/плотность/ширина), радиус и шрифты фиксируются в скоупе —
 * глобальные слайдеры и выборы шрифтов на неё не действуют.
 */
export function fullClaudeCss(a: Appearance): string {
  const r = clamp(a.fullClaudeRadius ?? 1, 0.4, 1.6);
  // Шрифты: пустое значение = системный стек ИЗ index.css (с emoji-фолбэками)
  // — var не пишем вовсе: собственная копия стека здесь уже дрейфовала
  // (без emoji-фолбэков), а второй источник правды для одной константы
  // гарантированно разъезжается. Непустое — пресет темы + фолбэки
  const fontVars = [
    a.fullClaudeUiFont
      ? `  --halo-font-ui: ${a.fullClaudeUiFont}, ui-sans-serif, system-ui, sans-serif !important;`
      : null,
    a.fullClaudeMonoFont
      ? `  --halo-font-mono: ${a.fullClaudeMonoFont}, ui-monospace, Menlo, Consolas, "Liberation Mono", monospace !important;`
      : null,
  ].filter((l): l is string => l !== null);
  // Чат-ответы серифом — фирменный приём Claude (user sans / assistant serif,
  // ср. data-font-атрибуты claude.ai). Тумблер темы возвращает системный sans
  const serifChat = (a.fullClaudeSerif ?? true)
    ? [
        "html.full-claude .markdown {",
        '  font-family: Georgia, Charter, "Iowan Old Style", "Palatino Linotype", serif;',
        "  line-height: 1.7;",
        "}",
      ]
    : [];
  return [
    [
      ":root.full-claude {",
      `  --halo-bg: ${FULL_CLAUDE_PALETTE.bg} !important;`,
      `  --halo-deep: ${FULL_CLAUDE_PALETTE.deep} !important;`,
      `  --halo-surface: ${FULL_CLAUDE_PALETTE.surface} !important;`,
      `  --halo-raised: ${FULL_CLAUDE_PALETTE.raised} !important;`,
      `  --halo-line: ${FULL_CLAUDE_PALETTE.line} !important;`,
      `  --halo-text: ${FULL_CLAUDE_PALETTE.text} !important;`,
      `  --halo-muted: ${FULL_CLAUDE_PALETTE.muted} !important;`,
      "  --halo-hover: rgba(255, 255, 255, 0.05) !important;",
      "  --halo-hover-strong: rgba(255, 255, 255, 0.08) !important;",
      `  --halo-code-bg: ${FULL_CLAUDE_PALETTE.codeBg} !important;`,
      `  --halo-code-text: ${FULL_CLAUDE_PALETTE.text} !important;`,
      `  --halo-accent: ${FULL_CLAUDE_PALETTE.accent} !important;`,
      `  --halo-accent-deep: ${FULL_CLAUDE_PALETTE.accentDeep} !important;`,
      "  --halo-on-accent: #ffffff !important;",
      "  --halo-blur: 14px !important;",
      `  --halo-radius-scale: ${r} !important;`,
      "  --halo-msg-scale: 1 !important;",
      "  --halo-density: 1 !important;",
      "  --halo-content-width: 48rem !important;",
      ...fontVars,
      "  color-scheme: dark;",
      "}",
    ],
    ...serifChat,
    // Inline-код — точные токены claude.ai (tiptip p>code): подложка 5%
    // белого (cds-alpha-1), волосяная рамка 20% (cds-alpha-3), ink
    // cds-red-200 #f4abab, radius 0.3rem. Блоки кода — графит с тонкой
    // рамкой и скруглением 8px (базовое 0.75rem для карточек слишком круглое)
    [
      "html.full-claude .markdown code:not(pre code) {",
      "  background: rgba(255, 255, 255, 0.05);",
      "  border: 0.5px solid rgba(255, 255, 255, 0.2);",
      `  color: ${FULL_CLAUDE_PALETTE.codeInk};`,
      "  border-radius: 0.3rem;",
      "}",
      "html.full-claude .markdown pre {",
      "  border-radius: 0.5rem;",
      "}",
    ],
    // Заголовки секций сайдбара (Файлы/Заметки/Проекты): пользовательский
    // header-color применяется инлайном — нейтрализуем его в теме (!important
    // бьёт инлайн), серый вторичного текста как у Claude (cds-gray-300 @ 55%)
    [
      "html.full-claude aside .uppercase {",
      "  color: rgba(165, 164, 154, 0.55) !important;",
      "}",
      "html.full-claude aside .uppercase:hover {",
      "  color: var(--halo-text) !important;",
      "}",
    ],
    // Поверхности «наполнения»: в Nocturn сайдбар и модалки делят
    // --halo-deep, а в референсе сайдбар темнее фона, модалки — светлее.
    // deep остаётся сайдбару (aside.bg-halo-deep), модалки/панели
    // (glass-pane, правые панели с shadow-2xl) приподнимаются до surface.
    // Непрозрачные варианты гейтятся :not(.glass): панель настроек несёт
    // glass-pane + bg-halo-deep + shadow-2xl — ungated opaque-правило
    // шло в теге позже стеклянных и при равной специфичности убивало
    // полупрозрачность (blur был, фон непрозрачный — «стекло не видать»)
    [
      "html.full-claude:not(.glass) .glass-pane {",
      `  background: ${FULL_CLAUDE_PALETTE.surface};`,
      "}",
      // Стекло (fcGlass): сперва плотный фолбэк, полупрозрачность — только
      // под @supports (конвенция C5: WebKitGTK < 2.40 отбрасывает
      // декларацию color-mix ЦЕЛИКОМ, правило «пустеет»)
      "html.full-claude.glass .glass-pane {",
      `  background: ${FULL_CLAUDE_PALETTE.surface};`,
      "}",
      "html.full-claude.glass .bg-halo-deep.shadow-2xl {",
      `  background: ${FULL_CLAUDE_PALETTE.surface};`,
      "}",
      "@supports (background: color-mix(in srgb, red, transparent)) {",
      "  html.full-claude.glass .glass-pane {",
      `    background: color-mix(in srgb, ${FULL_CLAUDE_PALETTE.surface} 70%, transparent);`,
      "  }",
      "  html.full-claude.glass .bg-halo-deep.shadow-2xl {",
      `    background: color-mix(in srgb, ${FULL_CLAUDE_PALETTE.surface} 70%, transparent);`,
      "  }",
      "}",
      "html.full-claude:not(.glass) .bg-halo-deep.shadow-2xl {",
      `  background: ${FULL_CLAUDE_PALETTE.surface};`,
      "}",
      // Blur под непрозрачным фоном невидим, но движок продолжает снапшотить
      // (контракт D13 в index.css): гасим там же, где Official —
      // html.official .glass-pane/.msg-glass (аудит A6-2)
      "html.full-claude:not(.glass) .glass-pane,",
      "html.full-claude:not(.glass) .msg-glass {",
      "  backdrop-filter: none;",
      "  -webkit-backdrop-filter: none;",
      "}",
    ],
  ].flat().join("\n");
}

/** Применяем кастомизацию к <html>; theme нужен дляrem-масштаба (не конфликтует) */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  // Снимаем инлайн-фон, поставленный boot-theme.js (анти-FOUC до загрузки
  // CSS). Инлайн сильнее ЛЮБОГО авторского правила — из-за него градиент
  // html.glass из index.css никогда не применялся. Здесь бандл уже исполнен,
  // стили загружены: фон дальше ведут правила (glass-градиент / body bg)
  root.style.removeProperty("background");
  // И статический фолбэк из index.html: непрозрачный фон html запрещает
  // трансляцию фона body на canvas (CSS Backgrounds §3.11.2), и
  // непрозрачный body на шаге 3 отрисовки накрывал ВСЕ слои z-index:-1 —
  // ambient «за интерфейсом» и лента лирики были невидимы без стекла
  // (аудит А6-1). В стекле canvas и так красит градиент html.glass (0,1,1),
  // zen — собственный !important; фолбэк нужен только до загрузки CSS
  document.getElementById("halo-boot-bg")?.remove();
  // Палитры стилей генерируются из данных (themeStyles.ts) и инжектируются
  // один раз: светлые варианты стилей живут наравне с тёмными
  let styleCss = document.getElementById("halo-theme-styles");
  if (!styleCss) {
    styleCss = document.createElement("style");
    styleCss.id = "halo-theme-styles";
    styleCss.textContent = buildThemeCss();
    document.head.appendChild(styleCss);
  }
  // Кастомные стили (конструктор): отдельный тег, обновляется при мутациях,
  // здесь — идемпотентная инициализация на старте
  applyCustomStyles();
  // Акцент: при Official/Full Claude НЕ пишем инлайн — акцент темы даёт её
  // тег (монохром #ececec / терракота #d97757); инлайн перебил бы его каскадно.
  // При выключении — возвращаем акцент пользователя инлайном
  if (a.official || a.fullClaude) {
    root.style.removeProperty("--halo-accent");
    root.style.removeProperty("--halo-accent-deep");
  } else {
    root.style.setProperty("--halo-accent", a.accent);
    root.style.setProperty("--halo-accent-deep", darken(a.accent, 0.82));
  }
  root.style.setProperty("--halo-term-font", `${a.termFont}px`);
  root.style.setProperty("--halo-blur", `${a.glassBlur}px`);
  // Чтение (кастомизация): дефолты vars = текущий дизайн
  root.style.setProperty("--halo-msg-scale", String(a.msgScale ?? 1));
  root.style.setProperty("--halo-radius-scale", String(a.radius ?? 1));
  // Шрифты: стеки дополняются системными фолбэками, пусто = не переопределяем
  if (a.uiFont) {
    root.style.setProperty("--halo-font-ui", `${a.uiFont}, ui-sans-serif, system-ui, sans-serif`);
  } else {
    root.style.removeProperty("--halo-font-ui");
  }
  if (a.monoFont) {
    // Фолбэк кроссплатформенный: Consolas — только Windows, Menlo — macOS,
    // Liberation Mono — Linux; ui-monospace ловит системный моно везде
    root.style.setProperty(
      "--halo-font-mono",
      `${a.monoFont}, ui-monospace, Menlo, Consolas, "Liberation Mono", monospace`,
    );
  } else {
    root.style.removeProperty("--halo-font-mono");
  }
  // Палитра подсветки кода + терминал: прозрачность/блюр (дефолты = как было).
  // Full Claude фиксирует свою подсветку — выбор codeTheme в теме не действует
  applyCodeTheme(a.fullClaude ? "midnight" : (a.codeTheme ?? "midnight"));
  root.style.setProperty("--halo-term-opacity", String(a.termOpacity ?? 1));
  root.style.setProperty("--halo-density", String(a.density ?? 1));
  root.style.setProperty("--halo-content-width", `${a.contentWidth ?? 768}px`);
  // Фон код-блоков независимо от темы: инлайном только при переопределении,
  // иначе палитра стиля (data-style) продолжает управлять --halo-code-bg.
  // В Full Claude фон даёт тег темы — инлайн не пишем
  if (a.codeStyle === "light" && !a.fullClaude) {
    root.style.setProperty("--halo-code-bg", "#f0eee6");
    root.style.setProperty("--halo-code-text", "#2a2926");
  } else {
    root.style.removeProperty("--halo-code-bg");
    root.style.removeProperty("--halo-code-text");
  }
  // Вариант знака: NocturnMark переключается через CSS
  root.dataset.mark = a.markStyle;
  // Цвет знака N: вне палитрового каскада — действует во всех темах
  // (как data-mark). Пусто = фирменный градиент из дефолтов компонента
  if (a.markColor) {
    const rgb = parseHexColor(a.markColor);
    if (rgb) {
      root.style.setProperty(
        "--halo-mark-from",
        rgbCss(mixRgb(rgb, [255, 255, 255] as Rgb, 0.35)),
      );
      root.style.setProperty("--halo-mark-to", a.markColor);
    }
  } else {
    root.style.removeProperty("--halo-mark-from");
    root.style.removeProperty("--halo-mark-to");
  }
  // Claude-чтение (глобально): serif-ответы и inline-код как у Claude.
  // Классы исключают жёсткие темы — у Full Claude свои одноимённые тумблеры
  root.classList.toggle("serif-chat", (a.serifChat ?? false) && !a.fullClaude && !a.official);
  root.classList.toggle(
    "inline-code-claude",
    (a.inlineCodeClaude ?? false) && !a.fullClaude && !a.official,
  );
  root.style.fontSize = `${a.scale}%`;
  // sidebar-glass — Global-тумблер: в Full Claude не действует (контракт
  // «Сознательно вне каскада кастомизации», строчкой выше) — иначе глобальный
  // тумблер стеклил «монолитную» тему поверх её собственных настроек
  root.classList.toggle("sidebar-glass", a.sidebarGlass && !a.fullClaude);
  if (a.style === "claude") root.removeAttribute("data-style");
  else root.setAttribute("data-style", a.style);

  // Тема Official: монохромная палитра — отдельным тегом <style> в конце
  // head (см. officialCss). Инлайн на корне нельзя: зачистка
  // предпросмотных переменных в ThemeSection сносила её при каждом входе
  // в настройки. Официальная тема всегда тёмная; при выключении тег
  // снимается, обычные темы живут как раньше. С Full Claude взаимоисключима:
  // тег Official снимается, пока активна Full Claude
  root.classList.toggle("official", a.official && !a.fullClaude);
  root.classList.toggle(
    "official-mono-code",
    a.official && !a.fullClaude && a.officialMonoCode,
  );
  const officialTag = document.getElementById("halo-official");
  if (a.official && !a.fullClaude) {
    const tag = officialTag ?? document.createElement("style");
    tag.id = "halo-official";
    tag.textContent = officialCss(a.officialOled, a.officialContrast);
    // appendChild переносит существующий тег в конец head — после
    // halo-theme-styles / halo-custom-styles при любой их регенерации:
    // при равной специфичности побеждает последний в DOM
    document.head.appendChild(tag);
  } else {
    officialTag?.remove();
  }

  // Тема Full Claude: тот же паттерн переносимого тега (см. fullClaudeCss),
  // тег идёт ПОСЛЕ official — при гипотетическом включении обеих (профиль
  // с мусором) побеждает Full Claude. Применение темы = последний автор
  // палитры, поэтому тег пересобирается на каждое изменение appearance
  root.classList.toggle("full-claude", a.fullClaude);
  const fullClaudeTag = document.getElementById("halo-full-claude");
  if (a.fullClaude) {
    const tag = fullClaudeTag ?? document.createElement("style");
    tag.id = "halo-full-claude";
    tag.textContent = fullClaudeCss(a);
    document.head.appendChild(tag);
  } else {
    fullClaudeTag?.remove();
  }

  // Ambient: при Full Claude не действует ВООБЩЕ (ни глобальный тумблер,
  // ни сцены, ни канвас-слой — тот загейчен в App) — чистые монолитные
  // заливки. Звёздное небо из темы убрано по решению владельца
  const ambientOn = a.ambient && !a.fullClaude;
  root.classList.toggle("ambient", ambientOn);
  if (ambientOn && a.ambientScene !== "glow") {
    root.setAttribute("data-ambient-scene", a.ambientScene);
  } else {
    root.removeAttribute("data-ambient-scene");
  }
  root.style.setProperty("--ambient-alpha", String(a.ambientBrightness));
  root.setAttribute("data-ambient-render", a.ambientRender);
  // Motion/Reduced: класс глушит анимации CSS-правилами в index.css;
  // canvas-сцены AmbientLayer ставятся на паузу через App (prop paused)
  root.classList.toggle("motion-reduced", a.reduceMotion ?? false);
  root.style.setProperty("--motion-scale", String(a.motionScale ?? 1));
  // Акцент-градиент: класс на html, CSS в index.css
  root.classList.toggle("accent-gradient", a.accentGradient ?? false);
  // Шиммер-переливание приветствия: класс на html, CSS в index.css;
  // пара цветов (от → к) — var'ы, невалидное значение = токены темы
  root.classList.toggle("text-shimmer", a.textShimmer ?? false);
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const shimFrom = a.shimmerFrom && hexRe.test(a.shimmerFrom) ? a.shimmerFrom : "";
  const shimTo = a.shimmerTo && hexRe.test(a.shimmerTo) ? a.shimmerTo : "";
  if (shimFrom) root.style.setProperty("--shim-from", shimFrom);
  else root.style.removeProperty("--shim-from");
  if (shimTo) root.style.setProperty("--shim-to", shimTo);
  else root.style.removeProperty("--shim-to");

  // Пользовательский CSS — верхний слой «поверх тем»: теги тем re-append'ятся
  // в конец head (см. official/full-claude выше), а halo-custom-css создан
  // в main.tsx ДО рендера и оставался выше палитр — community-темы молча
  // проигрывали каскад data-style-палитрам (0-2-1). appendChild существующего
  // узла переносит его в конец head — порядок восстанавливается при каждом
  // applyAppearance. Против !important жёстких тем юзерский CSS выигрывает
  // только собственным !important — осознанный порядок слоёв
  const userCssTag = document.getElementById("halo-custom-css");
  if (userCssTag) document.head.appendChild(userCssTag);

  // Цвет рамки окна/мета theme-color: в index.html статично зашита тёмная —
  // светлые темы всегда получали тёмную рамку независимо от темы
  try {
    const bg = getComputedStyle(root).getPropertyValue("--halo-bg").trim();
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", bg || "#1f1e1d");
  } catch {
    // meta может отсутствовать — не критично
  }
}

export function appearanceTitleStyle(style: string, theme: Theme): { bg: string; panel: string; text: string } {
  // Мини-превью карточек стиля — из тех же данных, что и применяемая палитра:
  // превью всегда совпадает с тем, что увидит пользователь (и в светлой тоже).
  // Кастомный стиль в светлой теме / не найденный на этой машине → claude
  const p = resolvePalette(style, theme) ?? STYLE_PALETTES.claude[theme === "light" ? "light" : "dark"];
  return { bg: p.bg, panel: p.surface, text: p.text };
}
