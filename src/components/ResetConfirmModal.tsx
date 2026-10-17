import { useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { useDelayedUnmount } from "../motion";
import { useOverlay } from "../hooks/useOverlay";

/** Сколько секунд кнопка остаётся взведённой: без сброса «второй лишний
 *  клик через минуту» стирает данные так же легко, как и без подтверждения */
const ARM_RESET_MS = 8000;

/**
 * Подтверждение «Clear All Data» (запрос приходит из трея).
 * Двухшаговое, как удаление в контекст-меню: первый клик только armит кнопку.
 * onConfirm стирает все данные и перезапускает приложение — отмены после него нет.
 */
export default function ResetConfirmModal({
  open,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const [armed, setArmed] = useState(false);
  // Exit-фаза: доигрываем anim-fade-out, пока родитель держит mount
  const show = useDelayedUnmount(open, 200);
  const cardRef = useRef<HTMLDivElement>(null);
  // alertdialog, не dialog: действие необратимо — скринридер обязан
  // подать это как прерывающее предупреждение
  const overlay = useOverlay({
    open,
    onClose: onCancel,
    containerRef: cardRef,
  });

  // Взведённое состояние живёт только при открытом окне: закрыл-передумал —
  // следующее открытие снова начинается с безопасного шага
  useEffect(() => {
    if (!open) {
      setArmed(false);
      return;
    }
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), ARM_RESET_MS);
    return () => window.clearTimeout(id);
  }, [open, armed]);

  if (!show) return null;

  return (
    <div
      className={`${open ? "anim-fade" : "anim-fade-out"} fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-halo-scrim`}
    >
      <div
        ref={cardRef}
        {...overlay}
        role="alertdialog"
        aria-label={t("reset.title")}
        className={`glass-pane ${open ? "anim-pop" : "anim-pop-out"} w-full max-w-sm rounded-2xl border border-halo-line bg-halo-deep/90 p-6 shadow-2xl`}
      >
        <h2 className="text-base font-medium text-halo-text">{t("reset.title")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-halo-muted">
          {t("reset.body")}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          {/* Отмена — первый контрол окна: фокус при открытии приходит на
              безопасную кнопку, Enter без прицеливания не стирает данные */}
          <button
            onClick={onCancel}
            className="press rounded-lg border border-halo-line px-3.5 py-2 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("common.close")}
          </button>
          <button
            onClick={() => (armed ? onConfirm() : setArmed(true))}
            disabled={busy}
            aria-label={armed ? t("reset.confirm") : t("reset.arm")}
            className={`rounded-lg px-3.5 py-2 text-xs font-medium shadow-sm transition-colors disabled:opacity-50 ${
              armed
                ? "bg-red-600 text-white hover:bg-red-500"
                : "border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
            }`}
          >
            {armed ? t("reset.confirm") : t("reset.arm")}
          </button>
        </div>
      </div>
    </div>
  );
}
