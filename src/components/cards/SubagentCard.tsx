import { useLang } from "../../locales";
import { type SubRunState } from "../../subagents";
import { type ToolCallInfo } from "../../types";
import { memo, useState } from "react";
import { StarburstIcon } from "./icons";

function SubagentCardBase({
  mid,
  call,
  content,
  run,
}: {
  mid: string;
  call?: ToolCallInfo;
  content: string;
  run?: SubRunState;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const running = run ? run.report === null : false;
  // Из аргументов достаём бриф (task) для подзаголовка. Проверяем typeof:
  // объект/массив от модели раньше проезжал как task и ронял рендер ленты
  // («Objects are not valid as a React child») на {task}
  let task = "";
  try {
    const parsed = call ? JSON.parse(call.arguments) : null;
    task = typeof parsed?.task === "string" ? parsed.task : "";
  } catch {
    task = "";
  }
  // Отчёт: живой из состояния или из tool-сообщения (после перезапуска приложения)
  const report = run?.report ?? (content ? content.replace(/^\[[^\]]+\]\n/, "") : "");
  const roleName = run?.roleName ?? (content.match(/^\[([^\]]+)\]/)?.[1] ?? "Subagent");
  const steps = (run?.tools.length ?? 0) + (run?.thought ? 1 : 0);

  return (
    <div
      data-mid={mid}
      className="anim-fade-up rounded-xl border border-halo-line bg-halo-surface/50"
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {running ? (
          <span className="shrink-0 text-halo-accent">
            <StarburstIcon size={12} className="work-status-star" />
          </span>
        ) : (
          <span className="shrink-0 text-[0.6875rem] text-emerald-400">✓</span>
        )}
        <span className="shrink-0 text-xs font-medium text-halo-text">
          {t("card.subagent")} · {roleName}
        </span>
        {running && (
          <span className="shrink-0 text-[0.625rem] text-halo-muted">
            {steps > 0 ? `${steps} ${t("card.subagentSteps")}` : t("card.subagentStarting")}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[0.625rem] text-halo-muted/60">
          {task}
        </span>
        <span className={`shrink-0 text-halo-muted transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-halo-line px-3 py-2.5">
          {run?.thought && (
            <pre className="scroll-slim max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[0.625rem] leading-relaxed text-halo-muted">
              {run.thought.slice(-1200)}
            </pre>
          )}
          {run && run.tools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {run.tools.map((tool, i) => (
                <code
                  key={i}
                  className="max-w-full truncate rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted"
                >
                  {tool}
                </code>
              ))}
            </div>
          )}
          {report && (
            <pre className="scroll-slim max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-halo-text">
              {report}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export const SubagentCard = memo(SubagentCardBase);
