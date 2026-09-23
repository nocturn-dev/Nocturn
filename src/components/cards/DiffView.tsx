import { type DiffLine } from "../../diff";
import { useLang } from "../../locales";
import { useState } from "react";

export function DiffView({ lines, hasBefore }: { lines: DiffLine[]; hasBefore: boolean }) {
  const { t } = useLang();
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 300;
  const shown = showAll ? lines : lines.slice(0, LIMIT);

  return (
    <div className="scroll-slim max-h-96 overflow-auto rounded-lg border border-halo-line/60 bg-halo-deep/60">
      {hasBefore ? (
        lines.some((l) => l.type !== "ctx") ? (
          shown.map((l, i) => (
            <div
              key={i}
              className={`flex gap-2 px-2 font-mono text-[11px] leading-[1.6] ${
                l.type === "del"
                  ? "bg-red-400/10 text-red-300"
                  : l.type === "add"
                    ? "bg-emerald-400/10 text-emerald-300"
                    : "text-halo-muted"
              }`}
            >
              <span className="w-8 shrink-0 select-none text-right text-halo-muted/50">
                {l.oldNo ?? ""}
              </span>
              <span className="w-4 shrink-0 select-none text-right">
                {l.type === "del" ? "−" : l.type === "add" ? "+" : ""}
              </span>
              <span className="whitespace-pre-wrap break-all">{l.text}</span>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-[11px] text-halo-muted">
            {t("agent.diffEmpty")}
          </div>
        )
      ) : (
        // Нового файла не было — показываем только «после»
        <pre className="scroll-slim max-h-96 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-text">
          {lines.map((l) => l.text).join("\n")}
        </pre>
      )}
      {!showAll && lines.length > LIMIT && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full border-t border-halo-line/60 py-1.5 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("card.expand")} · {lines.length - LIMIT}
        </button>
      )}
    </div>
  );
}
