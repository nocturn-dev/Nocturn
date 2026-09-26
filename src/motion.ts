import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Движение приложения: единые для всех точек входа.
 * Правила (по M3/web.dev): анимируем только transform/opacity; вход —
 * медленнее и с торможением, выход — быстрее и с ускорением; всё глушится
 * reduceMotion и умножается пользовательским --motion-scale.
 */

/** Асимметричная задержка размонтирования: пока open=true элемент жив,
 *  при open=false — доигрывает exit-анимацию и только потом убирается */
export function useDelayedUnmount(open: boolean, ms: number): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, mounted, ms]);
  return mounted;
}

/** Длительность exit-анимации элемента (для useDelayedUnmount):
 *  читаем фактическую duration с учётом --motion-scale */
export function exitDuration(el: HTMLElement | null, fallback = 160): number {
  if (!el) return fallback;
  const d = getComputedStyle(el).animationDuration;
  const ms = parseFloat(d);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/** Обёртка обновления состояния в View Transition (кроссфейд на композиторе).
 *  Фолбэки: нет VT-поддержки или reduceMotion — обычный апдейт */
export function withViewTransition(update: () => void): void {
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  if (!doc.startViewTransition || reduce) {
    update();
    return;
  }
  doc.startViewTransition(() => {
    flushSync(update);
  });
}
