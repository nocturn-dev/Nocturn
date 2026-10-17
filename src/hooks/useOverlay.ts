import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Общий паттерн оверлеев (модалки, поповеры, меню, панели): стек открытых
 * слоёв + фокус-менеджмент.
 *
 * Зачем стек: каждый оверлей вешал свой window-keydown на Escape, и при
 * вложенных слоях (QR-зум поверх окна поддержки) один Escape закрывал оба
 * сразу. Закрывать имеет смысл только верхний слой — нижний пользователь
 * ещё видит и, возможно, не закончил с ним работать.
 *
 * Фокус: при открытии уходим с точки вызова внутрь оверлея (первый
 * доступный контрол или сам контейнер), при закрытии возвращаем на элемент,
 * который был в фокусе до открытия — иначе фокус падает на body, и
 * клавиатура «теряется» до следующего клика мышью.
 */

/** Идентификаторы открытых оверлеев; последний — верхний */
const stack: number[] = [];
let nextId = 1;

export interface UseOverlayArgs {
  open: boolean;
  onClose: () => void;
  /** Контейнер оверлея: из него ищется точка фокуса, его же закрывает Escape */
  containerRef?: RefObject<HTMLElement | null>;
  /**
   * Куда ставить фокус при открытии:
   *  — "first" (по умолчанию): первый доступный контрол внутри контейнера,
   *    если контролей нет — сам контейнер (тогда повесь на него tabIndex={-1});
   *  — "container": всегда контейнер (панели, где перевод фокуса на кнопку
   *    закрытия выглядит как неожиданный прыжок);
   *  — "none": не трогать фокус (контекстные меню, открытые правым кликом).
   */
  focusMode?: "first" | "container" | "none";
  /** Не закрывать по Escape (например, пока идёт необратимая операция) */
  escapeDisabled?: boolean;
}

/** role/aria-атрибуты контейнера; при другой роли (alertdialog, menu)
 *  переопредели role на месте — aria-modal остаётся верным */
export function useOverlay({
  open,
  onClose,
  containerRef,
  focusMode = "first",
  escapeDisabled,
}: UseOverlayArgs) {
  const idRef = useRef(0);
  // Колбэки и флаги — через реф: эффект не должен перезапускаться (и,
  // главное, терять слот стека) при пересоздании стрелок в родителе
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const disabledRef = useRef(escapeDisabled ?? false);
  disabledRef.current = escapeDisabled ?? false;

  useEffect(() => {
    if (!open) return;
    if (idRef.current === 0) idRef.current = nextId++;
    const id = idRef.current;

    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(id);

    const el = containerRef?.current ?? null;
    if (el && focusMode !== "none") {
      const target =
        focusMode === "first"
          ? (el.querySelector<HTMLElement>(
              'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ) ?? el)
          : el;
      target.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (disabledRef.current) return;
      if (stack[stack.length - 1] !== id) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      window.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    };
  }, [open, containerRef, focusMode]);

  return { role: "dialog", "aria-modal": true } as const;
}
