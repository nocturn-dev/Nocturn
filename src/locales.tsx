import {
  createContext,
  useContext,
  useEffect,
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
  return "ru";
}

/** Фазы генерации — массивы, идут вне словаря */
export function thinkingPhases(lang: Lang): string[] {
  switch (lang) {
    case "ru":
      return ["Планирование", "Поиск информации", "Генерация кода", "Выполнение"];
    case "en":
      return ["Planning", "Researching", "Generating code", "Executing"];
    case "zh":
      return ["规划中", "正在研究", "生成代码", "执行工具"];
    case "ja":
      return ["計画中", "調査中", "コード生成", "ツール実行"];
  }
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
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      {children}
    </LangContext.Provider>
  );
}

export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** Хук перевода: t("key", {vars}) */
export function useLang(): { lang: Lang; t: TFn } {
  const { lang } = useContext(LangContext);
  const t: TFn = (key, vars) => translate(lang, key, vars);
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
