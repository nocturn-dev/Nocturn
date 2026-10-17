import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { useOverlay } from "../hooks/useOverlay";

/**
 * Просмотр картинки на весь экран (клик по вложению/результату).
 * Портал в body: карточки ленты держат contain:paint — fixed-оверлей
 * внутри карточки клипался бы её границами. Закрытие: клик мимо, Esc.
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt?: string;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const overlay = useOverlay({
    open: src !== null,
    onClose,
    containerRef: boxRef,
  });

  // Новая картинка — это новая попытка загрузки, старый сбой не показываем
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src) return null;
  return createPortal(
    <div
      ref={boxRef}
      tabIndex={-1}
      {...overlay}
      aria-label={alt || t("lightbox.title")}
      className="anim-fade fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-halo-scrim p-8 outline-none"
      onClick={onClose}
    >
      {failed ? (
        <p className="max-w-sm text-center text-sm text-halo-muted">
          {t("lightbox.loadError")}
        </p>
      ) : (
        <img
          src={src}
          alt={alt ?? ""}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>,
    document.body,
  );
}
