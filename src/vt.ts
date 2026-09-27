/**
 * M6.2б: мини-VT-эмулятор терминала для интерактивной консоли (M6-full).
 *
 * Покрывает то, что реально шлёт PowerShell через ConPTY:
 * - SGR: 16/256/truecolor, fg+bg, bold/dim/italic
 * - CSI: курсор (A/B/C/D/G/H/f/d), стирание (J/K), вставка/удаление строк (L/M)
 * - DSR (ESC[6n) и DA — ОБЯЗАТЕЛЬНЫЕ ответы: PSReadLine без ответа на
 *   запрос позиции курсора просто молчит (проверено тестом на Rust-стороне)
 * - OSC (заголовок окна) и прочий шум — пропускаем
 *
 * Модель: фиксированный экран rows×cols из ячеек, как настоящий терминал.
 */

export interface VtSpan {
  text: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  color?: string;
  bg?: string;
}

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  color?: string;
  bg?: string;
}

interface Cell {
  ch: string;
  style: Style;
}

const DEFAULT_STYLE: Style = {
  bold: false,
  dim: false,
  italic: false,
};

const PALETTE = [
  "#3a3633", "#d14b4b", "#7fbf5f", "#d9a04a",
  "#5f87d4", "#c07fd4", "#5fc7d4", "#d6d3cc",
  "#78716c", "#ef6b6b", "#98d982", "#eebe6e",
  "#7fa7ef", "#d498ef", "#7fd8ef", "#f5f3ee",
];

/** ANSI-палитры терминала (кастомизация): id -> 16 базовых цветов */
export const TERMINAL_PALETTES: Record<string, string[]> = {
  default: PALETTE,
  "one-dark": [
    "#282c34", "#e06c75", "#98c379", "#e5c07b",
    "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#3e4451", "#ef596f", "#89ca78", "#f2cc60",
    "#70bdf1", "#d29cf2", "#6cc7ca", "#ffffff",
  ],
  gruvbox: [
    "#282828", "#cc241d", "#98971a", "#d79921",
    "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f",
    "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ],
};

/**
 * Ширина символа в колонках терминала. Wide — не только астральные символы:
 * CJK-иероглифы, кана, хангыль и полноширинные формы живут в BMP и занимают
 * 2 колонки — раньше сетка разъезжалась на любом выводе с CJK (git/ls с
 * иероглифами, локализованные CLI). Упрощённая таблица East Asian
 * Wide/Fullwidth без висящих комбинаций.
 */
function charWidth(cp: number): number {
  if (cp > 0xffff) return 2; // астральные (эмодзи и пр.)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Ext-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical Forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) // Fullwidth signs
  ) {
    return 2;
  }
  return 1;
}

export class Vt {
  readonly cols: number;
  readonly rowsCount: number;
  rows: Cell[][] = [];
  row = 0;
  col = 0;
  cursorVisible = true;
  exited = false;
  private style: Style = { ...DEFAULT_STYLE };
  private response = "";
  /** Сохранённый основной экран на время альтернативного (?1049/?1047/?47) */
  private altSaved: { rows: Cell[][]; row: number; col: number } | null = null;

  /** 16 базовых ANSI-цветов (кастомизация); дефолт — фирменная палитра */
  private colors: string[];

  constructor(cols = 120, rows = 33, palette?: string[]) {
    this.cols = cols;
    this.rowsCount = rows;
    this.colors = palette && palette.length === 16 ? palette : PALETTE;
    for (let i = 0; i < rows; i++) this.rows.push(this.blankRow());
  }

  /** Достать базовый цвет: мусорный индекс из SGR даёт дефолт, не undefined */
  private paletteAt(i: number): string {
    return this.colors[i] ?? "#d6d3cc";
  }

