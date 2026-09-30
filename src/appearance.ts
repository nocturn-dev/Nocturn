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
   *  на неё не влияют. Пока заглушка — состояние хранится, ничего не применяет */
  fullClaude: boolean;
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

const LS_KEY = "haloui-appearance";

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
      motionScale: typeof p.motionScale === 'number' ? p.motionScale : 1,
      officialOled: p.officialOled ?? DEFAULT_APPEARANCE.officialOled,
      officialContrast: p.officialContrast ?? DEFAULT_APPEARANCE.officialContrast,
      officialMonoCode: p.officialMonoCode ?? DEFAULT_APPEARANCE.officialMonoCode,
      fullClaude: p.fullClaude ?? DEFAULT_APPEARANCE.fullClaude,
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
      termPalette: ["default", "one-dark", "gruvbox"].includes(p.termPalette as string)
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
  const deep = cssVarColor("--halo-deep", "#060606");
  const accent = cssVarColor("--halo-accent", "#d97757");
  const tint = sceneTint(deep, cssVarColor("--halo-bg", "#0a0a0a"), accent);
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
 * оставляя смесь чёрного/серого/синего/белого. Селектор :root.official
 * (0,2,0) выше data-style палитр (0,1,1) и html.light, а тег, переносимый
 * в конец head — последняя инстанция каскада.
 */
function officialCss(oled: boolean, contrast: boolean): string {
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

/** Применяем кастомизацию к <html>; theme нужен дляrem-масштаба (не конфликтует) */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
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
  // Акцент: при Official НЕ пишем инлайн — монохромный акцент (#ececec)
  // даёт тег halo-official (см. ниже); инлайн перебил бы его каскадно.
  // При выключении — возвращаем акцент пользователя инлайном
  if (a.official) {
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
  // Палитра подсветки кода + терминал: прозрачность/блюр (дефолты = как было)
  applyCodeTheme(a.codeTheme ?? "midnight");
  root.style.setProperty("--halo-term-opacity", String(a.termOpacity ?? 1));
  root.style.setProperty("--halo-density", String(a.density ?? 1));
  root.style.setProperty("--halo-content-width", `${a.contentWidth ?? 768}px`);
  // Фон код-блоков независимо от темы: инлайном только при переопределении,
  // иначе палитра стиля (data-style) продолжает управлять --halo-code-bg
  if (a.codeStyle === "light") {
    root.style.setProperty("--halo-code-bg", "#f0eee6");
    root.style.setProperty("--halo-code-text", "#2a2926");
  } else {
    root.style.removeProperty("--halo-code-bg");
    root.style.removeProperty("--halo-code-text");
  }
  // Вариант знака: NocturnMark переключается через CSS
  root.dataset.mark = a.markStyle;
  root.style.fontSize = `${a.scale}%`;
  root.classList.toggle("sidebar-glass", a.sidebarGlass);
  if (a.style === "claude") root.removeAttribute("data-style");
  else root.setAttribute("data-style", a.style);

  // Тема Official: монохромная палитра — отдельным тегом <style> в конце
  // head (см. officialCss). Инлайн на корне нельзя: зачистка
  // предпросмотных переменных в ThemeSection сносила её при каждом входе
  // в настройки. Официальная тема всегда тёмная; при выключении тег
  // снимается, обычные темы живут как раньше.
  root.classList.toggle("official", a.official);
  root.classList.toggle("official-mono-code", a.official && a.officialMonoCode);
  const officialTag = document.getElementById("halo-official");
  if (a.official) {
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
  root.classList.toggle("ambient", a.ambient);
  // Motion/Reduced: класс глушит анимации CSS-правилами в index.css;
  // canvas-сцены AmbientLayer ставятся на паузу через App (prop paused)
  root.classList.toggle("motion-reduced", a.reduceMotion ?? false);
  root.style.setProperty("--motion-scale", String(a.motionScale ?? 1));
  // Акцент-градиент: класс на html, CSS в index.css
  root.classList.toggle("accent-gradient", a.accentGradient ?? false);
  // Сцена: glow — базовое дыхание (body::before), остальные — слой в App.
  // Яркость слоя через переменную, CSS читает её
  if (a.ambient && a.ambientScene !== "glow") {
    root.setAttribute("data-ambient-scene", a.ambientScene);
  } else {
    root.removeAttribute("data-ambient-scene");
  }
  root.style.setProperty("--ambient-alpha", String(a.ambientBrightness));
  root.setAttribute("data-ambient-render", a.ambientRender);

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
