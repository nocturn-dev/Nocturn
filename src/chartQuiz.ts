/**
 * Парсеры fenced-блоков ```chart и ```quiz из ответа модели.
 * Ответ модели — недоверенный ввод: только локальный JSON.parse,
 * сети нет; всё сверх капов / невалидно → null (блок рисуется как код).
 *
 * Канон полей подобран по тому, что модели чаще всего эмитят сами
 * (question/options/answer/explanation, labels/series) — алиасы принимаются.
 */

const MAX_CODE_BYTES = 200 * 1024;
export const QUIZ_MAX_QUESTIONS = 30;
export const QUIZ_MAX_OPTIONS = 6;
export const QUIZ_MIN_OPTIONS = 2;
export const CHART_MAX_SERIES = 8;
export const CHART_MAX_POINTS = 200;

export type ChartType = "line" | "bar" | "pie";

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  /** Метки по x (категориальная ось); для pie — метки долей */
  labels: string[];
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** Предупреждение о структуре данных (например, круговая диаграмма с несколькими сериями) */
  warning?: "pie_multi_series";
}

export interface QuizQuestion {
  question: string;
  options: string[];
  /** Индексы правильных вариантов (1+); массив — мультиответ */
  answer: number[];
  explanation?: string;
  hint?: string;
}

export interface QuizSpec {
  title?: string;
  questions: QuizQuestion[];
}

/** djb2 + длина: стабильный короткий ключ прогресса по содержимому блока без коллизий */
export function blockHash(code: string): string {
  let h = 5381;
  const len = code.length;
  for (let i = 0; i < len; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}_${len.toString(36)}`;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function firstOf(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

/** Строки-опции бывают и объектами {label|text|value} (Kahoot-стиль) */
function asOptionText(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  const o = asObject(v);
  if (!o) return null;
  const text = firstOf(o, ["label", "text", "value", "option"]);
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

function parseNumberArray(v: unknown): (number | null)[] | null {
  if (!Array.isArray(v)) return null;
  const out: (number | null)[] = [];
  for (const item of v) {
    if (item === null) {
      out.push(null);
      continue;
    }
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function parseType(v: unknown): ChartType {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (t === "bar") return "bar";
  if (t === "pie" || t === "donut") return "pie";
  return "line";
}

/** Индексы ответа: число | "A"/"b" | массив тех же форм */
function parseAnswer(v: unknown, optionCount: number): number[] | null {
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) return null;
  const out: number[] = [];
  for (const item of list) {
    let idx: number;
    if (typeof item === "number") idx = item;
    else if (
      typeof item === "string" &&
      item.length === 1 &&
      /[a-zA-Zа-яА-ЯёЁ]/.test(item)
    ) {
      // Буквенные метки: латиница A=0, кириллица А=0 — модели любят оба.
      // Кириллица: А-Я (0x0410..0x042F), отдельная Ё (0x0401)
      const c = item.toUpperCase().charCodeAt(0);
      if (c === 0x0401) {
        idx = 6;
      } else if (c >= 0x0410 && c <= 0x042f) {
        idx = c > 0x0415 ? c - 0x0410 + 1 : c - 0x0410;
      } else {
        idx = c - 65;
      }
    } else {
      const n = Number(item);
      if (!Number.isInteger(n)) return null;
      idx = n;
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= optionCount) return null;
    if (!out.includes(idx)) out.push(idx);
  }
  return out.sort((a, b) => a - b);
}

export function parseChartBlock(code: string): ChartSpec | null {
  if (code.length > MAX_CODE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  const root = asObject(raw);
  if (!root) return null;

  const seriesRaw = firstOf(root, ["series", "data", "datasets", "values"]);
  const spec: ChartSpec = { type: parseType(root.type), labels: [], series: [] };
  spec.title = asString(root.title);
  spec.xLabel = asString(firstOf(root, ["xLabel", "xlabel", "xAxis", "xAxisTitle"]));
  spec.yLabel = asString(firstOf(root, ["yLabel", "ylabel", "yAxis", "yAxisTitle"]));

  const labelsRaw = firstOf(root, ["labels", "x", "categories", "xLabels"]);
  if (Array.isArray(labelsRaw)) {
    for (const item of labelsRaw) {
      const s = asOptionText(item);
      if (s === null) return null;
      spec.labels.push(s);
    }
    if (spec.labels.length > CHART_MAX_POINTS) return null;
  }

  // series: массив объектов {name, values|data|y} ИЛИ массив числовых
  // массивов (безымянные серии)
  const seriesList = Array.isArray(seriesRaw) ? seriesRaw : null;
  if (!seriesList || seriesList.length === 0 || seriesList.length > CHART_MAX_SERIES)
    return null;
  for (const item of seriesList) {
    const obj = asObject(item);
    const valuesRaw = obj
      ? firstOf(obj, ["values", "data", "y", "points"])
      : item;
    const values = parseNumberArray(valuesRaw);
    if (!values || values.length === 0 || values.length > CHART_MAX_POINTS)
      return null;
    const name = obj
      ? (asString(firstOf(obj, ["name", "label", "title"])) ?? `S${spec.series.length + 1}`)
      : `S${spec.series.length + 1}`;
    spec.series.push({ name, values });
  }

  // Метки опциональны для line/bar (x — числа), но для pie нужны каждой доле
  const firstValues = spec.series[0]?.values;
  if (spec.type === "pie") {
    if (spec.labels.length !== firstValues?.length) return null;
    if (spec.series.length > 1) {
      spec.warning = "pie_multi_series";
    }
  } else if (
    spec.labels.length > 0 &&
    spec.labels.length !== firstValues?.length
  ) {
    return null;
  }
  return spec;
}

export function parseQuizBlock(code: string): QuizSpec | null {
  if (code.length > MAX_CODE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  const root = asObject(raw);
  if (!root) return null;

  const questionsRaw = firstOf(root, ["questions", "quiz", "items"]);
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) return null;
  if (questionsRaw.length > QUIZ_MAX_QUESTIONS) return null;

  const questions: QuizQuestion[] = [];
  for (const item of questionsRaw) {
    const q = asObject(item);
    if (!q) return null;
    const text = asString(firstOf(q, ["question", "text", "prompt", "q"]));
    if (!text) return null;
    const optionsRaw = firstOf(q, ["options", "choices", "answers", "variants"]);
    if (!Array.isArray(optionsRaw)) return null;
    const options: string[] = [];
    for (const opt of optionsRaw) {
      const s = asOptionText(opt);
      if (s === null) return null;
      options.push(s);
    }
    if (
      options.length < QUIZ_MIN_OPTIONS ||
      options.length > QUIZ_MAX_OPTIONS
    )
      return null;
    const answerRaw = firstOf(q, ["answer", "correct", "correctAnswer", "answerIndex"]);
    const answer = parseAnswer(answerRaw, options.length);
    if (!answer) return null;
    questions.push({
      question: text,
      options,
      answer,
      explanation: asString(firstOf(q, ["explanation", "explain", "why"])),
      hint: asString(firstOf(q, ["hint", "hintText"])),
    });
  }
  return { title: asString(root.title), questions };
}
