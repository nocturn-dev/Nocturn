/**
 * Разделение стримящегося markdown на стабильный префикс и хвост.
 *
 * Печать стрима тикает каждые 50 мс; без сплита react-markdown+hljs
 * переразбирают ВЕСЬ показанный текст на каждом тике (O(n) за тик, O(n²)
 * на ответ). Блоки до последней безопасной границы уже не меняются — их
 * парсим один раз за жизнь блока (StableMarkdown), ре-парсится только хвост.
 *
 * Безопасная граница — пустая строка ВНЕ открытого code-fence, после которой
 * не продолжается «рыхлый» список: элементы списка через пустую строку
 * образуют ОДИН список, разрез дал бы два <ul> с двойным отступом.
 * Прочие кросс-граничные конструкции (определения ссылок, индентированные
 * код-блоки с пустыми строками) на стриме дают краткую косметику и
 * самовосстанавливаются на финальном рендере — там split не применяется.
 */

interface Fence {
  char: string;
  len: number;
  closeRe: RegExp;
}

/** Открывающий фенс: ``` / ~~~ (до 3 пробелов отступа, маркер ≥3) */
function fenceOpen(line: string): Fence | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m || !m[1]) return null;
  const char = m[1][0] ?? "`";
  const len = m[1].length;
  const closeRe = new RegExp(`^ {0,3}[${char === "`" ? "`" : "~"}]{${len},}\\s*$`);
  return { char, len, closeRe };
}

/** Закрывающий фенс: проверка предкомпилированной регуляркой открывшего фенса */
function fenceClose(line: string, f: Fence): boolean {
  return f.closeRe.test(line);
}

/** Элемент списка в начале строки (отступ до 3 пробелов) */
function isListItem(line: string): boolean {
  return /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line);
}

export function splitMarkdownTail(md: string): { stable: string; tail: string } {
  const lines = md.split("\n");
  let inFence: Fence | null = null;
  // cut — индекс строки, с которой начинается хвост (-1 = резать некуда)
  let cut = -1;
  let prevBlank = false;
  // «последняя непустая строка была элементом списка» — для склейки рыхлых
  let prevListItem = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inFence !== null) {
      if (fenceClose(line, inFence)) inFence = null;
      // пустые строки ВНУТРИ фенса границ не создают
      prevBlank = false;
      continue;
    }
    const open = fenceOpen(line);
    if (open !== null) {
      inFence = open;
      prevBlank = false;
      prevListItem = false;
      continue;
    }
    const blank = line.trim() === "";
    if (prevBlank && !blank && (!prevListItem || !isListItem(line))) {
      cut = i;
    }
    if (!blank) prevListItem = isListItem(line);
    prevBlank = blank;
  }
  if (cut <= 0) return { stable: "", tail: md };
  return {
    stable: `${lines.slice(0, cut).join("\n")}\n`,
    tail: lines.slice(cut).join("\n"),
  };
}
