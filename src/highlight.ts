import hljs from "highlight.js/lib/common";

/**
 * Подсветка диффов (ряды Review, ZCode-стиль): построчный hljs над
 * common-набором языков — он уже в бандле через rehype-highlight, веса
 * не добавляет. Построчно, а не файлом: span'ы hljs перлились бы через
 * границы строк диффа; цена — многострочные строки/комменты раскрашиваются
 * по частям (осознанный трейдофф, у контекстных подсветок та же проблема
 * решается полным разбором файла).
 */

const EXT_LANG: Record<string, string> = {
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  json: "json",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  // hljs не знает toml/ps1 отдельными грамматиками в common: ini близок
  // к toml, ps1 оставляем без подсветки
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  lua: "lua",
  r: "r",
  pl: "perl",
  mk: "makefile",
};

/** Язык hljs по расширению файла; null — подсветки нет */
export function langFromPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const cache = new Map<string, string>();

/**
 * Подсветить ОДНУ строку; результат — HTML для dangerouslySetInnerHTML
 * (hljs сам экранирует исходник, внешних данных в выводе нет). Кеш по
 * (язык, текст): строки диффа перерисовываются на каждый флеш стрима
 * без изменения содержимого — без кеша это O(n) вызовов hljs за тик
 */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || !text) return escapeHtml(text);
  const key = `${lang}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: string;
  try {
    out = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    out = escapeHtml(text);
  }
  if (cache.size > 8000) cache.clear();
  cache.set(key, out);
  return out;
}
