import { useEffect, useMemo, useState } from "react";
import { useLang } from "../../locales";
import type { Session, UsageEvent } from "../../types";
import type { ApiSettings } from "../../api";
import { chatOnce, memoryList, notesList, notesWrite } from "../../api";
import { copyText } from "../../clipboard";
import UsageSection from "../UsageSection";
import { dayKeyLocal } from "../../time";
import { buildReflect, buildReflectPrompt } from "../../reflect";
import { CheckIcon } from "../cards/icons";

/** Короткий формат токенов: как в «Статистике» (там не экспортируется) */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Раздел «Обзор» (Reflect): локальная агрегация активности за период.
 * Статистика считается на устройстве всегда; «Рефлексия» — один вызов
 * текущей модели поверх сводки (данные те же, что и в любом чате, провайдер
 * — свой: BYOK). Итог можно скопировать или сохранить заметкой в vault.
 */
export function ReflectSection({
  sessions,
  usage,
  apiSettings,
}: {
  sessions: Session[];
  usage: UsageEvent[];
  apiSettings: ApiSettings;
}) {
  const { t } = useLang();
  const [days, setDays] = useState<7 | 30>(7);
  const [facts, setFacts] = useState<{ ts: number }[]>([]);
  const [notes, setNotes] = useState<{ updated: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  // tick: перечитать память/заметки (после сохранения заметки счётчики меняются)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    memoryList()
      .then((f) => setFacts(f.map((x) => ({ ts: x.ts }))))
      .catch(() => {});
    notesList()
      .then((n) => setNotes(n.map((x) => ({ updated: x.updated }))))
      .catch(() => {});
  }, [tick]);

  const data = useMemo(
    () => buildReflect({ sessions, usage, facts, notes, nowMs: Date.now(), days }),
    // tick влияет через facts/notes (эффект их перечитывает)
    [sessions, usage, facts, notes, days],
  );

  const reflect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setSaved(false);
    try {
      const summary = buildReflectPrompt(data, {
        tasksCreated: t("reflect.lCreated"),
        tasksTouched: t("reflect.lTouched"),
        userMsgs: t("reflect.lMsgs"),
        tokens: t("reflect.lTokens"),
        facts: t("reflect.lFacts"),
        notes: t("reflect.lNotes"),
        stalled: t("reflect.lStalled"),
        inProgress: t("reflect.lInProgress"),
        pending: t("reflect.lPending"),
        none: t("reflect.lNone"),
      });
      const text = await chatOnce({
        baseUrl: apiSettings.base_url,
        apiKey: apiSettings.api_key,
        model: apiSettings.model,
        provider: apiSettings.provider,
        system: t("reflect.promptSystem"),
        user: `${t("reflect.promptIntro")}\n\n${summary}`,
        maxTokens: 600,
      });
      setResult(text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    // copyText — единый путь с фолбэком WebKitGTK (clipboard.ts)
    if (await copyText(result)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const saveNote = async () => {
    if (!result) return;
    try {
      const d = new Date();
      const stamp = `${dayKeyLocal(d)} ${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
      ).padStart(2, "0")}`;
      await notesWrite(`reflect-${dayKeyLocal(d)}-${d.getHours()}${d.getMinutes()}.md`, `# ${t("settings.reflect")} ${stamp}\n\n${result}\n`);
      setSaved(true);
      setTick((v) => v + 1);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      window.alert(String(e));
    }
  };

  const rows: { label: string; value: string }[] = [
    { label: t("reflect.lCreated"), value: String(data.tasksCreated) },
    { label: t("reflect.lTouched"), value: String(data.tasksTouched) },
    { label: t("reflect.lMsgs"), value: String(data.userMsgs) },
    {
      label: t("reflect.lTokens"),
      value: fmtTokens(data.tokens.prompt + data.tokens.completion),
    },
    { label: t("reflect.lFacts"), value: String(data.newFacts) },
    { label: t("reflect.lNotes"), value: String(data.notesTouched) },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.reflect")}</h3>

      {/* Период: 7 / 30 дней */}
      <div className="flex items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
        <span className="text-xs text-halo-muted">{t("reflect.period")}:</span>
        {([7, 30] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              days === d
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {t(d === 7 ? "reflect.days7" : "reflect.days30")}
          </button>
        ))}
      </div>

      {/* Сводные числа */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label} className="rounded-xl border border-halo-line px-3 py-2.5">
            <p className="text-[0.6875rem] leading-tight text-halo-muted">{r.label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-halo-text">{r.value}</p>
          </div>
        ))}
      </div>

      {/* Незавершённые планы: живой список того, что осталось доделать */}
      <div className="mt-3 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm font-medium text-halo-text">{t("reflect.stalledTitle")}</p>
        {data.stalled.length === 0 ? (
          <p className="mt-2 text-xs text-halo-muted/70">{t("reflect.stalledEmpty")}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {data.stalled.map((s) => (
              <li key={s.id} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-halo-text">{s.title}</span>
                {s.inProgress > 0 && (
                  <span className="shrink-0 rounded bg-halo-accent/10 px-1.5 py-0.5 text-[0.625rem] text-halo-accent">
                    {s.inProgress} {t("reflect.lInProgress")}
                  </span>
                )}
                <span className="shrink-0 rounded bg-halo-surface/70 px-1.5 py-0.5 text-[0.625rem] text-halo-muted">
                  {s.pending} {t("reflect.lPending")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Статистика: тепловая карта и тренд — диапазон общий с селектором выше.
          События считаются из всех чатов, сводка — за всё время */}
      <UsageSection
        sessions={sessions}
        rangeDays={days}
        onRangeChange={setDays}
        showHeader={false}
      />

      {/* Рефлексия: один вызов текущей модели поверх локальной сводки */}
      <div className="mt-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void reflect()}
            disabled={busy}
            className="rounded-lg border border-halo-accent/50 bg-halo-accent/10 px-3 py-1.5 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t("reflect.busy") : t("reflect.button")}
          </button>
          {result && (
            <>
              <button
                onClick={() => void copyResult()}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  copied
                    ? "border-emerald-400/50 text-emerald-400"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {copied ? (<><CheckIcon /> {t("reflect.copied")}</>) : t("reflect.copy")}
              </button>
              <button
                onClick={() => void saveNote()}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  saved
                    ? "border-emerald-400/50 text-emerald-400"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {saved ? (<><CheckIcon /> {t("reflect.savedNote")}</>) : t("reflect.saveNote")}
              </button>
            </>
          )}
        </div>
        {error && <p className="mt-2 break-words text-xs text-red-400">{error}</p>}
        {!result && !busy && !error && (
          <p className="mt-2 text-xs leading-relaxed text-halo-muted/70">{t("reflect.empty")}</p>
        )}
        {busy && <p className="mt-2 text-xs text-halo-muted">{t("reflect.busy")}</p>}
        {result && (
          <div className="scroll-slim mt-2 max-h-72 overflow-y-auto rounded-lg border border-halo-line/60 bg-halo-deep/60 px-3 py-2">
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-halo-text">{result}</p>
          </div>
        )}
        <p className="mt-2 text-[0.6875rem] leading-relaxed text-halo-muted/60">{t("reflect.privacy")}</p>
      </div>
    </div>
  );
}
