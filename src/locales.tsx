import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ru } from "./locales/ru";
import { en } from "./locales/en";
import { zh } from "./locales/zh";
import { ja } from "./locales/ja";

export type Lang = "ru" | "en" | "zh" | "ja";

const dict = { ru, en, zh, ja };

export type MsgKey = keyof typeof ru;

export function translate(
  lang: Lang,
  key: MsgKey,
  vars?: Record<string, string | number>,
): string {
  let s: string = dict[lang][key] ?? dict.en[key] ?? dict.ru[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

const ALL_LANGS: readonly Lang[] = ["ru", "en", "zh", "ja"];

function detectLang(): Lang {
  const saved = localStorage.getItem("haloui-lang");
  if (saved && (ALL_LANGS as readonly string[]).includes(saved)) {
    return saved as Lang;
  }
  const nav = (navigator.language || "").toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ja")) return "ja";
  // FIX: английский не определялся никогда — любой en-US/de-DE браузер
  // получал русский UI на первом запуске. Теперь en явно, ru — только
  // для русскоязычных, нейтральный дефолт — en.
  if (nav.startsWith("en")) return "en";
  if (nav.startsWith("ru")) return "ru";
  return "en";
}

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
}>({ lang: "ru", setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detectLang);
  useEffect(() => {
    localStorage.setItem("haloui-lang", lang);
  }, [lang]);
  // D20: lang у <html> синхронно с локалью — скринридеры и IME раньше
  // получали захардкоженный ru при любой выбранной языке
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  }, [lang]);
  // Стабильный value: новый объект на каждый рендер провайдера
  // инвалидал бы всех потребителей контекста
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  return (
    <LangContext.Provider value={value}>{children}</LangContext.Provider>
  );
}

export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** Хук перевода: t("key", {vars}) */
export function useLang(): { lang: Lang; t: TFn } {
  const { lang } = useContext(LangContext);
  // Стабильная идентичность t: новая стрелка на каждый рендер ломала
  // все useMemo/useEffect с t в зависимостях — они перезапускались
  // на каждый рендер (т.е. на каждый токен стрима)
  const t = useCallback<TFn>(
    (key, vars) => translate(lang, key, vars),
    [lang],
  );
  return { lang, t };
}

/** Доступ к текущему языку */
export function useLangState(): Lang {
  return useContext(LangContext).lang;
}

/** Доступ к setLang из настроек */
export function useLangSetter(): (l: Lang) => void {
  return useContext(LangContext).setLang;
}
