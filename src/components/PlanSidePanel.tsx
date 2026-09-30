import { useDelayedUnmount } from "../motion";
import { copyText } from "../clipboard";
import { useLang } from "../locales";
import { type PlanTask } from "../types";
import { CheckIcon, XSmallIcon } from "./cards/icons";

/**
 * Правая панель плана (Волна 3): задачи активной задачи из session.plan
 * (наполняются инструментом plan_update). Открывается автоматически при
 * переключении режима в «План»; отсюда план одобряется (режим → «Спрашивать»)
 * или копируется в буфер. Мини-PlanPanel у композера остаётся.
 */

export function PlanSidePanel({
  open,
  plan,
  canApprove,
  onApprove,
  onCopied,
  onClose,
}: {
  open: boolean;
  plan: PlanTask[];
  /** Одобрение доступно только в существующей задаче */
  canApprove: boolean;
  onApprove: () => void;
  /** План успешно скопирован (тост показывает родитель) */
  onCopied: () => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const show = useDelayedUnmount(open, 200);
  if (!show) return null;
  const done = plan.filter((p) => p.status === "done").length;

  const copyPlan = async () => {
    const lines = plan.map((p) => {
      const mark =
        p.status === "done" ? "[x]" : p.status === "in_progress" ? "[~]" : "[ ]";
      return `${mark} ${p.title}`;
    });
    // Тост только при реальном успехе: фолбэк внутри copyText (старый WebKitGTK)
    if (await copyText(lines.join("\n"))) {
      onCopied();
    }
  };

  return (
    <div className={`fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-[92vw] flex-col border-l border-halo-line bg-halo-deep shadow-2xl ${open ? "anim-slide-left" : "anim-slide-left-out"}`}>
      <div className="flex items-center justify-between gap-3 border-b border-halo-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-halo-text">{t("plan.panelTitle")}</p>
          <p className="mt-0.5 text-[0.6875rem] text-halo-muted">{t("plan.panelHint")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-halo-surface/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
          {done}/{plan.length}
        </span>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <XSmallIcon />
        </button>
      </div>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {plan.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-halo-muted/60">
            {t("plan.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {plan.map((task, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-[3px] shrink-0">
                  {task.status === "done" ? (
                    <span className="block text-halo-accent">
                      <CheckIcon />
                    </span>
                  ) : task.status === "in_progress" ? (
                    <span className="block size-2.5 animate-pulse rounded-full border-[1.5px] border-halo-accent" />
                  ) : (
                    <span className="block size-2.5 rounded-full border-[1.5px] border-halo-muted/50" />
                  )}
                </span>
                <span
                  className={`text-[0.75rem] leading-snug ${
                    task.status === "done"
                      ? "text-halo-muted line-through"
                      : "text-halo-text"
                  }`}
                >
                  {task.title}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Одобрение: план принят — режим «План» сменяется на «Спрашивать» */}
      <div className="flex gap-2 border-t border-halo-line px-4 py-3">
        <button
          onClick={onApprove}
          disabled={!canApprove || plan.length === 0}
          className="min-w-0 flex-1 rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-3 py-2 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("plan.approve")}
        </button>
        <button
          onClick={() => void copyPlan()}
          disabled={plan.length === 0}
          className="rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("plan.copy")}
        </button>
      </div>
    </div>
  );
}
