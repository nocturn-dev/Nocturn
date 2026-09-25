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
 *
 * C20: дешёвые отсечения ДО построения LCS-матрицы (общий префикс/суффикс
 * вырезаются O(n), грубый wholeReplace — при почти непересекающихся
 * текстах). Раньше матрица (n+1)×(m+1) до ~9 МБ строилась всегда.
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

  // Отсечение 1: почти непересекающиеся тексты (создан/переписан файл) —
  // грубая замена вместо бессмысленной матрицы «похожих, но разных»
  const same = a.filter((x) => b.includes(x)).length; // O(n·m) строк, без аллокаций матрицы
  if (same < Math.min(a.length, b.length) * 0.1 && same < 32) {
    return wholeReplace(a, b);
  }

  // Отсечение 2: общий префикс/суффикс не нуждаются в LCS — вырезаем,
  // матрица строится только для «спорной» середины (часто в разы меньше)
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const out: DiffLine[] = [];
  // Префикс — контекст без LCS (k < pre <= a.length: элемент есть всегда)
  for (let k = 0; k < pre; k++) {
    const line = a[k];
    if (line === undefined) continue;
    out.push({ type: "ctx", text: line, oldNo: k + 1, newNo: k + 1 });
  }

  // LCS-таблица только для середины: lcs[i][j] = длина общей
  // подпоследовательности midA[i..], midB[j..]. Чтения за пределами
  // заполненной части — 0 по построению (таблица инициализирована нулями)
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Int32Array(rows * cols);
  const tableAt = (idx: number): number => table[idx] ?? 0;
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        midA[i] === midB[j]
          ? tableAt((i + 1) * cols + j + 1) + 1
          : Math.max(tableAt((i + 1) * cols + j), tableAt(i * cols + j + 1));
    }
  }

  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    const av = midA[i];
    const bv = midB[j];
    if (av === undefined || bv === undefined) break;
    if (av === bv) {
      out.push({
        type: "ctx",
        text: av,
        oldNo: pre + i + 1,
        newNo: pre + j + 1,
      });
      i++;
      j++;
    } else if (tableAt((i + 1) * cols + j) >= tableAt(i * cols + j + 1)) {
      out.push({ type: "del", text: av, oldNo: pre + i + 1 });
      i++;
    } else {
      out.push({ type: "add", text: bv, newNo: pre + j + 1 });
      j++;
    }
  }
  while (i < midA.length) {
    const av = midA[i];
    if (av === undefined) break;
    out.push({ type: "del", text: av, oldNo: pre + i + 1 });
    i++;
  }
  while (j < midB.length) {
    const bv = midB[j];
    if (bv === undefined) break;
    out.push({ type: "add", text: bv, newNo: pre + j + 1 });
    j++;
  }

  // Суффикс — контекст после середины (нумерация продолжает реальные строки)
  for (let k = 0; k < suf; k++) {
    const line = a[a.length - suf + k];
    if (line === undefined) continue;
    out.push({
      type: "ctx",
      text: line,
      oldNo: a.length - suf + k + 1,
      newNo: b.length - suf + k + 1,
    });
  }
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
