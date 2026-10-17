/**
 * Плавающие уведомления: короткие события (чекпоинт, сохранение) —
 * появляются сверху справа (под шапкой окна), сами растворяются
 * через несколько секунд. Не interact-элементы, клики сквозь них проходят.
 */

export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: string;
  text: string;
  /** Тип события: цвет точки и подача скринридеру (см. Toast.tsx) */
  kind?: ToastKind;
  /** Exit-фаза: класс anim-fade-out до размонтирования (useToasts) */
  leaving?: boolean;
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    // aria-live на контейнере: контент появляется и исчезает без смены
    // фокуса, скринридер узнаёт о событиях только через live-регион
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-6 top-14 z-[var(--halo-z-toast)] flex flex-col items-end gap-2"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`${item.leaving ? "anim-fade-out" : "anim-fade"} flex items-center gap-2.5 rounded-xl border border-halo-line bg-halo-deep/95 px-4 py-2.5 shadow-xl backdrop-blur-sm`}
        >
          {/* Точка — по типу события: зелёная «всё хорошо» на любом тосте
              врала бы о сбоях записи и ошибках голоса */}
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              item.kind === "error"
                ? "bg-red-400"
                : item.kind === "success"
                  ? "bg-emerald-400"
                  : "bg-halo-accent"
            }`}
          />
          {/* item, не t: имя затеняло переводчика t и маскировало бы
              случайный вызов перевода в теле карточки */}
          <p className="text-xs text-halo-text">{item.text}</p>
        </div>
      ))}
    </div>
  );
}
