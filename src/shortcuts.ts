/**
 * Пользовательские горячие клавиши.
 *
 * Бинд хранится как строка-комбо "Ctrl+Shift+N": модификаторы + e.code
 * (физическая клавиша, работает на любой раскладке). Пустая строка =
 * действие без бинда. Матчинг — по e.code и флагам модификаторов.
 */

export const SHORTCUT_ACTIONS = [
  "new_task",
  "search",
  "open_settings",
  "toggle_theme",
  "toggle_agent",
  "toggle_terminal",
  "toggle_sidebar",
  "cycle_perm_mode",
  "toggle_fullscreen",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export type ShortcutBinds = Partial<Record<ShortcutAction, string>>;

/** Свой хоткей: комбинация → произвольная slash-команда (с аргументом) */
export interface CustomShortcut {
  id: string;
  combo: string;
  /** Например "/provider OpenRouter" или "/note идея" */
  command: string;
}

export const SHORTCUT_DEFAULTS: ShortcutBinds = {
  new_task: "Ctrl+N",
  search: "Ctrl+K",
  open_settings: "Ctrl+,",
  toggle_theme: "Ctrl+Shift+L",
  toggle_agent: "Ctrl+Shift+A",
  toggle_terminal: "Ctrl+`",
  toggle_sidebar: "Ctrl+B",
  cycle_perm_mode: "Ctrl+Shift+M",
  toggle_fullscreen: "F11",
};

/** Развёрнутые подписи действий (ключи локали) */
export const SHORTCUT_LABEL_KEYS: Record<ShortcutAction, string> = {
  new_task: "sc.newTask",
  search: "sc.search",
  open_settings: "sc.settings",
  toggle_theme: "sc.theme",
  toggle_agent: "sc.agent",
  toggle_terminal: "sc.terminal",
  toggle_sidebar: "sc.sidebar",
  cycle_perm_mode: "sc.permMode",
  toggle_fullscreen: "win.fullscreen",
};

export interface ComboParts {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

/** Разобрать строку "Ctrl+Shift+N" в части */
export function parseCombo(s: string): ComboParts | null {
  if (!s) return null;
  const parts = s.split("+").map((p) => p.trim());
  const code = parts[parts.length - 1];
  if (!code) return null;
  const has = (m: string) => parts.some((p) => p.toLowerCase() === m);
  return {
    ctrl: has("ctrl") || has("cmd") || has("meta"),
    shift: has("shift"),
    alt: has("alt"),
    code,
  };
}

/** Совпадает ли событие клавиатуры с комбо */
export function comboMatches(bind: string, e: KeyboardEvent): boolean {
  const p = parseCombo(bind);
  if (!p) return false;
  // Ctrl+, и Ctrl+` приходят как e.code "Comma"/"Backquote": храним коды
  const eventCode = e.code;
  const wantCode = p.code;
  const codeHit =
    eventCode === wantCode ||
    eventCode === `Key${wantCode}` ||
    eventCode === `Digit${wantCode}` ||
    CODE_ALIASES[eventCode] === wantCode;
  if (!codeHit) return false;
  const wantCtrl = p.ctrl;
  const wantShift = p.shift;
  const wantAlt = p.alt;
  // На macOS Ctrl = Meta, но проверяем оба флага — пользователь биндит «Ctrl»
  const ctrl = e.ctrlKey || e.metaKey;
  return (
    ctrl === wantCtrl && e.shiftKey === wantShift && e.altKey === wantAlt
  );
}

const CODE_ALIASES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Space: "Space",
};

/** Поймать комбо из события (для записи бинда в настройках) */
export function comboFromEvent(e: KeyboardEvent): string | null {
  // Только модификаторы — не считаем биндом
  if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) {
    return null;
  }
  const alias = CODE_ALIASES[e.code];
  let key: string | null = null;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (alias) key = alias;
  else if (e.code.startsWith("F") && /^F\d+$/.test(e.code)) key = e.code;
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/**
 * Комбо Quick Entry в формате плагина ("ctrl+alt+space"). Набор клавиш
 * ограничен буквами/цифрами/F-клавишами/Space — ровно то, что гарантированно
 * понимает парсер Shortcut на бекенде. Голая клавиша без модификаторов
 * запрещена: глобальный хоткей перехватывал бы её в каждом приложении.
 */
export function quickentryComboFromEvent(e: KeyboardEvent): string | null {
  if (
    ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)
  ) {
    return null;
  }
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code.toLowerCase();
  else if (e.code === "Space") key = "space";
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join("+");
}

/** "ctrl+alt+space" → "Ctrl+Alt+Space" (первая буква каждого токена) */
export function prettyQuickentryCombo(combo: string): string {
  return combo
    .split("+")
    .map((tok) => tok.charAt(0).toUpperCase() + tok.slice(1))
    .join("+");
}

