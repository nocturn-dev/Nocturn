import { useEffect, useState } from "react";
import { useLang } from "../locales";

/**
 * Подтверждение «Clear All Data» (запрос приходит из трея).
 * Двухшаговое, как удаление в контекст-меню: первый клик только armит кнопку.
 * onConfirm стирает все данные и перезапускает приложение — отмены после него нет.
 */
export default function ResetConfirmModal({
  busy,
  onConfirm,
  onCancel,
}: {
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="glass-pane anim-pop w-full max-w-sm rounded-2xl border border-halo-line bg-halo-deep/90 p-6 shadow-2xl">
        <h2 className="text-base font-medium text-halo-text">{t("reset.title")}</h2>
        <p className="mt-2 text-xs leading-relaxed text-halo-muted">
          {t("reset.body")}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-halo-line px-3.5 py-2 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("common.close")}
          </button>
          <button
            onClick={() => (armed ? onConfirm() : setArmed(true))}
            disabled={busy}
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
