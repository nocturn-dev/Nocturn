/**
 * Плавающие уведомления: короткие события (чекпоинт, сохранение) —
 * появляются сверху справа (под шапкой окна), сами растворяются
 * через несколько секунд. Не interact-элементы, клики сквозь них проходят.
 */

interface ToastItem {
  id: string;
  text: string;
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-6 top-14 z-[var(--halo-z-toast)] flex flex-col items-end gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className="anim-fade flex items-center gap-2.5 rounded-xl border border-halo-line bg-halo-deep/95 px-4 py-2.5 shadow-xl backdrop-blur-sm"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
          <p className="text-xs text-halo-text">{t.text}</p>
        </div>
      ))}
    </div>
  );
}
