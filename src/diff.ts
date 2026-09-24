/**
 * Построчный diff «до/после» для карточек шагов агента (M4.1).
 * LCS-подсветка: удалённые строки красным, добавленные зелёным, контекст серым.
 */

export type DiffLineType = "ctx" | "del" | "add";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Номер строки в старой версии (для del/ctx) */
  oldNo?: number;
  /** Номер строки в новой версии (для add/ctx) */
  newNo?: number;
}

/** Пределы: выше — LCS не считаем (матрица O(n·m) раздувается) */
const MAX_LINES = 1500;

/**
 * Построчный diff двух текстов.
 * Если вход слишком велик или стороны различаются более чем в 2 раза
 * по объёму без общих строк — возвращает грубый блок «удалено всё / добавлено всё».
 */
export function diffLines(before: string, after: string): DiffLine[] {
  // CRLF-файлы: без нормализации каждая строка сравнивается с хвостовым \r,
  // LCS не находит совпадений и весь файл красится как полная перезапись
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  // Убираем хвостовой пустой элемент от финального \n
  if (a.length > 1 && a[a.length - 1] === "") a.pop();
  if (b.length > 1 && b[b.length - 1] === "") b.pop();

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return wholeReplace(a, b);
  }

  // LCS-таблица: lcs[i][j] = длина общей подпоследовательности a[i..], b[j..]
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push({ type: "del", text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ type: "add", text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i], oldNo: ++i });
  while (j < b.length) out.push({ type: "add", text: b[j], newNo: ++j });
  return out;
}

/** Грубая замена целиком — для слишком больших файлов */
function wholeReplace(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  a.forEach((t, idx) => out.push({ type: "del", text: t, oldNo: idx + 1 }));
  b.forEach((t, idx) => out.push({ type: "add", text: t, newNo: idx + 1 }));
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Счёт добавленных/удалённых строк для бейджа «+N / −M» */
export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

/** Разворачиваем JSON-результат fs_write из Rust (или null для старых сообщений) */
export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
  before: string | null;
  after: string;
}

export function parseWriteResult(content: string): WriteResult | null {
  try {
    const v = JSON.parse(content) as Record<string, unknown>;
    if (typeof v.after !== "string") return null;
    return {
      path: typeof v.path === "string" ? v.path : "",
      bytes: typeof v.bytes === "number" ? v.bytes : 0,
      created: v.created === true,
      before: typeof v.before === "string" ? v.before : null,
      after: v.after,
    };
  } catch {
    return null;
  }
}

/** Аргументы инструментов — JSON; достаём человекочитаемую сводку для заголовка */
export function summarizeArguments(
  name: string,
  argumentsJson: string,
): string {
  try {
    const v = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (name === "shell_run") return String(v.command ?? argumentsJson);
    if (name === "fs_write" || name === "fs_read" || name === "fs_list")
      return String(v.path ?? "");
    return argumentsJson;
  } catch {
    return argumentsJson;
  }
}

/**
 * Канонизация пути для сравнения (M4.3, подсветка изменённых файлов):
 * слэши в один вид, без хвостовых разделителей, нижний регистр —
 * Windows-пути регистронезависимы, а модель может писать «/» вместо «\».
 */
export function normalizePath(p: string): string {
  return p
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}
