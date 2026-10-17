import { STORAGE_KEYS } from "./storageKeys";

const ID = "halo-custom-css";
const LS_KEY = STORAGE_KEYS.customCss;

/** Снять CSS-экранирование: \XXYYYY (hex, до 6 цифр с опциональным пробелом)
 *  и \c (буквальный символ). Без этого \2f \2f прятал от фильтра
 *  протокол-относительный //host — реальная схема всплывала только в браузере */
function unescapeCssToken(s: string): string {
  return s.replace(
    /\\([0-9a-fA-F]{1,6})(\r\n|[ \t\r\n\f])?|\\(.)/g,
    (_m, hex: string | undefined, _ws: string | undefined, ch: string | undefined) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        // Мусорные код-поинты (> U+10FFFF) валятся с исключением —
        // мусор во входном CSS не должен ронять санитайзер
        return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      }
      return ch ?? "";
    },
  );
}

/** Разобрать url()-токен с позиции открывающей скобки: вернуть индекс
 *  закрывающей «)» или -1 (битые кавычки/незакрытая скобка) */
function scanUrlClose(css: string, openParen: number): number {
  let i = openParen + 1;
  while (i < css.length && /\s/.test(css[i] ?? "")) i++;
  const q = css[i];
  if (q === '"' || q === "'") {
    i++;
    while (i < css.length) {
      const c = css[i] ?? "";
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) {
        i++;
        break;
      }
      i++;
    }
    while (i < css.length && /\s/.test(css[i] ?? "")) i++;
    return css[i] === ")" ? i : -1;
  }
  // Без кавычек: до первой неэкранированной «)»
  while (i < css.length) {
    const c = css[i] ?? "";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === ")") return i;
    i++;
  }
  return -1;
}

function urlAllowed(raw: string): boolean {
  const t = unescapeCssToken(raw).trim().toLowerCase();
  return (
    t === "" ||
    t.startsWith("data:") ||
    t.startsWith("asset:") ||
    t.startsWith("blob:") ||
    t.startsWith("http://asset.localhost") ||
    (t.startsWith("/") && !t.startsWith("//")) ||
    // Относительный путь без схемы резолвится в origin приложения
    // (свои ресурсы, внешнего хоста нет)
    (!t.includes(":") && !t.startsWith("//")) ||
    t.startsWith("#")
  );
}

/**
 * Лёгкий санитайзер: CSS «из интернета» (community-темы) не должен уметь
 * грузить внешние ресурсы — эксфильтрация через url()+attribute-селекторы
 * и трекинг-пиксели. CSP (img-src https:) сам по себе внешний url() не
 * режет, это второй слой. Позиционирование/анимации не трогаем: это
 * легитимная часть кастомизации, а фишинг-оверлей требует, чтобы CSS
 * вставил сам пользователь.
 */
export function sanitizeUserCss(css: string): string {
  // @import — целиком: внешние стили обходили бы и фильтр url().
  // Кавычки разбираются честно: жадный [^;]* обрывался на «;» внутри строки
  // ("a;b.css") и оставлял хвост, ломая следующее правило. {}/} не пересекаем —
  // @import без «;» перед блоком не должен съесть сам блок
  const out = css.replace(
    /@import(?:[^;"'{}]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*;?/gi,
    "",
  );
  // url(): построчный сканер вместо одного регэкспа — кавычки и экранирование
  // (\", \), hex-последовательности) разбираются честно. Раньше [^)'"]*
  // спотыкался об экранирование: неразобранный url() проходил нетронутым
  // (fail-open), и через незакрытую кавычку можно было пронести внешний
  // fetch мимо фильтра. Битый токен нейтрализуется целиком (fail-closed):
  // url-disabled( — неизвестная функция, движок отбрасывает всю декларацию
  let result = "";
  let last = 0;
  const re = /url\(/gi;
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const start = m.index;
    const close = scanUrlClose(out, start + 4 - 1);
    if (close === -1) {
      result += out.slice(last, start) + "url-disabled(";
      last = start + 4;
      continue;
    }
    const inner = out.slice(start + 4, close).trim();
    const raw = /^["']/.test(inner) ? inner.slice(1, -1) : inner;
    if (urlAllowed(raw)) result += out.slice(last, close + 1);
    else result += out.slice(last, start) + "none";
    last = close + 1;
  }
  result += out.slice(last);
  return result;
}

/**
 * Пользовательский CSS: textarea в «Кастомизации» -> <style> поверх тем.
 * Стилизует только локальный UI (логику сломать CSS не может), но вид
 * испортить можно — «Сбросить» возвращает как было. Санитайзер режет
 * внешние загрузки до попадания в DOM.
 */
export function applyUserCss(css: string): void {
  const el = document.getElementById(ID) as HTMLStyleElement | null;
  const safe = sanitizeUserCss(css);
  if (!safe.trim()) {
    el?.remove();
    return;
  }
  if (el) {
    el.textContent = safe;
    // Тег обязан оставаться последним автором палитры: теги тем
    // (halo-official/halo-full-claude и пр.) re-append'ятся при каждом
    // applyAppearance и уезжали в конец head — обновлённая тема молча
    // перебивала пользовательский CSS при равной специфичности
    document.head.appendChild(el);
  } else {
    const style = document.createElement("style");
    style.id = ID;
    style.textContent = safe;
    document.head.appendChild(style);
  }
}

export function readUserCss(): string {
  return localStorage.getItem(LS_KEY) ?? "";
}

export function writeUserCss(css: string): void {
  // В localStorage храним как написано (textarea показывает авторский текст),
  // в DOM уходит только санитизированная версия
  localStorage.setItem(LS_KEY, css);
  applyUserCss(css);
}
