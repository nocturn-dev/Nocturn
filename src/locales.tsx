import { STORAGE_KEYS } from "./storageKeys";
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

/** BCP-47 тег для Intl по языку UI. Раньше "ru-RU"/"en-US" были захардкожены
 *  в десятке мест — zh/ja видели русское или английское форматирование чисел
 *  и дат. zh обязан быть zh-CN (не zh): голый тег Intl трактует иначе */
export function localeTag(lang: Lang): string {
  switch (lang) {
    case "ru":
      return "ru-RU";
    case "ja":
      return "ja-JP";
    case "zh":
      return "zh-CN";
    default:
      return "en-US";
  }
}

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

// Промис загрузки на язык: параллельные вызовы (эффект провайдера + прямой
// вызов не-React кода) делят одну загрузку, а не стартуют вторую; сбой чанка
// не помечает язык загруженным — следующее переключение повторит попытку
const pendingLoads = new Map<Lang, Promise<boolean>>();

/** Подгрузить ленивый словарь (zh/ja); ru/en синхронны. true — словарь
 *  реально загрузился (нужен перерендер), false — уже был или не загрузился */
export function ensureLang(lang: Lang): Promise<boolean> {
  if (loadedLangs.has(lang)) return Promise.resolve(false);
  const pending = pendingLoads.get(lang);
  if (pending) return pending;
  const load = (async () => {
    try {
      if (lang === "zh") {
        lazyDict.zh = (await import("./locales/zh")).zh;
      } else if (lang === "ja") {
        lazyDict.ja = (await import("./locales/ja")).ja;
      } else {
        return false;
      }
      loadedLangs.add(lang);
      return true;
    } catch {
      // Чанк мог не долететь (сеть/сбой сборки) — фолбэк на en/ru в
      // translate уже работает, а язык остаётся незагруженным
      return false;
    } finally {
      pendingLoads.delete(lang);
    }
  })();
  pendingLoads.set(lang, load);
  return load;
}

export function translate(
  lang: Lang,
  key: MsgKey,
  vars?: Record<string, string | number>,
): string {
  const d = lang === "zh" ? lazyDict.zh : lang === "ja" ? lazyDict.ja : baseDict[lang];
  let s: string = d?.[key] ?? baseDict.en[key] ?? baseDict.ru[key];
  if (vars) {
    // Один проход по плейсхолдерам вместо replaceAll на каждую переменную:
    // длинные строки со многими {vars} не пересканируются N раз, а
    // незнакомый плейсхолдер честно остаётся в тексте
    s = s.replace(/\{(\w+)\}/g, (whole, k: string) => {
      const v = vars[k];
      return v === undefined ? whole : String(v);
    });
  }
  return s;
}

const ALL_LANGS: readonly Lang[] = ["ru", "en", "zh", "ja"];

function detectLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEYS.lang);
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

// Зеркало текущего языка вне React: не-React модули (api.ts) переводят
// свои ошибки через getLang() + translate. Стартовое значение читаю из
// хранилища синхронно: тосты/ошибки IPC возможны до монтирования провайдера,
// и они всегда были ru-текстом даже у en-пользователя. Гвард — localStorage
// недоступен в node-окружении тестов
let currentLang: Lang = "ru";
try {
  const saved = localStorage.getItem(STORAGE_KEYS.lang);
  if (saved && (ALL_LANGS as readonly string[]).includes(saved)) {
    currentLang = saved as Lang;
  }
} catch {
  // не-браузерное окружение — остаёмся на ru до монтирования провайдера
}
export function getLang(): Lang {
  return currentLang;
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detectLang);
  useEffect(() => {
    currentLang = lang;
  }, [lang]);
  const [dictTick, setDictTick] = useState(0);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.lang, lang);
  }, [lang]);
  // lang у <html> синхронно с локалью — иначе скринридеры и IME
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

/** Выбор из двуязычной пары ru/en (дескрипторы скиллов и ролей субагентов —
 *  данные, существующие в двух языках). zh/ja читают en; ru при пустой своей
 *  версии тоже откатывается на en, а не на пустую строку */
export function pickBilingual(
  d: { ru?: string; en?: string } | undefined,
  lang: Lang,
): string {
  if (!d) return "";
  return (lang === "ru" ? d.ru : undefined) ?? d.en ?? d.ru ?? "";
}

/** Хук перевода: t("key", {vars}) */
export function useLang(): { lang: Lang; t: TFn } {
  const { lang, dictTick } = useContext(LangContext);
  // Стабильная идентичность t: новая стрелка на каждый рендер ломала
  // все useMemo/useEffect с t в зависимостях — они перезапускались
  // на каждый рендер (т.е. на каждый токен стрима)
  const t = useCallback<TFn>(
    (key, vars) => translate(lang, key, vars),
    // dictTick не читается телом и потому «лишний» для линта — он здесь
    // именно ради смены идентичности: после подгрузки ленивого словаря
    // t обязан обновиться, иначе memo-потребители навсегда держат en-фолбэк
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, dictTick],
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
