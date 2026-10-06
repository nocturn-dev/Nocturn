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

/** Темп анимаций (настройка «Скорость анимации», --motion-scale 0.7/1/1.4
 *  на html). JS-таймеры, синхронизированные с CSS-анимациями вида
 *  calc(Xs * var(--motion-scale)), обязаны умножаться на тот же множитель:
 *  фиксированный таймер рубил forwards-анимацию на середине (кейс полёта
 *  маскота). Общая точка для Nok и ask-ping — вторая копия «из головы»
 *  разъезжалась бы при смене формулы. Читается один раз на постановку
 *  таймера — это дёшево */
export function motionScale(): number {
  const v = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--motion-scale"),
  );
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Обёртка обновления состояния в View Transition (кроссфейд на композиторе).
 *  Фолбэки: нет VT-поддержки или reduceMotion — обычный апдейт */
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
  doc.startViewTransition(() => {
    flushSync(update);
  });
}
