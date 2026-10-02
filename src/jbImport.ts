/**
 * Импорт записей в библиотеку джейлбрейков из файла/URL: разбор форматов
 * (CSV/JSON/TXT-MD) в черновики записей + дедуп по нормализованному хэшу.
 * Чистые функции — тесты без localStorage; гардалы чтения/сети живут в Rust
 * (importer.rs), здесь только разбор уже полученного текста.
 */

import type { JailbreakEntry } from "./jailbreaks";

export interface JbImportDraft {
  name: string;
  model: string;
  text: string;
  year?: string;
  tags?: string;
}

export interface JbParseResult {
  drafts: JbImportDraft[];
  /** "csv" | "json" | "text" — показывается в превью импорта */
  format: "csv" | "json" | "text";
  /** строк пропущено из-за потолка MAX_IMPORT_ROWS */
  truncated: boolean;
  /** строк отброшено разбором (пустой текст и т.п.) */
  skippedRows: number;
}

/** Потолок на один импорт: защиту localStorage держим на фронте — бэкенд
 * уже отдал текст с капом 32 МБ, но миллион строк сюда тащить нельзя */
export const MAX_IMPORT_ROWS = 5000;

/** Детерминированный не-крипто хэш для дедупа (djb2 ×2 коллизии маловероятны
 * на нормализованном тексте; криптостойкость тут не нужна — вход локальный) */
export function hashText(text: string): string {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = ((h2 << 5) + h2 + c) >>> 0;
  }
  return `${h1.toString(16)}-${h2.toString(16)}-${s.length.toString(16)}`;
}

/** Разбор CSV в матрицу строк: кавычки, запятые и переводы строк внутри
 * кавычек, CRLF, BOM. Точек оптимизации нет — файлы до 32 МБ парсятся раз. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // хвост без завершающего перевода строки — тоже строка
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

const TEXT_COLS = ["text", "prompt", "value", "body", "jailbreak", "content"];
const NAME_COLS = ["name", "title", "название"];
const MODEL_COLS = ["model", "model_target", "target", "provider", "модель"];
const YEAR_COLS = ["year", "год"];
const TAGS_COLS = ["tags", "tag", "техники", "labels"];

function pick(header: string[], cols: string[]): number {
  for (const c of cols) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === c);
    if (i >= 0) return i;
  }
  // неточный матч: заголовок содержит имя колонки (model_target и пр.)
  for (const c of cols) {
    const i = header.findIndex((h) => h.trim().toLowerCase().includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function draftFrom(obj: Record<string, unknown>): JbImportDraft | null {
  const text = [obj.text, obj.prompt, obj.value, obj.body, obj.content, obj.jailbreak]
    .find((v) => typeof v === "string" && v.trim())
    ?.toString()
    .trim();
  if (!text) return null;
  const name = [obj.name, obj.title, obj.header]
    .find((v) => typeof v === "string" && v.trim())?.toString().trim() ?? "";
  const model = [obj.model, obj.model_target, obj.provider]
    .find((v) => typeof v === "string")?.toString().trim() ?? "";
  const year = typeof obj.year === "string" && obj.year.trim() ? obj.year.trim() : undefined;
  const tags = typeof obj.tags === "string" && obj.tags.trim() ? obj.tags.trim() : undefined;
  return { name, model, text, year, tags };
}

/** Универсальный разбор: JSON-массив → CSV с заголовком (наш labeled-формат
 * и любые таблицы с колонкой текста) → весь файл одной записью (TXT/MD) */
export function parseJbImport(text: string, fileName: string): JbParseResult {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      const drafts: JbImportDraft[] = [];
      if (Array.isArray(arr)) {
        for (const item of arr.slice(0, MAX_IMPORT_ROWS)) {
          if (item && typeof item === "object") {
            const d = draftFrom(item as Record<string, unknown>);
            if (d) drafts.push(d);
          }
        }
      }
      return { drafts, format: "json", truncated: Array.isArray(arr) && arr.length > MAX_IMPORT_ROWS, skippedRows: 0 };
    } catch {
      // битый JSON — падаем в текстовый разбор ниже
    }
  }

  if (trimmed.includes("\n") || trimmed.includes(",")) {
    const rows = parseCsv(trimmed);
    if (rows.length > 1) {
      const header = rows[0] ?? [];
      // CSV-режим только при ТОЧНОМ совпадении заголовка: неточный матч
      // («My Prompt» в markdown) ловил обычные тексты как таблицы
      const exactTextCol = header.findIndex((h) =>
        TEXT_COLS.includes(h.trim().toLowerCase()),
      );
      if (exactTextCol >= 0) {
        const textCol = exactTextCol;
        const nameCol = pick(header, NAME_COLS);
        const modelCol = pick(header, MODEL_COLS);
        const yearCol = pick(header, YEAR_COLS);
        const tagsCol = pick(header, TAGS_COLS);
        const drafts: JbImportDraft[] = [];
        let skippedRows = 0;
        const dataRows = rows.slice(1);
        const truncated = dataRows.length > MAX_IMPORT_ROWS;
        for (const r of dataRows.slice(0, MAX_IMPORT_ROWS)) {
          const text = (r[textCol] ?? "").trim();
          if (!text) {
            skippedRows++;
            continue;
          }
          drafts.push({
            name: nameCol >= 0 ? (r[nameCol] ?? "").trim() : "",
            model: modelCol >= 0 ? (r[modelCol] ?? "").trim() : "",
            text,
            year: yearCol >= 0 ? (r[yearCol] ?? "").trim() || undefined : undefined,
            tags: tagsCol >= 0 ? (r[tagsCol] ?? "").trim() || undefined : undefined,
          });
        }
        return { drafts, format: "csv", truncated, skippedRows };
      }
    }
  }

  // TXT/MD: весь файл — одна запись; имя из первого заголовка или файла
  const heading = /^#\s+(.+)$/m.exec(trimmed);
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  return {
    drafts: [{ name: (heading?.[1] ?? base).trim(), model: "", text: trimmed }],
    format: "text",
    truncated: false,
    skippedRows: 0,
  };
}

export interface JbMergeResult {
  toAdd: JailbreakEntry[];
  /** дубликатов против библиотеки и внутри самого импорта */
  skippedDup: number;
}

/** Дедуп по нормализованному тексту: против уже имеющихся и внутри пачки */
export function dedupImports(
  existing: JailbreakEntry[],
  drafts: JbImportDraft[],
  now: number,
): JbMergeResult {
  const seen = new Set(existing.map((e) => hashText(e.text)));
  const toAdd: JailbreakEntry[] = [];
  let skippedDup = 0;
  for (const d of drafts) {
    const h = hashText(d.text);
    if (seen.has(h)) {
      skippedDup++;
      continue;
    }
    seen.add(h);
    toAdd.push({
      id: crypto.randomUUID(),
      name: d.name || d.text.slice(0, 60),
      model: d.model,
      text: d.text,
      reasoning: "any",
      year: d.year,
      tags: d.tags,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { toAdd, skippedDup };
}
