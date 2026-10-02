import { useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../motion";
import { useLang } from "../locales";
import {
  allJailbreaksFor,
  appendJailbreak,
  jbWarnSuppressed,
  searchJailbreaks,
  suppressJbWarn,
  type JailbreakEntry,
} from "../jailbreaks";
import JbWarnModal from "./JbWarnModal";

interface SystemPromptModalProps {
  open: boolean;
  initial: string;
  onSave: (prompt: string | null) => void;
  onClose: () => void;
  /** Библиотека джейлбрейков: пикер добавляет текст к черновику на виду */
  jailbreaks?: JailbreakEntry[];
}

export default function SystemPromptModal({
  open,
  initial,
  onSave,
  onClose,
  jailbreaks,
}: SystemPromptModalProps) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState(initial);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickQuery, setPickQuery] = useState("");
  const [warnEntry, setWarnEntry] = useState<JailbreakEntry | null>(null);
  const pickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  // Пикер-поповер закрывается кликом мимо (реф-паттерн Dropdown из parts)
  useEffect(() => {
    if (!pickOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) {
        setPickOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickOpen]);

  const insertJailbreak = (entry: JailbreakEntry) => {
    // Текст виден в черновике до сохранения — ничего не подмешивается молча
    setDraft((prev) => appendJailbreak(prev, entry.text));
    setPickOpen(false);
  };

  const pickJailbreak = (id: string) => {
    const entry = allJailbreaksFor(lang, jailbreaks ?? []).find(
      (x) => x.id === id,
    );
    if (!entry) return;
    // Предупреждение о рисках перед применением (пока не подавлено)
    if (jbWarnSuppressed()) {
      insertJailbreak(entry);
    } else {
      setWarnEntry(entry);
    }
  };

  const pickResults = searchJailbreaks(allJailbreaksFor(lang, jailbreaks ?? []), {
    query: pickQuery.trim(),
    model: "",
    year: "",
    sort: "relevance",
  }).slice(0, 100);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // D11: не гасим модалку, пока фокус в поле ввода — черновик длинного
        // текста (промт роли, заметка, форма автоматизации) терялся без спроса
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const show = useDelayedUnmount(open, 170);
  if (!show) return null;

  return (
    <div
      className={`fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm ${open ? "anim-fade" : "anim-fade-out"}`}
      onClick={onClose}
    >
      {warnEntry && (
        <JbWarnModal
          onConfirm={(dontShow) => {
            if (dontShow) suppressJbWarn();
            const e = warnEntry;
            setWarnEntry(null);
            if (e) insertJailbreak(e);
          }}
          onCancel={() => setWarnEntry(null)}
        />
      )}
      <div
        className={`glass-pane w-full max-w-xl rounded-2xl border border-halo-line bg-halo-deep p-5 shadow-2xl ${open ? "anim-pop" : "anim-pop-out"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-halo-text">
          {t("sysprompt.title")}
        </h2>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-halo-muted">
          {t("sysprompt.desc")}
        </p>
        {(jailbreaks?.length ?? 0) > 0 && (
          <div ref={pickRef} className="relative mb-2">
            <button
              onClick={() => setPickOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-left text-xs text-halo-text outline-none transition-colors hover:border-halo-muted/50"
            >
              {t("jb.pick")}
            </button>
            {pickOpen && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-xl border border-halo-line bg-halo-deep p-2 shadow-2xl">
                <input
                  autoFocus
                  value={pickQuery}
                  onChange={(e) => setPickQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPickOpen(false);
                  }}
                  placeholder={t("jb.searchPh")}
                  className="mb-1.5 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
                <div className="scroll-slim max-h-56 space-y-1 overflow-y-auto pr-1">
                  {pickResults.length === 0 && (
                    <p className="px-2 py-2 text-center text-[0.625rem] text-halo-muted">
                      {t("jb.searchEmpty")}
                    </p>
                  )}
                  {pickResults.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => pickJailbreak(e.id)}
                      className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-halo-line hover:bg-halo-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-halo-text">{e.name}</span>
                        <span className="mt-0.5 line-clamp-1 block text-[0.625rem] text-halo-muted">
                          {e.text}
                        </span>
                      </span>
                      {(e.model || e.year) && (
                        <span className="shrink-0 rounded bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.5625rem] text-halo-muted">
                          {[e.model, e.year].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="mt-1 text-[0.625rem] leading-tight text-halo-muted/70">
              {t("jb.pickHint")}
            </p>
          </div>
        )}
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) {
              onSave(draft.trim() || null);
              onClose();
            }
          }}
          rows={8}
          placeholder={t("sysprompt.placeholder")}
          className="scroll-slim w-full resize-none rounded-xl border border-halo-line bg-halo-surface px-3.5 py-3 font-mono text-sm leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="mt-3 flex items-center gap-2">
          {initial && (
            <button
              onClick={() => {
                onSave(null);
                onClose();
              }}
              className="rounded-lg border border-halo-line px-3 py-2 text-sm text-red-400 transition-colors hover:border-red-400/50 hover:bg-red-400/10"
            >
              {t("prompts.delete")}
            </button>
          )}
          <span className="flex-1" />
          <span className="text-[0.625rem] text-halo-muted/60">
            {t("sysprompt.ctrlEnter")}
          </span>
          <button
            onClick={() => {
              onSave(draft.trim() || null);
              onClose();
            }}
            className="rounded-lg bg-halo-accent px-4 py-2 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep"
          >
            {t("prompts.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
