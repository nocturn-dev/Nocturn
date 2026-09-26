const ID = "halo-custom-css";
const LS_KEY = "haloui-custom-css";

/**
 * Лёгкий санитайзер: CSS «из интернета» (community-темы) не должен уметь
 * грузить внешние ресурсы — эксфильтрация через url()+attribute-селекторы
 * и трекинг-пиксели. CSP (img-src https:) сам по себе внешний url() не
 * режет, это второй слой. Позиционирование/анимации не трогаем: это
 * легитимная часть кастомизации, а фишинг-оверлей требует, чтобы CSS
 * вставил сам пользователь.
 */
export function sanitizeUserCss(css: string): string {
  // @import — целиком: внешние стили обходили бы и фильтр url()
  let out = css.replace(/@import[^;]*;?/gi, "");
  // url(<внешний хост>) → none. Разрешены: data:, asset:, blob:, фрагменты
  // и относительные пути; http://asset.localhost — форма asset-протокола
  // на Windows. Протокол-относительный «//host/…» начинается с «/» — не путать
  out = out.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (full, _q, target: string) => {
    const t = target.trim().toLowerCase();
    const allowed =
      t === "" ||
      t.startsWith("data:") ||
      t.startsWith("asset:") ||
      t.startsWith("blob:") ||
      t.startsWith("http://asset.localhost") ||
      (t.startsWith("/") && !t.startsWith("//")) ||
      // Относительный путь без схемы резолвится в origin приложения
      // (свои ресурсы, внешнего хоста нет)
      (!t.includes(":") && !t.startsWith("//")) ||
      t.startsWith("#");
    return allowed ? full : "none";
  });
  return out;
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
