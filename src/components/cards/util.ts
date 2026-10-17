import { localeTag, type Lang } from "../../locales";

export { localeTag };

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
