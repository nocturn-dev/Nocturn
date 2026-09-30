import { useState } from "react";
import { diffLines } from "../../diff";
import type { StepRow } from "../../agent/steps";
import { useLang, type MsgKey } from "../../locales";
import { DiffView } from "./DiffView";

/**
 * Аккордеон шагов хода (фидбек 26.09): плоские ряды Edit/Terminal/Explore/Asked
 * с живыми деталями (+N −N, команда, путь, секунды), раскрытие по клику.
 * Thought — не здесь: мысли показывает раскрывающийся блок «Размышления»
 * в AssistantCard; subagent_run — живые карточки SubagentCard.
 */

const KIND_LABEL: Record<StepRow["kind"], MsgKey> = {
  edit: "steps.kindEdit",
  terminal: "steps.kindTerminal",
  explore: "steps.kindExplore",
  asked: "steps.kindAsked",
};

const KIND_COLOR: Record<StepRow["kind"], string> = {
  edit: "text-halo-muted",
  terminal: "text-halo-muted",
  explore: "text-halo-muted",
  asked: "text-halo-accent/90",
};

function KindIcon({ kind }: { kind: StepRow["kind"] }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "edit") {
    return (
      <svg {...common}>
        <path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L3.5 16.5 2 22l5.5-1.5Z" />
      </svg>
    );
  }
  if (kind === "terminal") {
    return (
      <svg {...common}>
        <path d="m5 8 4 4-4 4M12 16h7" />
      </svg>
    );
  }
  if (kind === "asked") {
    return (
      <svg {...common}>
        <path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-4.6A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5Z" />
        <path d="M9.6 9.2a2.5 2.5 0 0 1 4.9.6c0 1.6-2.4 2-2.4 3.4M12 16.4h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4-4" />
    </svg>
  );
}

export function StepAccordion({
  steps,
  flat,
}: {
  steps: StepRow[];
  /** Flat-режим (лента хода в стиле ZCode): ряды без коробок — только
   *  иконка/лейбл/детали на прозрачном фоне, hover-подсветка остаётся */
  flat?: boolean;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={flat ? "w-full space-y-0.5" : "mt-2 w-full space-y-0.5"}>
      {steps.map((s) => {
        const isOpen = open.has(s.id);
        return (
          <div
            key={s.id}
            className={
              flat
                ? `rounded-lg ${s.failed ? "bg-red-400/5" : ""}`
                : `rounded-lg border bg-halo-deep/30 ${
                    s.failed ? "border-red-400/30" : "border-halo-line/50"
                  }`
            }
          >
            <button
              onClick={() => toggle(s.id)}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[0.6875rem] transition-colors hover:bg-halo-hover/40 ${
                flat ? "rounded-lg" : ""
              }`}
            >
              <span className={`shrink-0 ${KIND_COLOR[s.kind]}`}>
                <KindIcon kind={s.kind} />
              </span>
              <span className="w-14 shrink-0 font-medium text-halo-muted">
                {t(KIND_LABEL[s.kind])}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-halo-text/90">
                {s.label}
              </span>
              {s.detail && (
                <span className="shrink-0 font-mono text-[0.625rem] text-halo-muted/80">
                  {s.detail}
                </span>
              )}
              {s.stats && (
                <span className="shrink-0 font-mono text-[0.625rem]">
                  <span className="text-emerald-400">+{s.stats.added}</span>{" "}
                  <span className="text-red-400">−{s.stats.removed}</span>
                </span>
              )}
              {s.failed && (
                <span className="shrink-0 text-[0.625rem] text-red-400">
                  {s.failed === "denied"
                    ? "denied"
                    : s.failed === "exit"
                      ? `exit ${s.exitCode}`
                      : "error"}
                </span>
              )}
              {s.secondsMs != null && s.secondsMs > 0 && (
                <span className="w-10 shrink-0 text-right tabular-nums text-halo-muted/60">
                  {(s.secondsMs / 1000).toFixed(1).replace(".", ",")}s
                </span>
              )}
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`shrink-0 text-halo-muted transition-transform ${
                  isOpen ? "" : "-rotate-90"
                }`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {isOpen && s.diff && (
              <div className="px-2 pb-2">
                <DiffView
                  lines={diffLines(s.diff.before, s.diff.after)}
                  hasBefore
                />
              </div>
            )}
            {isOpen && s.output && (
              <pre className="mx-2 mb-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-halo-line/40 bg-halo-raised/30 px-2.5 py-2 font-mono text-[0.625rem] leading-relaxed text-halo-muted scroll-slim">
                {s.output}
              </pre>
            )}
            {isOpen && s.question && (
              <div className="mx-2 mb-2 space-y-1 rounded-md border border-halo-line/40 bg-halo-raised/30 px-2.5 py-2 text-[0.6875rem] leading-relaxed">
                <p className="whitespace-pre-wrap text-halo-text">{s.question}</p>
                {s.answer && (
                  <p className="whitespace-pre-wrap border-t border-halo-line/40 pt-1 text-halo-muted">
                    → {s.answer}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
