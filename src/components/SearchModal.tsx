import { useEffect, useMemo, useState } from "react";
import type { Session } from "../types";
import { useLang } from "../locales";

interface SearchModalProps {
  open: boolean;
  sessions: Session[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** Палитра поиска (Ctrl+K): ищет по названиям и содержимому задач */
export default function SearchModal({
  open,
  sessions,
  onSelect,
  onClose,
}: SearchModalProps) {
  const { t } = useLang();
  const [query, setQuery] = useState("");

  // Сброс запроса при каждом открытии
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Закрытие по Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = [...sessions].sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned),
    );
    if (words.length === 0) return list.slice(0, 12);
    // Все слова запроса должны встречаться в названии или сообщениях
    return list
      .filter((s) => {
        const haystack = (
          s.title +
          " " +
          s.messages.map((m) => m.content).join(" ")
        ).toLowerCase();
        return words.every((w) => haystack.includes(w));
      })
      .slice(0, 20);
  }, [sessions, query]);

  if (!open) return null;

  const submit = () => {
    if (results[0]) {
      onSelect(results[0].id);
      onClose();
    }
  };

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  /** Подсветка совпадений по всем словам запроса */
  const Highlight = ({ text }: { text: string }) => {
    if (words.length === 0) return <>{text}</>;
    const re = new RegExp(
      `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
      "gi",
    );
    const parts = text.split(re);
    return (
      <>
        {parts.map((p, i) =>
          i % 2 === 1 ? (
            <mark
              key={i}
              className="rounded-sm bg-halo-accent/30 px-0.5 text-halo-text"
            >
              {p}
            </mark>
          ) : (
            <span key={i}>{p}</span>
          ),
        )}
      </>
    );
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop mx-auto mt-[10vh] w-full max-w-lg overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-halo-line px-4 py-3">
          <span className="text-halo-muted">
            <SearchIcon />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={t("search.placeholder")}
            className="flex-1 bg-transparent text-sm text-halo-text outline-none placeholder:text-halo-muted"
          />
          <kbd className="rounded border border-halo-line px-1.5 py-0.5 text-[10px] text-halo-muted">
            Esc
          </kbd>
        </div>

        <div className="scroll-slim max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-halo-muted">
              {t("search.empty")}
            </p>
          ) : (
            results.map((s) => {
              // Сниппет: первое сообщение, где есть совпадение, иначе последнее
              const q = query.trim().toLowerCase();
              const hit =
                (q
                  ? s.messages.find((m) =>
                      m.content.toLowerCase().includes(q.split(/\s+/)[0]),
                    )
                  : undefined) ?? s.messages.at(-1);
              const snippet = hit?.content.replace(/\s+/g, " ").slice(0, 90);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    onSelect(s.id);
                    onClose();
                  }}
                  className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-halo-hover"
                >
                  <div className="flex items-center gap-1.5">
                    {s.pinned && (
                      <span className="text-halo-accent/80">
                        <PinIcon />
                      </span>
                    )}
                    <span className="truncate text-sm text-halo-text">
                      <Highlight text={s.title} />
                    </span>
                  </div>
                  {snippet && (
                    <p className="mt-0.5 truncate text-xs text-halo-muted">
                      <Highlight text={snippet} />
                    </p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}
