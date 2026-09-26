import type { DarkStyle } from "./appearance";
import type { Theme } from "./types";

/**
 * Палитры стилей темы — единый источник данных.
 *
 * Раньше палитры были статическими var-блоками в index.css (только тёмные);
 * теперь CSS генерируется из этих данных (buildThemeCss), поэтому:
 *  - светлые варианты стилей существуют наравне с тёмными (parity),
 *  - добавление стиля = одна запись здесь + ключ локали + (опц.) узор
 *    StylePattern, без правки CSS.
 *
 * «claude» — базовая палитра: её значения лежат в index.css (:root и
 * html.light), data-style для неё не выставляется. В данных она нужна для
 * превью (appearanceTitleStyle) и как эталон.
 */

export interface StylePalette {
  /** основная зона чата */
  bg: string;
  /** сайдбар, модалки */
  deep: string;
  /** карточки, поле ввода */
  surface: string;
  /** пузыри пользователя */
  raised: string;
  /** тонкие линии и рамки */
  line: string;
  /** основной текст */
  text: string;
  /** вторичный текст */
  muted: string;
  /** фон код-блоков (в светлых темах остаётся тёмным — как в базовой светлой) */
  codeBg: string;
  hover: string;
  hoverStrong: string;
}

export interface ThemeStyleDef {
  dark: StylePalette;
  light: StylePalette;
}

const HOVER_DARK = "rgba(255, 255, 255, 0.055)";
const HOVER_DARK_STRONG = "rgba(255, 255, 255, 0.085)";
const HOVER_LIGHT = "rgba(0, 0, 0, 0.05)";
const HOVER_LIGHT_STRONG = "rgba(0, 0, 0, 0.085)";

const dark = (
  bg: string,
  deep: string,
  surface: string,
  raised: string,
  line: string,
  text: string,
  muted: string,
  codeBg: string,
): StylePalette => ({
  bg,
  deep,
  surface,
  raised,
  line,
  text,
  muted,
  codeBg,
  hover: HOVER_DARK,
  hoverStrong: HOVER_DARK_STRONG,
});

const light = (
  bg: string,
  deep: string,
  surface: string,
  raised: string,
  line: string,
  text: string,
  muted: string,
  codeBg: string,
): StylePalette => ({
  bg,
  deep,
  surface,
  raised,
  line,
  text,
  muted,
  codeBg,
  hover: HOVER_LIGHT,
  hoverStrong: HOVER_LIGHT_STRONG,
});

