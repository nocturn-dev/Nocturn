import { createPortal } from "react-dom";
import { useEffect } from "react";

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
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);
  if (!src) return null;
  return createPortal(
    <div
      className="anim-fade fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-halo-scrim p-8"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt ?? ""}
        className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
