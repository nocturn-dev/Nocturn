import type { Attachment } from "../types";

/**
 * Карточка текстового файла в стиле референса: имя, число строк
 * и бейдж расширения («colibri.rs / 293 lines / RS»). Одна для всех мест
 * (композер и карточка сообщения) — раньше композер рисовал квадрат с
 * FileIcon, а сообщение — узкую пилюлю, и они разъезжались.
 */

/** «colibri.rs» → «RS» (кап 4 символа на длинные расширения) */
export function fileExtBadge(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return (m?.[1] ?? "TXT").toUpperCase().slice(0, 4);
}

export function FileCard({
  a,
  linesLabel,
}: {
  a: Attachment;
  /** Локализованная подпись числа строк, например «293 стр.» */
  linesLabel?: string;
}) {
  return (
    <div
      title={a.name}
      className="flex size-20 flex-col justify-between rounded-xl border border-halo-line bg-halo-surface/60 p-2"
    >
      <span className="line-clamp-2 break-all text-left text-[0.6875rem] font-medium leading-tight text-halo-text">
        {a.name}
      </span>
      <div className="flex items-end justify-between gap-1">
        <span className="rounded bg-halo-deep px-1 py-0.5 text-[0.5625rem] font-semibold tracking-wider text-halo-accent">
          {fileExtBadge(a.name)}
        </span>
        {linesLabel != null && (
          <span className="shrink-0 text-[0.5625rem] text-halo-muted">
            {linesLabel}
          </span>
        )}
      </div>
    </div>
  );
}
