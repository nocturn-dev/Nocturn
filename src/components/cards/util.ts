import { localeTag, type Lang } from "../../locales";

export { localeTag };

/** Разделение тысяч по локали UI */
export function fmtInt(n: number, lang: Lang): string {
  return n.toLocaleString(localeTag(lang));
}

/** Локализованный десятичный разделитель: toFixed всегда точка, ru — запятая */
function decSep(s: string, lang: Lang): string {
  return lang === "ru" ? s.replace(".", ",") : s;
}

/** Компактный счётчик: 1234 → 1,2k (ru) / 1.2k (en/zh/ja) */
export function fmtK(n: number, lang: Lang = "en"): string {
  if (n < 1000) return String(n);
  const fixed = (n / 1000).toFixed(1);
  const trimmed = /([.,])0$/.test(fixed) ? fixed.slice(0, -2) : fixed;
  return `${decSep(trimmed, lang)}k`;
}

/** Короткий формат токенов: 1234 → 1,2K (ru) / 1.2K · 365100000 → 365.1M.
 *  Единый источник для «Статистики», «Обзора» и кольца контекста — раньше
 *  формат жил копиями в двух секциях, а разделитель был точкой в любом UI */
export function fmtTokens(n: number, lang: Lang = "en"): string {
  if (n >= 1_000_000) return `${decSep((n / 1_000_000).toFixed(1), lang)}M`;
  if (n >= 1_000) return `${decSep((n / 1_000).toFixed(1), lang)}K`;
  return String(Math.round(n));
}
