import { diffLines, diffStats, normalizePath } from "../../diff";
import { langFromPath } from "../../highlight";
import { useLang } from "../../locales";
import { clipboardWrite } from "../../api";
import { isWindows } from "../../platform";
import { type ChangedFile } from "../../types";
import { DiffView } from "./DiffView";
import { ChevronDownIcon, ToolIcon } from "./icons";
import ContextMenu, { type MenuItem } from "../ContextMenu";
import { memo, useMemo, useState } from "react";
import { ArrowUpRightIcon, UndoIcon } from "./icons";

/** Абсолютный путь для «Копировать путь»: путь от fs_write может быть
 *  относительным (корень проекта) — склейка по платформе */
function absolutePath(root: string | null | undefined, path: string): string {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) return path;
  if (!root) return path;
  const sep = isWindows() ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${path.replace(/^[\\/]+/, "")}`;
}

function ChangedFilesCardBase({
  files,
  onUndo,
  onReview,
  onOpenExternal,
  projectRoot,
}: {
  files: ChangedFile[];
  onUndo: (f: ChangedFile) => void;
  /** Review: открыть правую панель с живым диффом прогона (App собирает
   *  fs_write-диффы + чекпоинт). Аргумент — фокус на файле строки
   *  (стиль референса: у каждого файла своя кнопка). Без колбэка не рендерится */
  onReview?: (focusPath?: string) => void;
  /** Open: открыть файл системным приложением (бекенд резолвит root) */
  onOpenExternal?: (path: string, mode: "open" | "explorer" | "vscode") => void;
  /** Корень проекта — для «Копировать абсолютный путь» */
  projectRoot?: string | null;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  /** Меню Open-кнопки (Проводник/VS Code/копирование путей) — координаты
   *  клика, рендер через портал ContextMenu */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const menuItems = (path: string): MenuItem[] => {
    const abs = absolutePath(projectRoot, path);
    const copy = (s: string) => {
      void clipboardWrite(s)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
        .catch(() => {});
    };
    return [
      {
        label: t("changes.openSystem"),
        onSelect: () => onOpenExternal?.(path, "open"),
      },
      {
        label: t("changes.explorer"),
        onSelect: () => onOpenExternal?.(path, "explorer"),
      },
      {
        label: t("changes.vscode"),
        onSelect: () => onOpenExternal?.(path, "vscode"),
      },
      {
        label: t("changes.copyAbs"),
        separator: true,
        onSelect: () => copy(abs),
      },
      {
        label: t("changes.copyRel"),
        onSelect: () => copy(path),
      },
    ];
  };

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
            Review <ArrowUpRightIcon />
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
                  {/* Кнопки строки как в референсе: Review — дифф файла в панели,
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
                    <span className="flex shrink-0 items-center overflow-hidden rounded-md border border-halo-line">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenExternal(f.path, "open");
                        }}
                        title={t("agent.rowOpenTitle")}
                        className="px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                      >
                        {t("agent.rowOpen")}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenu({ x: r.left, y: r.bottom + 4, path: f.path });
                        }}
                        title={t("changes.menuHint")}
                        className="border-l border-halo-line px-1 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                      >
                        ▾
                      </button>
                    </span>
                  )}
                  {isUndone ? (
                    <span className="shrink-0 text-[0.625rem] text-halo-muted/70">
                      <UndoIcon /> {t("agent.undone")}
                    </span>
                  ) : (
                    canUndo && (
                      <button
                        onClick={() => undo(f)}
                        title={t("agent.undo")}
                        className="shrink-0 rounded-md p-1 text-[0.6875rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                      >
                        <UndoIcon />
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
      {/* Меню Open-кнопки: Проводник / VS Code / копирование путей */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.path)} onClose={() => setMenu(null)} />
      )}
      {copied && (
        <span className="anim-fade-up fixed bottom-4 left-1/2 z-[var(--halo-z-toast)] -translate-x-1/2 rounded-full border border-halo-line bg-halo-raised px-3 py-1 text-xs text-halo-text shadow-lg">
          {t("changes.copied")}
        </span>
      )}
    </div>
  );
}

export const ChangedFilesCard = memo(ChangedFilesCardBase);

/** Дифф-подсветка: удалённые строки красным, добавленные зелёным, контекст серым */