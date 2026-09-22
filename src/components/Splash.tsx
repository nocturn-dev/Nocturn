import { useEffect, useRef, useState } from "react";
import NocturnMark from "./NocturnMark";
import { useLang } from "../locales";

/** Тайминги сплэша: этап 1 → минимальная суммарная выдержка → фейд */
const STAGE1_MS = 900;
const MIN_TOTAL_MS = 2300;
const FADE_MS = 400;

/**
 * Splash в два этапа: лого на тёмном нейтральном фоне (этап 1, цвет совпадает
 * с фоном index.html — шва не видно) → лого на фоне текущей темы + подпись
 * (этап 2) → фейд в приложение. Скрывается, когда App сообщил готовность
 * (done) И прошло минимум MIN_TOTAL_MS с монтирования; после фейда зовёт
 * onGone — App размонтирует компонент.
 */
export default function Splash({
  done,
  onGone,
}: {
  done: boolean;
  onGone: () => void;
}) {
  const { t } = useLang();
  const [stage2, setStage2] = useState(false);
  const [fading, setFading] = useState(false);
  // Точка отсчёта минимальной выдержки — монтирование компонента
  const mountedAtRef = useRef(Date.now());
  // Актуальный колбэк через реф: fade-эффект не должен перезапускаться
  // при пересоздании стрелки в App
  const onGoneRef = useRef(onGone);
  useEffect(() => {
    onGoneRef.current = onGone;
  });

  // Этап 2: подтягиваем фон темы и подпись (плавный переход фона в style)
  useEffect(() => {
    const id = window.setTimeout(() => setStage2(true), STAGE1_MS);
    return () => window.clearTimeout(id);
  }, []);

  // Готовность приложения: выдерживаем минимум, затем фейд
  useEffect(() => {
    if (!done) return;
    const remain = Math.max(
      0,
      MIN_TOTAL_MS - (Date.now() - mountedAtRef.current),
    );
    const id = window.setTimeout(() => setFading(true), remain);
    return () => window.clearTimeout(id);
  }, [done]);

  // Фейд завершён — размонтирование на стороне App
  useEffect(() => {
    if (!fading) return;
    const id = window.setTimeout(() => onGoneRef.current(), FADE_MS);
    return () => window.clearTimeout(id);
  }, [fading]);

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center ${
        fading ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{
        background: stage2 ? "var(--halo-bg)" : "#1f1e1d",
        transition: `opacity ${FADE_MS}ms ease, background 300ms ease`,
      }}
    >
      {/* Пульс лого: единственная keyframes-анимация объявлена локально,
          чтобы не трогать общий index.css */}
      <style>{`@keyframes splash-pulse { 0%, 100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.06); opacity: 1; } }`}</style>
      <div style={{ animation: "splash-pulse 2.4s ease-in-out infinite" }}>
        <NocturnMark size={64} />
      </div>
      {/* Подпись — только на этапе 2, мягкое появление */}
      {stage2 && (
        <p className="anim-fade-up mt-5 text-xs tracking-wide text-halo-muted">
          {t("splash.tagline")}
        </p>
      )}
    </div>
  );
}
