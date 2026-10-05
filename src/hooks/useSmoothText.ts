import { useEffect, useRef, useState } from "react";

/**
 * Плавная печать стримящегося текста — ЕДИНСТВЕННАЯ точка правды для
 * AssistantCard и RunCard (до 04.10 жило двумя копиями, фикс формулы
 * b4fbb14 попал только в AssistantCard, и копии разошлись).
 *
 * Показанный текст отстаёт от реального и догоняет rAF-циклом:
 * - тик 50 мс: ре-парсит markdown (react-markdown + hljs) — 100 мс давали
 *   рваную печать по 10 кадров; 50 — плавно и без O(n²) на разумных длинах;
 * - равномерная подача (фидбек владельца 04.10: «вылетает по предложениям,
 *   дёргано»): базовый темп 12 симв/тик (~240 зн/с), при долге темп растёт
 *   так, чтобы долг дренировался примерно за секунду (20 тиков) — скачков
 *   нет, отставание от быстрых моделей ≤ ~1 с;
 * - backlog <= 0 — rAF гасится: пока модель думает / идёт tool-шаг, цикл
 *   не молотит вхолостую 60 раз/сек (новый контент перезапускает эффект).
 */
export function useSmoothText(
  content: string,
  active: boolean,
  smooth: boolean,
  printSpeed: number,
): string {
  const target = content.length;
  // Догоняем только короткий хвост (иначе текст «исчезает и печатается заново»)
  const [shownLen, setShownLen] = useState(() =>
    active ? Math.max(0, target - 120) : target,
  );
  // Зеркало shownLen между перезапусками эффекта (каждый новый контент его
  // перезапускает): без него локальный счётчик сбрасывался на 120 символов назад
  const shownMirror = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !smooth) {
      shownMirror.current = target;
      setShownLen(target);
      return;
    }
    let raf = 0;
    let last = 0;
    let shown = shownMirror.current ?? Math.max(0, target - 120);
    const tick = (now: number) => {
      if (now - last >= 50) {
        last = now;
        const backlog = target - shown;
        if (backlog <= 0) return;
        const speed = Math.max(12, Math.ceil(backlog / 20)) * printSpeed;
        shown = Math.min(target, shown + Math.ceil(speed));
        shownMirror.current = shown;
        setShownLen(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, smooth, printSpeed, target]);
  return smooth && active ? content.slice(0, shownLen) : content;
}
