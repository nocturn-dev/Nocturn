import { useEffect, useState } from "react";

/**
 * Движение приложения: единые для всех точек входа.
 * Правила (по web.dev): анимируем только transform/opacity; вход —
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

let cachedMotionScale: number | null = null;
let scaleObserverInitialized = false;

function initScaleObserver(): void {
  if (scaleObserverInitialized || typeof document === "undefined") return;
  scaleObserverInitialized = true;
  try {
    const observer = new MutationObserver(() => {
      cachedMotionScale = null;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
  } catch {
    // В средах без MutationObserver остаёмся на прямом чтении
  }
}

/** Темп анимаций (настройка «Скорость анимации», --motion-scale 0.7/1/1.4
 *  на html). JS-таймеры, синхронизированные с CSS-анимациями вида
 *  calc(Xs * var(--motion-scale)), обязаны умножаться на тот же множитель:
 *  фиксированный таймер рубил forwards-анимацию на середине (кейс полёта
 *  маскота). Общая точка для Nok и ask-ping — вторая копия «из головы»
 *  разъезжалась бы при смене формулы. Значение кэшируется и инвалидируется
 *  по изменению атрибутов html-элемента, чтобы не дёргать getComputedStyle
 *  на каждый тик или кадр */
export function motionScale(): number {
  if (cachedMotionScale !== null) return cachedMotionScale;
  initScaleObserver();
  if (typeof document === "undefined") return 1;
  const v = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--motion-scale"),
  );
  const scale = Number.isFinite(v) && v > 0 ? v : 1;
  cachedMotionScale = scale;
  return scale;
}

/** Обёртка обновления состояния в View Transition (кроссфейд на композиторе).
 *  Фолбэки: нет VT-поддержки или reduceMotion — обычный апдейт.
 *  Колбэк вызывается напрямую без flushSync, чтобы избежать каскадных
 *  предупреждений React и сбоев батчинга при запуске из эффектов */
export function withViewTransition(update: () => void): void {
  // Два источника «тишины»: системный prefers-reduced-motion И ручной тумблер
  // «Motion: Reduced» (класс на html) — раньше ручной тумблер VT-морфы
  // настроек/поиска не глушил
  const reduce =
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false) ||
    document.documentElement.classList.contains("motion-reduced");
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  if (!doc.startViewTransition || reduce) {
    update();
    return;
  }
  doc.startViewTransition(update);
}
