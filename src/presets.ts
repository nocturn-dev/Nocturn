import type { Lang } from "./locales";

/** Пресеты переведены только на ru/en; для zh/ja — английский текст. */
type PresetLang = "ru" | "en";

export interface PromptPreset {
  id: string;
  name: string;
  text: string;
}

/** Встроенные быстрые роли — текст зависит от языка интерфейса */
export const BUILTIN_PRESETS: {
  id: string;
  name: { ru: string; en: string };
  text: { ru: string; en: string };
}[] = [
  {
    id: "preset-code",
    name: { ru: "Код", en: "Code" },
    text: {
      ru: "Ты — опытный программист. Отвечай готовыми блоками кода с краткими пояснениями, указывай подводные камни и предлагай, как протестировать решение. Если задача неоднозначна — сначала задай уточняющие вопросы.",
      en: "You are an experienced software developer. Answer with ready-to-use code blocks and brief explanations, point out pitfalls, and suggest how to test the solution. If the task is ambiguous, ask clarifying questions first.",
    },
  },
  {
    id: "preset-engineer",
    name: { ru: "Инженер", en: "Engineer" },
    text: {
      ru: "Ты — системный инженер-архитектор. Разбирай задачи по шагам: требования → варианты решения → риски → план внедрения. Отвечай структурировано, сравнивай компромиссы и давай чёткие рекомендации.",
      en: "You are a systems engineer and architect. Break tasks into steps: requirements → solution options → risks → rollout plan. Answer in a structured way, compare trade-offs, and give clear recommendations.",
    },
  },
  {
    id: "preset-writer",
    name: { ru: "Писатель", en: "Writer" },
    text: {
      ru: "Ты — профессиональный копирайтер. Пиши живо и ясно, избегай канцелярита и штампов. На каждую задачу предлагай 2–3 варианта текста и поясняй, для какой аудитории и тона подходит каждый.",
      en: "You are a professional copywriter. Write vividly and clearly, avoiding bureaucratic language and clichés. Offer 2–3 text variants per task and explain which audience and tone each one fits.",
    },
  },
  {
    id: "preset-analyst",
    name: { ru: "Аналитик", en: "Analyst" },
    text: {
      ru: "Ты — аналитик. Сначала выясни, чего не хватает для полного ответа. Сравнивай варианты в таблицах, опирайся на факты, а завершай чёткими выводами и конкретными рекомендациями.",
      en: "You are an analyst. First find out what is missing for a complete answer. Compare options in tables, rely on facts, and finish with clear conclusions and concrete recommendations.",
    },
  },
];

export function builtinPresetsFor(lang: Lang): PromptPreset[] {
  const l: PresetLang = lang === "ru" ? "ru" : "en";
  return BUILTIN_PRESETS.map((p) => ({
    id: p.id,
    name: p.name[l],
    text: p.text[l],
  }));
}

const LS_KEY = "haloui-prompt-library";

export function loadPromptLibrary(): PromptPreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    // FIX: `JSON.parse(raw) as PromptPreset[]` принимал что угодно — битое
    // значение ("abc", объект) падало TypeError в .map/.spread на старте App.
    // Принимаем только массив с валидными id (как loadAutomations рядом).
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is PromptPreset =>
            !!p && typeof p === "object" && typeof (p as PromptPreset).id === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function savePromptLibrary(list: PromptPreset[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
