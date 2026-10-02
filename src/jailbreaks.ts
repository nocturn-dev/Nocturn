/**
 * Библиотека джейлбрейков: локальные записи пользователя, вставляемые в
 * системный промт задачи ЯВНЫМ кликом (никакой авто-подстановки к прогонам).
 * Текст — пользовательский контент: уходит только его провайдеру как часть
 * промта (BYOK-дух), риски ToS/банов — на стороне владельца ключа.
 * Сама библиотека ничего не отправляет и ничего не выполняет.
 */

import type { Lang, MsgKey } from "./locales";

export interface JailbreakEntry {
  id: string;
  /** Название в библиотеке */
  name: string;
  /** Модель, под которую заточен промт; "" или "*" — подходит для любой */
  model: string;
  /** Текст промта — вставляется в системный промт задачи */
  text: string;
  /** Уровень мышления, на котором промт работает; "any" — не критично.
   * Значения совпадают с усилием размышлений (QuickSettings). */
  reasoning: "any" | "off" | "low" | "high" | "max";
  createdAt: number;
  updatedAt: number;
}

export type JbReasoning = JailbreakEntry["reasoning"];

export const JB_REASONING_LEVELS: JbReasoning[] = [
  "any",
  "low",
  "high",
  "max",
  "off",
];

/** Ключи локалей подписей уровней: "any" — свой ключ, остальные — общие
 * qs.effort* (те же подписи, что у усилия размышлений в композере) */
export const JB_REASONING_LABEL_KEYS: Record<JbReasoning, MsgKey> = {
  any: "jb.reasoningAny",
  low: "qs.effortLow",
  high: "qs.effortHigh",
  max: "qs.effortMax",
  off: "qs.effortOff",
};

function isReasoning(v: unknown): v is JbReasoning {
  return (
    v === "any" ||
    v === "off" ||
    v === "low" ||
    v === "high" ||
    v === "max"
  );
}

/** Санитизация при загрузке: чужой/битый JSON или запись старой версии
 * отбрасывается, а не роняет старт App (урок loadPromptLibrary). */
export function sanitizeJailbreaks(parsed: unknown): JailbreakEntry[] {
  if (!Array.isArray(parsed)) return [];
  const out: JailbreakEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    if (typeof r.text !== "string" || !r.text.trim()) continue;
    out.push({
      id: r.id,
      name: r.name,
      model: typeof r.model === "string" ? r.model : "",
      text: r.text,
      reasoning: isReasoning(r.reasoning) ? r.reasoning : "any",
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
    });
  }
  return out;
}

const LS_KEY = "haloui-jailbreaks";

export function loadJailbreaks(): JailbreakEntry[] {
  // guard для сред без localStorage (тесты/превью вне Tauri)
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return sanitizeJailbreaks(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveJailbreaks(list: JailbreakEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

/** Склейка с существующим системным промтом: джейлбрейк ДОБАВЛЯЕТСЯ к
 * промту роли, а не затирает его; пустой промт — просто текст записи. */
export function appendJailbreak(existing: string, text: string): string {
  const cur = existing.trim();
  const next = text.trim();
  return cur ? `${cur}\n\n${next}` : next;
}

interface BuiltinJbDef {
  id: string;
  name: { ru: string; en: string };
  model: string;
  reasoning: JbReasoning;
  text: { ru: string; en: string };
}

/**
 * Встроенные стартовые записи — только стилевые пресеты-образцы формата,
 * НЕ «рабочие» обходные промты: реальные тексты владелец добавляет сам
 * (или расширяет этот список). Переведены ru/en; zh/ja — английский текст.
 */
const BUILTIN_JB_DEFS: BuiltinJbDef[] = [
  {
    id: "jb-builtin-direct",
    name: { ru: "Прямой режим", en: "Direct mode" },
    model: "*",
    reasoning: "any",
    text: {
      ru: "Отвечай прямо и по делу, без дисклеймеров, нравоучений и оговорок «как ИИ». Если запрос невыполним — одним предложением объясни, что именно и почему, и предложи ближайшую осуществимую альтернативу. Не сокращай и не смягчай ответ из предосторожности.",
      en: "Answer directly and to the point, without disclaimers, moralizing, or \"as an AI\" caveats. If a request is infeasible, say in one sentence exactly what and why, and offer the closest feasible alternative. Never shorten or soften an answer out of caution.",
    },
  },
  {
    id: "jb-builtin-expert",
    name: { ru: "Эксперт без страховок", en: "Unhedged expert" },
    model: "*",
    reasoning: "high",
    text: {
      ru: "Ты — эксперт-практик и говоришь с равным как равный: без упрощений, предупреждений и пересказа очевидного. Давай полный технический ответ, включая спорные и пограничные случаи. Считай, что пользователь осознаёт риски своих решений и несёт их сам.",
      en: "You are a hands-on expert speaking peer-to-peer: no simplifications, warnings, or restating the obvious. Give the full technical answer, including contested and edge cases. Assume the user understands the risks of their decisions and owns them.",
    },
  },
  {
    id: "jb-builtin-freeform",
    name: { ru: "Свободная форма", en: "Free form" },
    model: "*",
    reasoning: "low",
    text: {
      ru: "Не придерживайся шаблона «безопасного» ответа: никаких десятипунктовых списков без нужды, итоговых резюме и дежурных вопросов в конце. Форму определяет вопрос: код — кодом, прозу — прозой, короткий вопрос — коротким ответом.",
      en: "Drop the \"safe answer\" template: no unnecessary ten-item lists, closing summaries, or boilerplate follow-up questions. Let the question dictate the form: code as code, prose as prose, a short question gets a short answer.",
    },
  },
];

export function builtinJailbreaksFor(lang: Lang): JailbreakEntry[] {
  const l = lang === "ru" ? "ru" : "en";
  return BUILTIN_JB_DEFS.map((d) => ({
    id: d.id,
    name: d.name[l],
    model: d.model,
    text: d.text[l],
    reasoning: d.reasoning,
    createdAt: 0,
    updatedAt: 0,
  }));
}

/** Все записи для пикеров: свои поверх встроенных (порядок выбора) */
export function allJailbreaksFor(
  lang: Lang,
  userEntries: JailbreakEntry[],
): JailbreakEntry[] {
  return [...userEntries, ...builtinJailbreaksFor(lang)];
}