export const STYLE_PALETTES: Record<DarkStyle, ThemeStyleDef> = {
  claude: {
    dark: dark(
      "#262624", "#1f1e1d", "#30302e", "#3a3936",
      "#3d3c38", "#e8e6dc", "#9b9890", "#1a1918",
    ),
    light: light(
      "#faf9f5", "#f2efe9", "#ffffff", "#ece9e0",
      "#e3dfd4", "#262524", "#7c786e", "#1a1918",
    ),
  },
  midnight: {
    dark: dark("#141416", "#101012", "#1e1e21", "#28282b", "#34343a", "#e6e4ea", "#94929a", "#0d0d0f"),
    // Светлая полночь: нейтральный холодный серый
    light: light("#f7f7f9", "#eef0f3", "#ffffff", "#e7e9ee", "#d9dce3", "#232227", "#76747e", "#16161a"),
  },
  sepia: {
    dark: dark("#2b2620", "#241f1a", "#332d26", "#3d362e", "#474036", "#ece3d2", "#a89a86", "#1c1813"),
    // Светлая сепия: тёплая бумага
    light: light("#f8f3ea", "#f0e9dc", "#fffcf5", "#ece2d2", "#e0d4c0", "#2b241a", "#8a7a63", "#1c1813"),
  },
  abyss: {
    dark: dark("#0c1616", "#091012", "#122020", "#182b2a", "#223a38", "#dcebe6", "#7fa39b", "#0a1312"),
    // Светлый «Чёрное море»: бледный морской
    light: light("#eef5f4", "#e2edec", "#fbffff", "#dcebe9", "#cfdedb", "#1a2b29", "#5f837c", "#0a1312"),
  },
  storm: {
    dark: dark("#10141c", "#0c0f16", "#181d27", "#202633", "#2b3342", "#e2e7f0", "#8d97ab", "#0b0e14"),
    light: light("#eff2f7", "#e4e9f0", "#ffffff", "#dde3ec", "#cdd5e1", "#1e2430", "#6d7789", "#0b0e14"),
  },
  dusk: {
    dark: dark("#16121f", "#110e18", "#1f1a2b", "#292337", "#352d46", "#e9e4f2", "#9b91ad", "#120e1a"),
    light: light("#f3f0f8", "#eae5f2", "#ffffff", "#e4def0", "#d8d0e6", "#272133", "#7c7390", "#120e1a"),
  },
  forest: {
    dark: dark("#101613", "#0c110e", "#182019", "#202a21", "#2c382c", "#e4ece2", "#93a494", "#0b100c"),
    light: light("#eff4ee", "#e3ece1", "#fdfffc", "#dde8db", "#ccdbc9", "#1d2a1c", "#6f8070", "#0b100c"),
  },
  rosewood: {
    dark: dark("#1a1214", "#140d0f", "#241a1d", "#2f2225", "#3d2c30", "#f0e6e4", "#a89395", "#130c0e"),
    light: light("#f8f1f1", "#f0e5e6", "#fffdfd", "#eddfdf", "#e2cfcf", "#2c1e20", "#96797c", "#130c0e"),
  },
  ocean: {
    dark: dark("#0c151d", "#091017", "#122230", "#182c3d", "#22394d", "#dceaf2", "#7fa0b3", "#0a1219"),
    light: light("#eef4f8", "#e1ecf2", "#fbfeff", "#dbe9f0", "#ccdde7", "#18242c", "#5f7d8f", "#0a1219"),
  },
  amethyst: {
    dark: dark("#151022", "#100c1a", "#1f1833", "#292144", "#362c58", "#ebe5f7", "#a294c4", "#110d1c"),
    light: light("#f4f0f9", "#ebe4f4", "#fefdff", "#e6def2", "#dad0ea", "#251d38", "#8174a3", "#110d1c"),
  },
  espresso: {
    dark: dark("#1b1410", "#140f0c", "#271d16", "#32261d", "#403024", "#f0e7de", "#ab9884", "#150f0b"),
    light: light("#f7f2ec", "#efe7de", "#fffbf7", "#eadfd2", "#ded0bf", "#2a2018", "#8d7b66", "#150f0b"),
  },
  carbon: {
    dark: dark("#171717", "#121212", "#1f1f1f", "#292929", "#363636", "#eaeaea", "#9a9a9a", "#0e0e0e"),
    light: light("#f6f6f6", "#ececec", "#ffffff", "#e4e4e4", "#d6d6d6", "#232323", "#7a7a7a", "#0e0e0e"),
  },
};

/** Все стили кроме базового claude получают data-style и сгенерированный CSS */
export const NON_BASE_STYLES: DarkStyle[] = (
  Object.keys(STYLE_PALETTES) as DarkStyle[]
).filter((id) => id !== "claude");

const paletteVars = (p: StylePalette): string =>
  [
    `--halo-bg: ${p.bg}`,
    `--halo-deep: ${p.deep}`,
    `--halo-surface: ${p.surface}`,
    `--halo-raised: ${p.raised}`,
    `--halo-line: ${p.line}`,
    `--halo-text: ${p.text}`,
    `--halo-muted: ${p.muted}`,
    `--halo-code-bg: ${p.codeBg}`,
    `--halo-hover: ${p.hover}`,
    `--halo-hover-strong: ${p.hoverStrong}`,
  ].join("; ");

/**
 * CSS для всех не-базовых стилей: тёмный вариант + светлый вариант.
 * Светлые правила используют html.light[data-style] — более специфичный
 * селектор, и идут после тёмных. Инжектируется один раз (см. applyAppearance).
 */
export function buildThemeCss(): string {
  const rules: string[] = [];
  for (const id of NON_BASE_STYLES) {
    const { dark: d, light: l } = STYLE_PALETTES[id];
    rules.push(`html[data-style="${id}"]:not(.light) { ${paletteVars(d)}; }`);
    rules.push(`html.light[data-style="${id}"] { ${paletteVars(l)}; }`);
  }
  return rules.join("\n");
}

// ---------- Конструктор собственных тёмных стилей (идея №3) ----------
// Только тёмная палитра: в светлой теме кастомный стиль честно деградирует
// до светлой базы claude (data-style висит без правил, работают var-ы
// html.light). Шеринг definition через файл темы — отложен (см. PLAN.md).

