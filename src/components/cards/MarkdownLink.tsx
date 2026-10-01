import type { ComponentPropsWithoutRef } from "react";
import { openExternal } from "../../api";

/**
 * Единственная ссылка для markdown-контента (ответы модели, заметки,
 * сравнение профилей): клик уходит в системный браузер через plugin opener.
 * Обычная навигация уводила вебвью приложения на произвольный URL (фишинг
 * в доверенном окне), а target="_blank" без обработчика new-window в wry —
 * deny на всех платформах (ссылки были мертвы). preventDefault на ВСЕ клики:
 * относительные href не имеют легитимного пути наружу — как и фишинговые.
 */
export function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (href) {
          // http/https/mailto opener'ом не фейлятся; catch гасит только
          // отказ ACL на экзотической схеме — канала показа ошибки тут нет
          openExternal(href).catch(() => {});
        }
      }}
    >
      {children}
    </a>
  );
}
