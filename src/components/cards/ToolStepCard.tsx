import { diffLines, diffStats, parseWriteResult, summarizeArguments } from "../../diff";
import { useLang } from "../../locales";
import { type ToolCallInfo } from "../../types";
import { DiffView } from "./DiffView";
import { ChevronDownIcon, ToolIcon } from "./icons";
import { memo, useMemo, useState } from "react";

function ToolStepCardBase({
  mid,
  call,
  content,
  status,
}: {
  mid: string;
  /** Вызов, к которому относится результат (старые сообщения — без него) */
  call?: ToolCallInfo;
  content: string;
  /** Машиный статус результата; старые сообщения — без поля */
  status?: "denied" | "error";
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const name = call?.name ?? "";

  // Статус шага: отказ пользователя, ошибка инструмента, ненулевой exit-код.
  // FIX: "denied" берётся из машинного поля Message.status; сравнение с
  // локализованной строкой оставлено как фолбэк для старых сессий
  const denied = status === "denied" || content === t("agent.denied");
  const toolError = status === "error" || content.startsWith("tool error:");
  let exitCode: number | null = null;
  if (name === "shell_run") {
    const m = content.match(/exit code: (-?\d+)/);
    if (m) exitCode = parseInt(m[1], 10);
  }
  const failed = denied || toolError || (exitCode !== null && exitCode !== 0);

  // fs_write: новый формат — JSON с before/after, старый — просто текст.
  // JSON.parse и LCS-дифф (до 1500×1500) — только при смене контента,
  // а не на каждый рендер (каждый токен стрима ре-рендерит карточку)
  const write = useMemo(
    () =>
      name === "fs_write" && !denied && !toolError
        ? parseWriteResult(content)
        : null,
    [name, denied, toolError, content],
  );
  const diff = useMemo(
    () => (write ? diffLines(write.before ?? "", write.after) : null),
    [write],
  );
  const stats = useMemo(() => (diff ? diffStats(diff) : null), [diff]);

  const summary = call ? summarizeArguments(name, call.arguments) : "";

  // Цвет статуса: красный — неудача, зелёный — запись файла, серый — прочее
  const statusColor = failed
    ? "text-red-400"
    : write
      ? "text-emerald-400"
      : "text-halo-muted";

  // FIX: локальная метка статуса переименована в statusLabel, чтобы не
  // перекрывать машинный пропс status
  const statusLabel = denied
    ? t("agent.denied")
    : toolError
      ? t("agent.errorResult")
      : exitCode !== null
        ? `exit ${exitCode}`
        : write
          ? `${t("agent.diffLinesAdded", { n: stats!.added })} · ${t("agent.diffLinesRemoved", { n: stats!.removed })}`
          : t("agent.result");

  return (
    <div
      data-mid={mid}
      className={`anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border bg-halo-surface/40 px-3 py-2 transition-colors duration-150 ${
        failed
          ? "border-red-400/40"
          : write
            ? "border-emerald-400/40"
            : "border-halo-line/60"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={statusColor}>
          <ToolIcon />
        </span>
        <span className="font-mono text-[11px] font-semibold text-halo-text">
          {name || t("agent.result")}
        </span>
        {summary && (
          <span className="max-w-72 truncate font-mono text-[10px] text-halo-muted">
            {summary}
          </span>
        )}
        <span className={`shrink-0 text-[10px] ${statusColor}`}>{statusLabel}</span>
        <ChevronDownIcon className={open ? "" : "-rotate-90"} />
      </button>

      {open && (
        <div className="anim-fade-up mt-2">
          {write && diff ? (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-[10px] text-halo-muted">
                  {write.path}
                </span>
                {write.created && (
                  <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                    {t("agent.diffCreated")}
                  </span>
                )}
                <span className="text-[10px] text-emerald-400">
                  {t("agent.diffLinesAdded", { n: stats!.added })}
                </span>
                <span className="text-[10px] text-red-400">
                  {t("agent.diffLinesRemoved", { n: stats!.removed })}
                </span>
              </div>
              <DiffView lines={diff} hasBefore={write.before !== null} />
            </>
          ) : name === "shell_run" ? (
            <div>
              <pre className="scroll-slim max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-halo-line/60 bg-halo-deep/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-text">
                {content}
              </pre>
            </div>
          ) : (
            <pre className="scroll-slim max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-halo-line/60 bg-halo-deep/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-muted">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Мемоизация: карточка получает тяжёлый контент (JSON before/after) — без
// memo рендер срабатывал на каждый токен стрима соседних сообщений
export const ToolStepCard = memo(ToolStepCardBase);