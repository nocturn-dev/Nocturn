import { useState } from "react";
import { useLang } from "../locales";

/** Предупреждение при применении джейлбрейка: риски ToS/банов — на
 * пользователе, Nocturn отправляет только его провайдеру. Показывается
 * при каждом применении, пока не отмечено «больше не показывать». */
export default function JbWarnModal({
  onConfirm,
  onCancel,
}: {
  /** dontShow — отметить ли «больше не показывать» */
  onConfirm: (dontShow: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const [dontShow, setDontShow] = useState(false);

  return (
    <div
      className="fixed inset-0 z-[var(--halo-z-modal-top)] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="glass-pane w-full max-w-md rounded-2xl border border-halo-line bg-halo-deep p-5 shadow-2xl anim-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-halo-text">
          {t("jb.warnTitle")}
        </h2>
        <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-halo-muted">
          {t("jb.warnBody")}
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-halo-muted">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => setDontShow(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--halo-accent)]"
          />
          {t("jb.warnDontShow")}
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-sm text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("jb.warnCancel")}
          </button>
          <button
            onClick={() => onConfirm(dontShow)}
            className="rounded-lg bg-halo-accent px-4 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep"
          >
            {t("jb.warnAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}
