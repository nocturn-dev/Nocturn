import { convertFileSrc } from "@tauri-apps/api/core";
import { fontList } from "./api";
// Встроенные фирменные шрифты: URL'ы раздаёт vite (хеш в имени — кэш
// обновляется сам), лицензии OFL баз лежат рядом в src/assets/fonts/
import nocturnSansRegular from "./assets/fonts/NocturnSans-Regular.ttf";
import nocturnSansMedium from "./assets/fonts/NocturnSans-Medium.ttf";
import nocturnSansSemiBold from "./assets/fonts/NocturnSans-SemiBold.ttf";
import nocturnMonoRegular from "./assets/fonts/NocturnMono-Regular.ttf";
import nocturnMonoMedium from "./assets/fonts/NocturnMono-Medium.ttf";
import nocturnMonoSemiBold from "./assets/fonts/NocturnMono-SemiBold.ttf";

/**
 * Пользовательские шрифты: регистрации FontFace и курируемые пресеты.
 *
 * Стеки пресетов НЕ включают фолбэки — их дописывает applyAppearance
 * (--halo-font-ui/-mono дополняются системными стеками), пустой stack
 * = системный шрифт (var не переопределяется).
 */

export interface FontPreset {
  /** Подпись в дропдауне (имя шрифта — имена собственные, без перевода) */
  label: string;
  /** Семейство для font-family; "" — системный */
  stack: string;
}

export const UI_FONT_PRESETS: FontPreset[] = [
  // Фирменный шрифт — первым в списке: это дефолт приложения
  { label: "Nocturn Sans", stack: '"Nocturn Sans"' },
  { label: "Segoe UI Variable", stack: '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI"' },
  { label: "Segoe UI", stack: '"Segoe UI"' },
  // macOS: системный San Francisco — селектор шрифтов не должен врать
  // на двух платформах из трёх
  { label: "SF Pro (macOS)", stack: '"SF Pro Text", "SF Pro Display", -apple-system, system-ui' },
  { label: "System UI", stack: "system-ui" },
  { label: "Inter", stack: "Inter" },
  { label: "Georgia (serif)", stack: "Georgia, serif" },
  { label: "Verdana", stack: "Verdana" },
  // Шрифт для дислексии: работает, если установлен в системе; иначе стек
  // деградирует на системный (поведение пресетов и так такое — см. шапку)
  { label: "OpenDyslexic", stack: '"OpenDyslexic", "OpenDyslexic Regular"' },
];

export const MONO_FONT_PRESETS: FontPreset[] = [
  { label: "Nocturn Mono", stack: '"Nocturn Mono"' },
  { label: "Cascadia Code", stack: '"Cascadia Code"' },
  { label: "JetBrains Mono", stack: '"JetBrains Mono"' },
  { label: "Fira Code", stack: '"Fira Code"' },
  { label: "Iosevka", stack: '"Iosevka"' },
  { label: "Consolas", stack: "Consolas" },
  // macOS / Linux: системные и дистрибутивные моно-шрифты
  { label: "SF Mono / Menlo (macOS)", stack: '"SF Mono", Menlo, Monaco' },
  { label: "Ubuntu Mono / DejaVu (Linux)", stack: '"Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono"' },
];

const registered = new Set<string>();

/** Путь/URL в CSS-строке url("...") экранируется: кавычка или бэкслэш в
 *  имени файла ломала строку, в худшем случае — инъекция в FontFace */
const cssUrl = (u: string): string =>
  `url("${u.replace(/[\\"\n\r]/g, "\\$&")}")`;

/** Встроенные шрифты (Nocturn Sans/Mono, по три веса): регистрируются
 *  всегда, без гейта на Tauri — ассеты раздаёт vite и в dev, и в бандле.
 *  display: swap: файлы локальные и грузятся мгновенно, но swap гарантирует,
 *  что даже гипотетический лаг не даст невидимого текста */
const BUNDLED_FACES: { family: string; url: string; weight: number }[] = [
  { family: "Nocturn Sans", url: nocturnSansRegular, weight: 400 },
  { family: "Nocturn Sans", url: nocturnSansMedium, weight: 500 },
  { family: "Nocturn Sans", url: nocturnSansSemiBold, weight: 600 },
  { family: "Nocturn Mono", url: nocturnMonoRegular, weight: 400 },
  { family: "Nocturn Mono", url: nocturnMonoMedium, weight: 500 },
  { family: "Nocturn Mono", url: nocturnMonoSemiBold, weight: 600 },
];

export async function registerBundledFonts(): Promise<void> {
  for (const f of BUNDLED_FACES) {
    const key = `${f.family}:${f.weight}`;
    if (registered.has(key)) continue;
    try {
      const face = new FontFace(f.family, cssUrl(f.url), {
        weight: String(f.weight),
        display: "swap",
      });
      await face.load();
      document.fonts.add(face);
      registered.add(key);
    } catch {
      // битый ассет невозможен (собран тем же vite), но старт ронять
      // из-за шрифта нельзя — семейство молча откатится на системное
    }
  }
}

/** Зарегистрировать импортированные шрифты как FontFace — идемпотентно.
 *  Битый файл шрифта пропускается молча: применённое семейство тихо
 *  откатывается на системное (graceful degradation). */
export async function registerCustomFonts(): Promise<void> {
  // Встроенные — безусловно и первыми: дефолтный uiFont ссылается на них
  await registerBundledFonts();
  if (!("__TAURI_INTERNALS__" in window)) return;
  let fonts: Awaited<ReturnType<typeof fontList>> = [];
  try {
    fonts = await fontList();
  } catch {
    return;
  }
  for (const f of fonts) {
    if (registered.has(f.id)) continue;
    try {
      const face = new FontFace(f.family, cssUrl(convertFileSrc(f.path)), {
        display: "swap",
      });
      await face.load();
      document.fonts.add(face);
      registered.add(f.id);
    } catch {
      // файл удалён/повреждён после импорта — шрифт просто не заведётся
    }
  }
}
