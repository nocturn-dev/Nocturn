import { diffLines, diffStats, normalizePath } from "../../diff";
import { useLang } from "../../locales";
import { type ChangedFile } from "../../types";
import { DiffView } from "./DiffView";
import { ChevronDownIcon, ToolIcon } from "./icons";
import { memo, useMemo, useState } from "react";

function ChangedFilesCardBase({
  files,
  onUndo,
}: {
  files: ChangedFile[];
  onUndo: (f: ChangedFile) => void;
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
        <span className="text-[10px] font-medium text-emerald-400">
          +{total.added}
        </span>
        <span className="text-[10px] font-medium text-red-400">
          −{total.removed}
        </span>
        <span className="ml-auto text-halo-muted">
          <ChevronDownIcon className={open ? "" : "-rotate-90"} />
        </span>
      </button>
      {open && (
        <div className="anim-fade-up mt-2 border-t border-halo-line/50 pt-2">
          {files.map((f, i) => {
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
                    <span className="text-halo-muted">
                      <ChevronDownIcon className={expanded ? "" : "-rotate-90"} />
                    </span>
                    <span
                      className={`truncate font-mono text-[11px] ${
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
                      <span className="shrink-0 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                        {t("agent.diffCreated")}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-emerald-400">
                      +{stats[i].added}
                    </span>
                    <span className="shrink-0 text-[10px] text-red-400">
                      −{stats[i].removed}
                    </span>
                  </button>
                  {isUndone ? (
                    <span className="shrink-0 text-[10px] text-halo-muted/70">
                      ↩ {t("agent.undone")}
                    </span>
                  ) : (
                    canUndo && (
                      <button
                        onClick={() => undo(f)}
                        title={t("agent.undo")}
                        className="shrink-0 rounded-md p-1 text-[11px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
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