export type CustomStyleId = `custom-${string}`;

export interface CustomStyleDef {
  id: CustomStyleId;
  name: string;
  dark: StylePalette;
}

const CUSTOM_LS_KEY = "haloui-custom-styles";
const CUSTOM_ID_RE = /^custom-[0-9a-f]{8}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Редактируемые конструктором поля палитры; hover-пара автогенерируется */
export const CUSTOM_FIELDS = [
  "bg",
  "deep",
  "surface",
  "raised",
  "line",
  "text",
  "muted",
  "codeBg",
] as const;

export const isCustomStyleId = (id: string): boolean => id.startsWith("custom-");

/** Валидация hex-цвета конструктора (#rrggbb) */
export const isValidHex = (v: string): boolean => HEX_RE.test(v);

/** CSS-имена переменных для полей палитры (драфт-превью инлайном на html) */
export const PALETTE_VAR_NAMES: Record<keyof StylePalette, string> = {
  bg: "--halo-bg",
  deep: "--halo-deep",
  surface: "--halo-surface",
  raised: "--halo-raised",
  line: "--halo-line",
  text: "--halo-text",
  muted: "--halo-muted",
  codeBg: "--halo-code-bg",
  hover: "--halo-hover",
  hoverStrong: "--halo-hover-strong",
};

/** Санитизация записи с диска: битые выкидываем, частичные чиним */
function sanitizeCustom(raw: unknown): CustomStyleDef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !CUSTOM_ID_RE.test(r.id)) return null;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  const d = (typeof r.dark === "object" && r.dark !== null ? r.dark : {}) as Record<string, unknown>;
  const dark = {} as StylePalette;
  for (const k of CUSTOM_FIELDS) {
    const v = d[k];
    if (typeof v !== "string" || !HEX_RE.test(v)) return null;
    dark[k] = v.toLowerCase();
  }
  dark.hover = HOVER_DARK;
  dark.hoverStrong = HOVER_DARK_STRONG;
  return { id: r.id as CustomStyleId, name: r.name.trim().slice(0, 40), dark };
}

export function loadCustomStyles(): CustomStyleDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeCustom).filter((s): s is CustomStyleDef => s !== null);
  } catch {
    return [];
  }
}

export function saveCustomStyles(list: CustomStyleDef[]): void {
  localStorage.setItem(CUSTOM_LS_KEY, JSON.stringify(list));
  applyCustomStyles(list);
}

/** Единая точка резолва палитры: builtin → STYLE_PALETTES, custom → localStorage.
 *  null = палитры нет (на этой машине) — потребитель откатывается на claude. */
export function resolvePalette(styleId: string, theme: Theme): StylePalette | null {
  const builtin = STYLE_PALETTES[styleId as DarkStyle];
  if (builtin) return theme === "light" ? builtin.light : builtin.dark;
  if (!isCustomStyleId(styleId) || theme === "light") return null;
  return loadCustomStyles().find((s) => s.id === styleId)?.dark ?? null;
}

/** Создать черновик кастомного стиля (префилл из базовой палитры) */
export function newCustomStyle(name: string, base: StylePalette): CustomStyleDef {
  const b = crypto.getRandomValues(new Uint8Array(4));
  const id: CustomStyleId = `custom-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
  return {
    id,
    name: name.trim().slice(0, 40),
    dark: { ...base, hover: HOVER_DARK, hoverStrong: HOVER_DARK_STRONG },
  };
}

/** Инжект/обновление CSS кастомных стилей. Отдельный тег: инжект builtin-палитр
 *  в applyAppearance одноразовый, а кастомные создаются/удаляются на ходу */
export function applyCustomStyles(list?: CustomStyleDef[]): void {
  const styles = list ?? loadCustomStyles();
  let el = document.getElementById("halo-custom-styles") as HTMLStyleElement | null;
  if (styles.length === 0) {
    el?.remove();
    return;
  }
  const css = styles
    .map((s) => `html[data-style="${s.id}"]:not(.light) { ${paletteVars(s.dark)}; }`)
    .join("\n");
  if (!el) {
    el = document.createElement("style");
    el.id = "halo-custom-styles";
    document.head.appendChild(el);
  }
  el.textContent = css;
}
