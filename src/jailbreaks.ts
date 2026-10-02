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
  /** Год происхождения промта ("2024" | "2025-2026" | …) — решает владелец
   * библиотеки, насколько промту можно доверять; пусто = неизвестен */
  year?: string;
  /** Теги техник из датасетов ("no-limits;persona-dan") — индекс поиска */
  tags?: string;
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
      year: typeof r.year === "string" ? r.year : undefined,
      tags: typeof r.tags === "string" ? r.tags : undefined,
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
    });
  }
  return out;
}

const JB_WARN_KEY = "haloui-jb-warn-dontshow";

/** Предупреждение при применении джейлбрейка (решение владельца — «лишний
 * раз огородиться»): показывается при КАЖДОМ применении, пока пользователь
 * не попросил больше не показывать */
export function jbWarnSuppressed(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(JB_WARN_KEY) === "1";
}

export function suppressJbWarn(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(JB_WARN_KEY, "1");
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

// ---------- Умный поиск (чистые функции — тесты и два потребителя) ----------

export interface JbSearchOptions {
  /** Многословный запрос: каждое слово должно найтись в name/model/text/tags */
  query: string;
  /** Точный фильтр по модели ("" — все) */
  model: string;
  /** Точный фильтр по году ("" — все) */
  year: string;
  sort: "relevance" | "newest" | "name";
}

export interface JbFacet {
  value: string;
  count: number;
}

function haystack(e: JailbreakEntry): string {
  return `${e.name}\n${e.model}\n${e.text}\n${e.tags ?? ""}`.toLowerCase();
}

function relevance(e: JailbreakEntry, words: string[]): number {
  const name = e.name.toLowerCase();
  const model = e.model.toLowerCase();
  const text = e.text.toLowerCase();
  const tags = (e.tags ?? "").toLowerCase();
  let score = 0;
  for (const w of words) {
    // очко на каждое ПОЛЕ, не на слово: «no» в тексте и в теге — два очка
    if (name.includes(w)) score += 3;
    if (model.includes(w)) score += 2;
    if (text.includes(w)) score += 1;
    if (tags.includes(w)) score += 1;
  }
  return score;
}

/** Поиск + фильтры + сортировка. Модель/год — точные совпадения,
 * слова — AND по подстрокам (стемминга нет: ищут «DAN», а не словоформы).
 * Дженерик: расширенные записи (sourceLabel у живого поиска) не теряют
 * своих полей на выходе. */
export function searchJailbreaks<T extends JailbreakEntry>(
  all: T[],
  opts: JbSearchOptions,
): T[] {
  const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  let items = all;
  if (opts.model) items = items.filter((e) => e.model === opts.model);
  if (opts.year) items = items.filter((e) => (e.year ?? "") === opts.year);
  if (words.length > 0) {
    items = items.filter((e) => {
      const h = haystack(e);
      return words.every((w) => h.includes(w));
    });
  }
  if (opts.sort === "newest") {
    items = [...items].sort(
      (a, b) => (b.year ?? "").localeCompare(a.year ?? "") || b.updatedAt - a.updatedAt,
    );
  } else if (opts.sort === "name") {
    items = [...items].sort((a, b) => a.name.localeCompare(b.name));
  } else if (words.length > 0) {
    items = [...items].sort(
      (a, b) =>
        relevance(b, words) - relevance(a, words) || b.updatedAt - a.updatedAt,
    );
  }
  return items;
}

/** Фасеты моделей для фильтра: ""/"*" нормализуются в "any" */
export function jbModelFacets(all: JailbreakEntry[]): JbFacet[] {
  const counts = new Map<string, number>();
  for (const e of all) {
    const v = !e.model || e.model === "*" ? "any" : e.model;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Фасеты годов (непустые), новее — выше */
export function jbYearFacets(all: JailbreakEntry[]): JbFacet[] {
  const counts = new Map<string, number>();
  for (const e of all) {
    if (!e.year) continue;
    counts.set(e.year, (counts.get(e.year) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.value.localeCompare(a.value) || b.count - a.count);
}
