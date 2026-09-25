import { useEffect, useState } from "react";
import { useLang } from "../locales";

interface SystemPromptModalProps {
  open: boolean;
  initial: string;
  onSave: (prompt: string | null) => void;
  onClose: () => void;
}

export default function SystemPromptModal({
  open,
  initial,
  onSave,
  onClose,
}: SystemPromptModalProps) {
  const { t } = useLang();
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

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

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop w-full max-w-xl rounded-2xl border border-halo-line bg-halo-deep p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-halo-text">
          {t("sysprompt.title")}
        </h2>
        <p className="mb-3 mt-1 text-xs leading-relaxed text-halo-muted">
          {t("sysprompt.desc")}
        </p>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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
          <span className="text-[10px] text-halo-muted/60">
            {t("sysprompt.ctrlEnter")}
          </span>
          <button
            onClick={() => {
              onSave(draft.trim() || null);
              onClose();
            }}
            className="rounded-lg bg-halo-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
          >
            {t("prompts.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