  /** Цвет из 256-палитры (16 базовых + куб 6×6×6 + градации серого) */
  private color256(n: number): string {
    if (n >= 0 && n < 16) return this.paletteAt(n);
    if (n < 232) {
      const c = n - 16;
      const steps = [0, 95, 135, 175, 215, 255];
      const r = steps[Math.floor(c / 36)];
      const g = steps[Math.floor((c % 36) / 6)];
      const b = steps[c % 6];
      return `rgb(${r},${g},${b})`;
    }
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => ({
      ch: " ",
      style: DEFAULT_STYLE,
    }));
  }

  /** Ответ, который терминал должен отправить в PTY (DSR/DA) */
  takeResponse(): string | null {
    if (!this.response) return null;
    const r = this.response;
    this.response = "";
    return r;
  }

  feed(data: string) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        i = this.escape(data, i);
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
        i++;
        continue;
      }
      if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
        i++;
        continue;
      }
      if (ch === "\t") {
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        i++;
        continue;
      }
      if (ch === "\x07") {
        i++; // BEL — звонок, игнорируем
        continue;
      }
      // Печатаемый символ (с учётом суррогатных пар)
      const cp = data.codePointAt(i) ?? 32;
      const text = String.fromCodePoint(cp);
      this.putChar(text, charWidth(cp));
      // Индекс — в UTF-16-единицах: суррогатная пара занимает 2 позиции
      i += cp > 0xffff ? 2 : 1;
    }
  }

  private putChar(c: string, w: number) {
    if (this.col + w > this.cols) {
      // Мягкий перенос строки
      this.col = 0;
      this.lineFeed();
    }
    let row = this.rows[this.row];
    if (!row) {
      // Инвариант: строка курсора обязана существовать — восстанавливаем
      row = this.blankRow();
      this.rows[this.row] = row;
    }
    row[this.col] = { ch: c, style: { ...this.style } };
    if (w === 2 && this.col + 1 < this.cols) {
      row[this.col + 1] = { ch: "", style: { ...this.style } };
    }
    this.col += w;
  }

  /** LF: вниз; на нижней строке — прокрутка экрана */
  private lineFeed() {
    if (this.row >= this.rowsCount - 1) {
      this.rows.shift();
      this.rows.push(this.blankRow());
      this.row = this.rowsCount - 1;
    } else {
      this.row++;
    }
  }

  /** Разбор escape-последовательности с позиции i, возвращает новый индекс */
  private escape(data: string, i: number): number {
    const next = data[i + 1];
    if (next === "[") return this.csi(data, i + 2);
    if (next === "]") return this.osc(data, i + 2);
    if (next === "(" || next === ")") return i + 3; // выбор кодировки
    // Прочие одиночные (7, 8, =, >, M…) — пропускаем
    return i + 2;
  }

  /** CSI: от первого байта параметров до финального (@-~) */
  private csi(data: string, start: number): number {
    let i = start;
    let private_ = false;
    if (data[i] === "?") {
      private_ = true;
      i++;
    }
    let params = "";
    while (i < data.length) {
      const c = data[i];
      if (c === undefined) break; // обрыв посреди последовательности
      if (c >= "0" && c <= "9") {
        params += c;
        i++;
      } else if (c === ";" || c === ":") {
        params += ";";
        i++;
      } else if (c >= "@" && c <= "~") {
        i++;
        this.dispatchCsi(private_, params, c);
        return i;
      } else {
        // Некорректная последовательность — прерываем
        return i + 1;
      }
    }
    return i;
  }

  private dispatchCsi(private_: boolean, params: string, final: string) {
    const nums = params
      .split(";")
      .map((p) => (p === "" ? NaN : parseInt(p, 10)));
    const n = (idx: number, dflt: number): number => {
      const v = nums[idx];
      if (v === undefined || isNaN(v)) return dflt;
      // Потолок параметра, как в xterm: длинный цифровой параметр из
      // битой/malformed-последовательности раньше уезжал в циклы ниже
      return v > 65535 ? 65535 : v;
    };

    if (private_) {
      if (final === "h" && n(0, 0) === 25) this.cursorVisible = true;
      if (final === "l" && n(0, 0) === 25) this.cursorVisible = false;
      // Альтернативный экран (?1049/?1047/?47): TUI (vim/less/htop на Unix)
      // рисуют в нём — без свапа их остатки перемешивались с основным
      // экраном и не восстанавливались после выхода
      const mode = n(0, 0);
      if (final === "h" && (mode === 1049 || mode === 1047 || mode === 47)) {
        this.enterAltScreen();
      } else if (final === "l" && (mode === 1049 || mode === 1047 || mode === 47)) {
        this.exitAltScreen();
      }
      return;
    }

    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - Math.max(1, n(0, 1)));
        break;
      case "B":
        this.row = Math.min(this.rowsCount - 1, this.row + Math.max(1, n(0, 1)));
        break;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + Math.max(1, n(0, 1)));
        break;
      case "D":
        this.col = Math.max(0, this.col - Math.max(1, n(0, 1)));
        break;
      case "G":
        this.col = Math.min(this.cols - 1, Math.max(0, n(0, 1) - 1));
        break;
      case "d":
        this.row = Math.min(this.rowsCount - 1, Math.max(0, n(0, 1) - 1));
        break;
      case "H":
      case "f": {
        this.row = Math.min(this.rowsCount - 1, Math.max(0, n(0, 1) - 1));
        this.col = Math.min(this.cols - 1, Math.max(0, n(1, 1) - 1));
        break;
      }
      case "J":
        this.eraseDisplay(n(0, 0));
        break;
      case "K":
        this.eraseLine(n(0, 0));
        break;
      case "L":
        this.insertLines(Math.max(1, n(0, 1)));
        break;
      case "M":
        this.deleteLines(Math.max(1, n(0, 1)));
        break;
      case "m":
        this.sgr(nums);
        break;
      case "n": {
        // DSR: 6 — позиция курсора (обязательный ответ для PSReadLine)
        if (n(0, 0) === 6) {
          this.response += `\x1b[${this.row + 1};${this.col + 1}R`;
        }
        break;
      }
      case "c": {
        // DA: первичный и вторичный атрибуты устройства
        this.response += params.startsWith(">") ? "\x1b[>0;276;0c" : "\x1b[?1;0c";
        break;
      }
      default:
        break; // S/T, E, F, X и прочие — пока игнорируем
    }
  }

  private eraseDisplay(mode: number) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rowsCount; r++) {
        this.rows[r] = this.blankRow();
      }
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let r = 0; r < this.row; r++) {
        this.rows[r] = this.blankRow();
      }
    } else {
      for (let r = 0; r < this.rowsCount; r++) {
        this.rows[r] = this.blankRow();
      }
    }
  }

  private eraseLine(mode: number) {
    let row = this.rows[this.row];
    if (!row) {
      row = this.blankRow();
      this.rows[this.row] = row;
    }
    if (mode === 0) {
      for (let c = this.col; c < this.cols; c++) row[c] = { ch: " ", style: DEFAULT_STYLE };
    } else if (mode === 1) {
      for (let c = 0; c <= this.col && c < this.cols; c++) row[c] = { ch: " ", style: DEFAULT_STYLE };
    } else {
      this.rows[this.row] = this.blankRow();
    }
  }

  /** Вход в альтернативный экран: основной буфер и курсор сохраняются,
   *  экран очищается (упрощение ?1049: позиция курсора тоже в свапе) */
  private enterAltScreen() {
    if (this.altSaved) return; // уже в альте — повторный h игнорируем
    this.altSaved = { rows: this.rows, row: this.row, col: this.col };
    this.rows = Array.from({ length: this.rowsCount }, () => this.blankRow());
    this.row = 0;
    this.col = 0;
  }

  /** Выход из альтернативного экрана: восстановить основной буфер */
  private exitAltScreen() {
    const saved = this.altSaved;
    if (!saved) return;
    this.altSaved = null;
    this.rows = saved.rows;
    this.row = saved.row;
    this.col = saved.col;
  }

  private insertLines(n: number) {    // Кламп к размеру экрана: splice+pop в цикле с n от malformed-входа
    // (`\x1b[999999999L`) вешал UI-поток навсегда — реальных вставок
    // больше, чем строк на экране, не бывает
    const count = Math.min(n, this.rowsCount);
    for (let k = 0; k < count; k++) {
      this.rows.splice(this.row, 0, this.blankRow());
      this.rows.pop();
    }
  }

  private deleteLines(n: number) {
    this.rows.splice(this.row, n);
    while (this.rows.length < this.rowsCount) {
      this.rows.push(this.blankRow());
    }
  }

  /** SGR: 16/256/truecolor для fg (38) и bg (48) */
  private sgr(nums: number[]) {
    if (nums.length === 0 || nums[0] === undefined || isNaN(nums[0])) {
      this.style = { ...DEFAULT_STYLE };
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      const p = nums[i];
      if (p === undefined) continue;
      if (p === 0) {
        this.style = { ...DEFAULT_STYLE };
      } else if (p === 1) this.style.bold = true;
      else if (p === 2) this.style.dim = true;
      else if (p === 3) this.style.italic = true;
      else if (p === 22) { this.style.bold = false; this.style.dim = false; }
      else if (p === 23) this.style.italic = false;
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        this.style.color = this.paletteAt(p >= 90 ? p - 90 + 8 : p - 30);
      } else if (p === 39) this.style.color = undefined;
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        this.style.bg = this.paletteAt(p >= 100 ? p - 100 + 8 : p - 40);
      } else if (p === 49) this.style.bg = undefined;
      else if (p === 38 || p === 48) {
        const target = p === 38 ? "color" : "bg";
        // i-инкремент цикла (+1) учитываем в сдвиге: после 38;5;C следующая
        // итерация должна начаться с параметра C+1, после 38;2;r;g;b — с b+1
        if (nums[i + 1] === 5) {
          const c = this.color256(nums[i + 2] ?? 0);
          if (target === "color") this.style.color = c;
          else this.style.bg = c;
          i += 2;
        } else if (nums[i + 1] === 2) {
          const c = `rgb(${nums[i + 2] ?? 0},${nums[i + 3] ?? 0},${nums[i + 4] ?? 0})`;
          if (target === "color") this.style.color = c;
          else this.style.bg = c;
          i += 4;
        }
      }
    }
  }

  /** OSC (заголовок окна и пр.) — пропускаем до BEL или ESC\ */
  private osc(data: string, start: number): number {
    let i = start;
    while (i < data.length) {
      if (data[i] === "\x07") return i + 1;
      if (data[i] === "\x1b" && data[i + 1] === "\\") return i + 2;
      i++;
    }
    return i;
  }

  /** Экран в строки из спанов (слияние одинаковых стилей), с хвостовым курсором */
  render(): { spans: VtSpan[]; cursor: number }[] {
    return this.rows.map((cells, r) => {
      const spans: VtSpan[] = [];
      let cur: VtSpan | null = null;
      let col = 0;
      for (const cell of cells) {
        const text = cell.ch === "" ? "" : cell.ch;
        const last = cur;
        const sameStyle =
          last &&
          last.bold === cell.style.bold &&
          last.dim === cell.style.dim &&
          last.italic === cell.style.italic &&
          last.color === cell.style.color &&
          last.bg === cell.style.bg;
        if (sameStyle) {
          last.text += text;
        } else {
          cur = {
            text,
            bold: cell.style.bold,
            dim: cell.style.dim,
            italic: cell.style.italic,
            color: cell.style.color,
            bg: cell.style.bg,
          };
          spans.push(cur);
        }
        col++;
      }
      void col;
      const cursor = r === this.row ? this.col : -1;
      return { spans, cursor };
    });
  }
}
