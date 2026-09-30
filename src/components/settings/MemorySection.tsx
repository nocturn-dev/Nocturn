import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import { memoryAdd, memoryClear, memoryDelete, memoryList, type MemoryFact } from "../../api";

export function MemorySection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  // Факты управляются прямо в разделе: приватность — пользователь видит всё,
  // что агент запомнил, и удаляет точечно или целиком
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [draft, setDraft] = useState("");
  // «Забыть всё» — двухшаговое подтверждение (как очистка хранилища)
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = () => {
    memoryList()
      .then(setFacts)
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
  }, []);

  const addFact = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      await memoryAdd(text);
      setDraft("");
      refresh();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const clearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    try {
      await memoryClear();
      setFacts([]);
    } catch (e) {
      window.alert(String(e));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.memory")}
      </h3>
      <div className="flex items-center justify-between rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3.5">
        <div className="min-w-0 pr-4">
          <p className="text-sm font-medium text-halo-text">{t("memory.toggle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-halo-muted">
            {t("memory.desc")}
          </p>
        </div>
        <button
          onClick={() => onChange(!enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition ${
              enabled ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3">
        <p className="text-xs font-medium text-halo-text">{t("memory.howTitle")}</p>
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-halo-muted">
          <li>· {t("memory.how1")}</li>
          <li>· {t("memory.how2")}</li>
          <li>· {t("memory.how3")}</li>
        </ul>
      </div>

      {/* Факты: то, что агент запомнил + ручное добавление */}
      <div className="mt-3 rounded-xl border border-halo-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-halo-text">{t("memory.factsTitle")}</p>
          {facts.length > 0 && (
            <button
              onClick={() => void clearAll()}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                confirmClear
                  ? "border-red-400/50 text-red-400"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {confirmClear ? t("memory.forgetConfirm") : t("memory.forgetAll")}
            </button>
          )}
        </div>
        {facts.length === 0 ? (
          <p className="mt-2 text-xs text-halo-muted/70">{t("memory.factsEmpty")}</p>
        ) : (
          <ul className="scroll-slim mt-2 max-h-64 space-y-1.5 overflow-y-auto">
            {facts.map((f) => (
              <li
                key={f.id}
                className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
              >
                <span className="min-w-0 flex-1 break-words leading-relaxed">{f.text}</span>
                <span className="shrink-0 text-[0.625rem] tabular-nums text-halo-muted/60">
                  {new Date(f.ts).toLocaleDateString()}
                </span>
                <button
                  onClick={() => {
                    void memoryDelete(f.id)
                      .then(refresh)
                      .catch((e) => window.alert(String(e)));
                  }}
                  title={t("memory.forgetOne")}
                  className="shrink-0 rounded-md px-1 text-halo-muted/60 opacity-0 group-hover:opacity-100 hover:text-red-400"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: энтер подтверждения IME не добавляет обрывок
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void addFact();
            }}
            placeholder={t("memory.factsAddPh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <button
            onClick={() => void addFact()}
            disabled={!draft.trim()}
            className="shrink-0 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
        </div>
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-halo-muted/70">
          {t("memory.factsHint")}
        </p>
      </div>
      <p className="mt-3 text-xs text-halo-muted/70">{t("memory.note")}</p>
    </div>
  );
}

/** Названия шеллов консоли: не переводятся */
