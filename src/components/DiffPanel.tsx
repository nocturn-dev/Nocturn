import { useState } from "react";
import { useDelayedUnmount } from "../motion";
import { diffLines } from "../diff";
import { useLang } from "../locales";
import { DiffView } from "./cards/DiffView";
import { ChevronDownIcon, XSmallIcon } from "./cards/icons";

/**
 * Правая панель Review (фидбек 26.09, по образцу Codex): все изменённые
 * файлы прогона с живым диффом — добавленное зелёным, удалённое красным,
 * контекст без подсветки. Данные собирает App: fs_write-диффы мгновенно +
 * чекпоинт прогона (покрывает правки мимо fs_write).
 */

export interface DiffPanelFile {
  path: string;
  base: string;
  dir: string;
  added: number;
  removed: number;
  created: boolean;
  before: string | null;
  after: string;
}

export function DiffPanel({
  open,
  files,
  onQuote,
  onClose,
}: {
  open: boolean;
  files: DiffPanelFile[];
  /** Клик по строке диффа → цитата «file:line» в композер (Волна 6) */
  onQuote?: (path: string, line: number, text: string) => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [openFile, setOpenFile] = useState<string | null>(null);
  const show = useDelayedUnmount(open, 200);
  if (!show) return null;
  const total = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );
  return (
    <div className={`fixed inset-y-0 right-0 z-40 flex w-[560px] max-w-[92vw] flex-col border-l border-halo-line bg-halo-deep shadow-2xl ${open ? "anim-slide-left" : "anim-slide-left-out"}`}>
      <div className="flex items-center justify-between gap-3 border-b border-halo-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-halo-text">Review</p>
          <p className="mt-0.5 text-[11px] text-halo-muted">
            {t("agent.filesChanged", { n: files.length })}{" "}
            <span className="font-medium text-emerald-400">+{total.added}</span>{" "}
            <span className="font-medium text-red-400">−{total.removed}</span>
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <XSmallIcon />
        </button>
      </div>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {files.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-halo-muted/60">
            {t("agent.result")}
          </p>
        )}
        {files.map((f, i) => {
          const expanded = openFile === f.path;
          return (
            <div key={f.path} className="mb-1 last:mb-0">
              <button
                onClick={() => setOpenFile(expanded ? null : f.path)}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-halo-hover"
              >
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-halo-muted/60">
                  {i + 1}.
                </span>
                <ChevronDownIcon
                  className={`shrink-0 text-halo-muted ${expanded ? "" : "-rotate-90"}`}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-halo-text">
                  {f.base}
                  <span className="text-halo-muted/60"> {f.dir}</span>
                </span>
                {f.created && (
                  <span className="shrink-0 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                    {t("agent.diffCreated")}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10px] text-emerald-400">
                  +{f.added}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-red-400">
                  −{f.removed}
                </span>
              </button>
              {expanded && (
                <div className="mb-1 ml-6">
                  <DiffView
                    lines={diffLines(f.before ?? "", f.after)}
                    hasBefore={f.before !== null}
                    onQuoteLine={
                      onQuote
                        ? (line, text) => onQuote(f.path, line, text)
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
