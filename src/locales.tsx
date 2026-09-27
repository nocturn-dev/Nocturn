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

export type Lang = "ru" | "en" | "zh" | "ja";

export type MsgKey = keyof typeof ru;

type LangDict = Record<MsgKey, string>;

// ru и en синхронны: фолбэк-цепочка translate обязана работать до первого
// рендера. zh и ja — ленивые чанки (~120 КБ минифицированного бандла): до
// подгрузки translate честно откатывается на en/ru (сотни миллисекунд
// англоязычной вспышки для zh/ja-старта — дешевле, чем всегда таскать
// четыре словаря в памяти и в стартовом парсе)
const baseDict: { ru: LangDict; en: LangDict } = { ru, en };
const lazyDict: { zh?: LangDict; ja?: LangDict } = {};

const loadedLangs = new Set<Lang>(["ru", "en"]);

/** Подгрузить ленивый словарь (zh/ja); ru/en синхронны. true — словарь
 *  реально загрузился (нужен перерендер), false — уже был */
export async function ensureLang(lang: Lang): Promise<boolean> {
  if (loadedLangs.has(lang)) return false;
  loadedLangs.add(lang);
  if (lang === "zh") {
    lazyDict.zh = (await import("./locales/zh")).zh;
  } else if (lang === "ja") {
    lazyDict.ja = (await import("./locales/ja")).ja;
  }
  return true;
}

export function translate(
  lang: Lang,
  key: MsgKey,
  vars?: Record<string, string | number>,
): string {
  const d = lang === "zh" ? lazyDict.zh : lang === "ja" ? lazyDict.ja : baseDict[lang];
  let s: string = d?.[key] ?? baseDict.en[key] ?? baseDict.ru[key];
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
  /** Растёт после подгрузки ленивого словаря — сигнал перерендера.
   *  Контекст продавливает сквозь memo-карточки, так что zh/ja-строки
   *  доезжают до всех потребителей t() */
  dictTick: number;
}>({ lang: "ru", setLang: () => {}, dictTick: 0 });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [dictTick, setDictTick] = useState(0);
  useEffect(() => {
    localStorage.setItem("haloui-lang", lang);
  }, [lang]);
  // D20: lang у <html> синхронно с локалью — скринридеры и IME раньше
  // получали захардкоженный ru при любой выбранной языке
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  }, [lang]);
  // Ленивый словарь: после загрузки zh/ja — тик контекста, потребители
  // перерисовываются и t() отдаёт уже настоящие строки вместо en-фолбэка
  useEffect(() => {
    void ensureLang(lang).then((changed) => {
      if (changed) setDictTick((v) => v + 1);
    });
  }, [lang]);
  // Стабильный value: новый объект на каждый рендер провайдера
  // инвалидал бы всех потребителей контекста
  const value = useMemo(
    () => ({ lang, setLang, dictTick }),
    [lang, setLang, dictTick],
  );
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
