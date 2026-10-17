import { useEffect, useRef, useState } from "react";

/**
 * Плавная печать стримящегося текста — ЕДИНСТВЕННАЯ точка правды для
 * AssistantCard и RunCard (до 04.10 жило двумя копиями, фикс формулы
 * b4fbb14 попал только в AssistantCard, и копии разошлись).
 *
 * Показанный текст отстаёт от реального и догоняет покадрово:
 * - подача каждый кадр через dt: скорость задаётся в знаках/сек и не
 *   зависит от частоты кадров (50мс-тики на 60Гц давали рывок раз в
 *   3 кадра; на 120Гц-дисплеях рваный темп был заметен вдвойне);
 * - базовый темп 240 зн/с, при долге темп растёт до капа 2400 зн/с —
 *   долг в 10 с базового темпа уходит за ~1 с; раньше темп равнялся
 *   всему долгу без верхней границы, и разовый кадр после паузы окна
 *   выдавал сотни знаков за раз;
 * - кап dt 100мс: уснувшая вкладка/провал кадров не даёт рывка на
 *   несколько строк;
 * - состояние обновляется только когда есть долг: пока модель думает /
 *   идёт tool-шаг, цикл не делает лишних set-ов;
 * - актуальная длина живёт в ref: новый контент НЕ перезапускает
 *   rAF-цикл (раньше эффект перезапускался на каждый токен — last
 *   обнулялся, cancel/request гонялись, темп печати падал на частых
 *   дельтах быстрых моделей).
 */
const BASE_CPS = 240;
const MAX_CPS = 2400;

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
  // Зеркало shownLen между перезапусками эффекта (его триггерят только
  // active/smooth/printSpeed): без него локальный счётчик сбрасывался
  // на 120 символов назад
  const shownMirror = useRef<number | null>(null);
  // Запись в теле рендера, а не в эффекте: rAF-тик обязан увидеть новую
  // длину в тот же кадр — эффект отрабатывает после отрисовки, и хвост
  // стрима отставал бы на кадр
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    if (!active || !smooth) {
      shownMirror.current = targetRef.current;
      setShownLen(targetRef.current);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let shown = shownMirror.current ?? Math.max(0, targetRef.current - 120);
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const target = targetRef.current;
      const backlog = target - shown;
      if (backlog > 0) {
        const cps =
          Math.min(Math.max(BASE_CPS, backlog), MAX_CPS) * printSpeed;
        shown = Math.min(target, shown + Math.ceil((cps * dt) / 1000));
        shownMirror.current = shown;
        setShownLen(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, smooth, printSpeed]);
  return smooth && active ? content.slice(0, shownLen) : content;
}
