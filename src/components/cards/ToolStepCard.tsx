import { diffLines, diffStats, parseWriteResult, summarizeArguments } from "../../diff";
import { useLang } from "../../locales";
import { type ToolCallInfo } from "../../types";
import { convertFileSrc } from "@tauri-apps/api/core";
import { DiffView } from "./DiffView";
import { ChevronDownIcon, ToolIcon } from "./icons";
import { memo, useMemo, useState } from "react";

/** Результат image_generate → {path}; мусор/ошибки — null */
function parseImageResult(content: string): { path: string } | null {
  try {
    const v = JSON.parse(content) as { ok?: unknown; path?: unknown };
    if (v.ok === true && typeof v.path === "string" && v.path.length > 0) {
      return { path: v.path };
    }
  } catch {
    // не JSON (старые результаты/ошибки) — обычный текстовый вывод
  }
  return null;
}

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
    if (m) exitCode = parseInt(m[1] ?? "", 10);
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
  // added/removed считаются из diff; диффа нет — нули. Вместо optional-объекта
  // stats с non-null assertions в трёх местах рендера
  const { added, removed } = useMemo(
    () => (diff ? diffStats(diff) : { added: 0, removed: 0 }),
    [diff],
  );

  // image_generate: результат {ok, path} рендерится картинкой прямо в чате
  // (файл лежит в appdata/images, каталог разрешён в asset-скоупе на старте)
  const imageResult = useMemo(
    () =>
      name === "image_generate" && !denied && !toolError
        ? parseImageResult(content)
        : null,
    [name, denied, toolError, content],
  );
  const imageSrc =
    imageResult && "__TAURI_INTERNALS__" in window
      ? convertFileSrc(imageResult.path)
      : null;

  const summary = call ? summarizeArguments(name, call.arguments) : "";

  // Цвет статуса: красный — неудача, зелёный — запись файла или картинка, серый — прочее
  const statusColor = failed
    ? "text-red-400"
    : write || imageResult
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
          ? `${t("agent.diffLinesAdded", { n: added })} · ${t("agent.diffLinesRemoved", { n: removed })}`
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

      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          className="mt-2 max-h-72 w-auto max-w-full rounded-lg border border-halo-line/60"
        />
      )}

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
                  {t("agent.diffLinesAdded", { n: added })}
                </span>
                <span className="text-[10px] text-red-400">
                  {t("agent.diffLinesRemoved", { n: removed })}
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