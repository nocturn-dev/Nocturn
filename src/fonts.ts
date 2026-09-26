import { convertFileSrc } from "@tauri-apps/api/core";
import { fontList } from "./api";

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
  { label: "Segoe UI Variable", stack: '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI"' },
  { label: "Segoe UI", stack: '"Segoe UI"' },
  { label: "Inter", stack: "Inter" },
  { label: "Georgia (serif)", stack: "Georgia, serif" },
  { label: "Verdana", stack: "Verdana" },
  // Шрифт для дислексии: работает, если установлен в системе; иначе стек
  // деградирует на системный (поведение пресетов и так такое — см. шапку)
  { label: "OpenDyslexic", stack: '"OpenDyslexic", "OpenDyslexic Regular"' },
];

export const MONO_FONT_PRESETS: FontPreset[] = [
  { label: "Cascadia Code", stack: '"Cascadia Code"' },
  { label: "JetBrains Mono", stack: '"JetBrains Mono"' },
  { label: "Fira Code", stack: '"Fira Code"' },
  { label: "Iosevka", stack: "Iosevka" },
  { label: "Consolas", stack: "Consolas" },
];

const registered = new Set<string>();

/** Зарегистрировать импортированные шрифты как FontFace — идемпотентно.
 *  Битый файл шрифта пропускается молча: применённое семейство тихо
 *  откатывается на системное (graceful degradation). */
export async function registerCustomFonts(): Promise<void> {
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
      const face = new FontFace(f.family, `url("${convertFileSrc(f.path)}")`, {
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
