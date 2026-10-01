import { diffLines, diffStats, normalizePath } from "../../diff";
import { langFromPath } from "../../highlight";
import { useLang } from "../../locales";
import { type ChangedFile } from "../../types";
import { DiffView } from "./DiffView";
import { ChevronDownIcon, ToolIcon } from "./icons";
import { memo, useMemo, useState } from "react";

function ChangedFilesCardBase({
  files,
  onUndo,
  onReview,
  onOpenExternal,
}: {
  files: ChangedFile[];
  onUndo: (f: ChangedFile) => void;
  /** Review: открыть правую панель с живым диффом прогона (App собирает
   *  fs_write-диффы + чекпоинт). Аргумент — фокус на файле строки
   *  (ZCode-стиль: у каждого файла своя кнопка). Без колбэка не рендерится */
  onReview?: (focusPath?: string) => void;
  /** Open: открыть файл системным приложением (бекенд резолвит root) */
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(new Set());

  const stats = useMemo(
    () =>
      files.map((f) => {
        // Один проход LCS на файл: раньше дифф считался дважды
        // (отдельно для added и removed)
        const s = diffStats(diffLines(f.before ?? "", f.after));
        return { added: s.added, removed: s.removed };
      }),
    [files],
  );
  const total = stats.reduce(
    (acc, s) => ({ added: acc.added + s.added, removed: acc.removed + s.removed }),
    { added: 0, removed: 0 },
  );

  const undo = (f: ChangedFile) => {
    onUndo(f);
    setUndone((prev) => new Set(prev).add(normalizePath(f.path)));
  };

  return (
    <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line/70 bg-halo-surface/70 px-4 py-2.5 shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <span className="text-halo-muted">
          <ToolIcon />
        </span>
        <span className="text-xs font-medium text-halo-text">
          {t("agent.filesChanged", { n: files.length })}
        </span>
        <span className="text-[0.625rem] font-medium text-emerald-400">
          +{total.added}
        </span>
        <span className="text-[0.625rem] font-medium text-red-400">
          −{total.removed}
        </span>
        {onReview && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReview();
            }}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
          >
            Review ↗
          </button>
        )}
        <span className={`text-halo-muted ${onReview ? "" : "ml-auto"}`}>
          <ChevronDownIcon className={open ? "" : "-rotate-90"} />
        </span>
      </button>
      {open && (
        <div className="anim-fade-up mt-2 border-t border-halo-line/50 pt-2">
          {files.map((f, i) => {
            const st = stats[i];
            if (!st) return null;
            const isUndone = undone.has(normalizePath(f.path));
            // Усечённый before нельзя безопасно восстановить — undo недоступен
            const canUndo = !isUndone && !f.before?.startsWith("[TRUNCATED");
            const expanded = openFile === normalizePath(f.path);
            const dir = f.path.replace(/[\\/][^\\/]+$/, "");
            const base = f.path.slice(dir ? dir.length + 1 : 0);
            return (
              <div key={f.path} className="mb-1 last:mb-0">
                <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-halo-hover">
                  <button
                    onClick={() =>
                      setOpenFile(expanded ? null : normalizePath(f.path))
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {/* Нумерация как в Codex: 1. файл путь/ +a −d */}
                    <span className="w-4 shrink-0 text-right text-[0.625rem] tabular-nums text-halo-muted/60">
                      {i + 1}.
                    </span>
                    <span className="text-halo-muted">
                      <ChevronDownIcon className={expanded ? "" : "-rotate-90"} />
                    </span>
                    <span
                      className={`truncate font-mono text-[0.6875rem] ${
                        isUndone
                          ? "text-halo-muted/60 line-through"
                          : "text-halo-text"
                      }`}
                      title={f.path}
                    >
                      {base}
                      <span className="text-halo-muted/60"> {dir}</span>
                    </span>
                    {f.created && !isUndone && (
                      <span className="shrink-0 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-400">
                        {t("agent.diffCreated")}
                      </span>
                    )}
                    <span className="shrink-0 text-[0.625rem] text-emerald-400">
                      +{st.added}
                    </span>
                    <span className="shrink-0 text-[0.625rem] text-red-400">
                      −{st.removed}
                    </span>
                  </button>
                  {/* Кнопки строки как в ZCode: Review — дифф файла в панели,
                      Open — системное приложение. Undo не трогаем */}
                  {onReview && !isUndone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onReview(normalizePath(f.path));
                      }}
                      title={t("agent.rowReviewTitle")}
                      className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                    >
                      {t("agent.rowReview")}
                    </button>
                  )}
                  {onOpenExternal && !isUndone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenExternal(f.path);
                      }}
                      title={t("agent.rowOpenTitle")}
                      className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                    >
                      {t("agent.rowOpen")}
                    </button>
                  )}
                  {isUndone ? (
                    <span className="shrink-0 text-[0.625rem] text-halo-muted/70">
                      ↩ {t("agent.undone")}
                    </span>
                  ) : (
                    canUndo && (
                      <button
                        onClick={() => undo(f)}
                        title={t("agent.undo")}
                        className="shrink-0 rounded-md p-1 text-[0.6875rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                      >
                        ↩
                      </button>
                    )
                  )}
                </div>
                {expanded && (
                  <div className="mt-1">
                    <DiffView
                      lines={diffLines(f.before ?? "", f.after)}
                      hasBefore={f.before !== null}
                      lang={langFromPath(f.path)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const ChangedFilesCard = memo(ChangedFilesCardBase);

/** Дифф-подсветка: удалённые строки красным, добавленные зелёным, контекст серым */