import type { Lang } from "../../locales";

/** BCP-47 тег для Intl по языку UI. D15: "ru-RU" был захардкожен в десятке
 *  мест — zh/ja видели русское форматирование чисел и дат */
export function localeTag(lang: Lang): string {
  switch (lang) {
    case "ru":
      return "ru-RU";
    case "ja":
      return "ja-JP";
    default:
      return "en-US";
  }
}

/** Разделение тысяч по локали UI */
export function fmtInt(n: number, lang: Lang): string {
  return n.toLocaleString(localeTag(lang));
}

/** Компактный счётчик: 1234 → 1,2k (ru) / 1.2k (en/zh/ja) */
export function fmtK(n: number, lang: Lang = "en"): string {
  if (n < 1000) return String(n);
  const fixed = (n / 1000).toFixed(1);
  const trimmed = /([.,])0$/.test(fixed) ? fixed.slice(0, -2) : fixed;
  const dec = lang === "ru" ? trimmed.replace(".", ",") : trimmed;
  return `${dec}k`;
}
