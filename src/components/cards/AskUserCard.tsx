import type * as React from "react";
import { useRef, useState } from "react";
import { useLang } from "../../locales";
import { type AskQuestion } from "../../types";

/**
 * Живой вопрос агента (ask_user): компактная панель над композером,
 * прикреплённая к нему. Референс-стиль: нумерованные варианты
 * «label — описание», свой ответ, подсказка + Submit.
 */
export function AskPanel({
  ask,
  onAnswer,
}: {
  ask: AskQuestion;
  onAnswer: (a: { answers: string[]; custom?: string }) => void;
}) {
  const { t } = useLang();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");
  const [focused, setFocused] = useState<number | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const multi = ask.multiSelect ?? false;
  const canSubmit = selected.size > 0 || custom.trim() !== "";

  const toggle = (i: number) => {
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

  // Клавиши: ↑/↓ — фокус по вариантам, цифры 1..N — мгновенный выбор
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < ask.options.length) {
        e.preventDefault();
        toggle(i);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const cur = optionRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    const next = (cur + dir + ask.options.length) % ask.options.length;
    optionRefs.current[next]?.focus();
  };

  const previewIdx =
    focused ??
    [...selected][selected.size - 1] ??
    ask.options.findIndex((o) => o.preview);
  const preview =
    !multi && ask.options[previewIdx]?.preview
      ? ask.options[previewIdx].preview
      : null;

  return (
    <div
      className="anim-fade-up mb-2 rounded-xl border border-halo-accent/40 bg-halo-deep/95 px-4 py-3 shadow-lg"
      onKeyDown={onKeyDown}
    >
      {/* Шапка: чип + вопрос одной строкой */}
      <div className="flex items-baseline gap-2">
        {ask.header && (
          <span className="shrink-0 rounded-md bg-halo-accent/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-halo-accent">
            {ask.header}
          </span>
        )}
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-halo-text">
          {ask.question}
        </p>
      </div>

      <div className="mt-1 flex gap-3">
        <div className="min-w-0 flex-1">
          {/* Варианты: номер + label — описание */}
          <div className="flex flex-col">
            {ask.options.map((opt, i) => {
              const active = selected.has(i);
              return (
                <button
                  key={i}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  onClick={() => toggle(i)}
                  onMouseEnter={() => setFocused(i)}
                  onFocus={() => setFocused(i)}
                  className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    active ? "bg-halo-accent/15" : "hover:bg-halo-hover"
                  }`}
                >
                  <span
                    className={`w-3 shrink-0 text-right text-xs font-semibold ${
                      active ? "text-halo-accent" : "text-halo-muted/50"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 text-xs leading-relaxed">
                    <span
                      className={`font-medium ${
                        active ? "text-halo-accent" : "text-halo-text"
                      }`}
                    >
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="text-halo-muted"> — {opt.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
            {/* Свой / уточняющий ответ */}
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <span className="w-3 shrink-0 text-right text-xs font-semibold text-halo-muted/50">
                {ask.options.length + 1}
              </span>
              <input
                type="text"
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  if (!multi) setSelected(new Set());
                }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={t("ask.otherPh")}
                className="min-w-0 flex-1 bg-transparent text-xs text-halo-text outline-none placeholder:text-halo-muted/50"
              />
            </div>
          </div>
        </div>

        {/* Превью выбранной/активной опции (только одиночный выбор) */}
        {preview && (
          <pre className="max-h-48 w-64 shrink-0 overflow-auto rounded-lg border border-halo-line bg-halo-bg p-2 text-[11px] leading-relaxed text-halo-muted">
            {preview}
          </pre>
        )}
      </div>

      {/* Футер: подсказка + Submit */}
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] text-halo-muted/60">
          {multi ? t("ask.multiHint") : t("ask.kbdHint")}
        </p>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="shrink-0 rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-halo-on-accent shadow-sm transition-colors hover:bg-halo-accent-deep disabled:opacity-40"
        >
          {t("ask.submit")}
        </button>
      </div>
    </div>
  );
}

/** Закрытый вопрос в истории: одна компактная строка-карточка */
export function AskClosedCard({ ask }: { ask: AskQuestion }) {
  const { t } = useLang();
  return (
    <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line bg-halo-surface/50 px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        {ask.header && (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-halo-accent">
            {ask.header}
          </span>
        )}
        <span className="text-halo-muted">{ask.question}</span>
      </p>
      {ask.answer ? (
        <p className="mt-1 text-xs text-halo-text">
          <span className="text-halo-muted">{t("ask.answered")}: </span>
          {[...ask.answer.answers, ask.answer.custom ?? ""]
            .filter((x) => x.trim() !== "")
            .join(", ")}
        </p>
      ) : (
        <p className="mt-1 text-xs italic text-halo-muted/70">
          {t("ask.cancelled")}
        </p>
      )}
    </div>
  );
}
