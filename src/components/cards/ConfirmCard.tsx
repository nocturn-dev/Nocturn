import { useLang } from "../../locales";
import { type ToolCallInfo } from "../../types";

export function ConfirmCard({
  call,
  onDecision,
}: {
  call: ToolCallInfo;
  onDecision: (d: "once" | "always" | "deny") => void;
}) {
  const { t } = useLang();
  return (
    <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
        {t("agent.confirmTitle")}
      </p>
      <p className="mt-1 text-xs text-halo-muted">{t("agent.confirmDesc")}</p>
      <p className="mt-1.5 font-mono text-xs text-halo-text">
        <span className="text-amber-400">{call.name}</span>
        {call.arguments}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => onDecision("once")}
          className="rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-halo-accent-deep"
        >
          {t("agent.allow")}
        </button>
        <button
          onClick={() => onDecision("always")}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
        >
          {t("agent.allowAlways")}
        </button>
        <button
          onClick={() => onDecision("deny")}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-400/50 hover:bg-red-400/10"
        >
          {t("agent.deny")}
        </button>
      </div>
    </div>
  );
}

/**
 * Карточка шага агента (M4.1): свёрнута по умолчанию, в заголовке — инструмент
 * и человекочитаемая сводка. Внутри: diff «до/после» для fs_write,
 * команда + вывод для shell_run, сырой результат — для остальных.
 */
/** Карточка субагента: свёрнута — статус и счётчик шагов; в раскрытии —
    поток мыслей, вызовы инструментов и финальный отчёт */