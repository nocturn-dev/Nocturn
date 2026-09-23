import type * as React from "react";
import { useLang } from "../../locales";
import { type AskQuestion } from "../../types";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AskUserCard({
  ask,
  live,
  onAnswer,
}: {
  ask: AskQuestion;
  /** Вопрос ждёт ответа прямо сейчас (прогон активен) */
  live: boolean;
  onAnswer: (a: { answers: string[]; custom?: string }) => void;
}) {
  const { t } = useLang();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");
  const [hovered, setHovered] = useState<number | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Закрытый вопрос (ответ дан / Stop / приложение перезапущено) — сводка
  if (ask.answer || ask.cancelled || !live) {
    return (
      <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-halo-accent">
          {ask.header || t("ask.title")}
        </p>
        <div className="mt-1 max-w-prose text-xs text-halo-muted [&_p]:m-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{ask.question}</ReactMarkdown>
        </div>
        {ask.answer ? (
          <p className="mt-2 text-xs text-halo-text">
            <span className="text-halo-muted">{t("ask.answered")}: </span>
            {[...ask.answer.answers, ask.answer.custom ?? ""]
              .filter((x) => x.trim() !== "")
              .join(", ")}
          </p>
        ) : (
          <p className="mt-2 text-xs italic text-halo-muted/70">
            {t("ask.cancelled")}
          </p>
        )}
      </div>
    );
  }

  const multi = ask.multiSelect ?? false;
  const canSubmit = selected.size > 0 || custom.trim() !== "";
  // Превью (v2): только для одиночного выбора, показывается у опции под
  // курсором/фокусом, иначе у выбранной, иначе у первой с превью
  const hasPreviews =
    !multi && ask.options.some((o) => typeof o.preview === "string" && o.preview);
  const previewIdx =
    hovered ??
    ([...selected][selected.size - 1] ?? ask.options.findIndex((o) => o.preview));

  const toggleOption = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        if (next.has(i)) next.delete(i);
        else next.add(i);
      } else {
        next.clear();
        next.add(i);
      }
      return next;
    });
    if (!multi) setCustom("");
  };

  const submit = () => {
    if (!canSubmit) return;
    onAnswer({
      answers: [...selected]
        .sort((a, b) => a - b)
        .map((i) => ask.options[i]?.label ?? ""),
      custom: custom.trim() || undefined,
    });
  };

  // Стрелки вверх/вниз двигают фокус по опциям (Tab работает нативно)
  const onKeyNav = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const cur = optionRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    const next = (cur + dir + ask.options.length) % ask.options.length;
    optionRefs.current[next]?.focus();
  };

  return (
    <div
      className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-halo-accent/40 bg-halo-surface/50 px-4 py-3 shadow-sm"
      onKeyDown={onKeyNav}
    >
      {ask.header && (
        <p className="text-[11px] font-semibold uppercase tracking-wider text-halo-accent">
          {ask.header}
        </p>
      )}
      <div className="mt-1 max-w-prose text-sm text-halo-text [&_p]:m-0 [&_code]:text-xs">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{ask.question}</ReactMarkdown>
      </div>
      <div className={`mt-3 flex gap-3`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {ask.options.map((opt, i) => {
          const active = selected.has(i);
          return (
            <button
              key={i}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              onClick={() => toggleOption(i)}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-halo-accent/60 bg-halo-accent/10"
                  : "border-halo-line hover:border-halo-accent/40 hover:bg-halo-hover"
              }`}
            >
              {/* Радио/чекбокс */}
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors ${
                  active ? "border-halo-accent" : "border-halo-muted/50"
                } ${multi ? "rounded-[5px]" : "rounded-full"}`}
              >
                {active && <span className="size-2 rounded-full bg-halo-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-halo-text">
                  {opt.label}
                </span>
                {opt.description && (
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-halo-muted">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        </div>
        {hasPreviews && ask.options[previewIdx]?.preview && (
          <pre className="max-h-56 w-64 shrink-0 overflow-auto rounded-lg border border-halo-line bg-halo-bg p-2 text-[11px] leading-relaxed text-halo-muted">
            {ask.options[previewIdx].preview}
          </pre>
        )}
      </div>
      <input
        type="text"
        value={custom}
        onChange={(e) => {
          setCustom(e.target.value);
          if (!multi) setSelected(new Set());
        }}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("ask.otherPh")}
        className="mt-2 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-halo-accent-deep disabled:opacity-40"
        >
          {t("ask.submit")}
        </button>
        {multi && (
          <span className="text-[11px] text-halo-muted/70">
            {t("ask.multiHint")}
          </span>
        )}
      </div>
    </div>
  );
}
