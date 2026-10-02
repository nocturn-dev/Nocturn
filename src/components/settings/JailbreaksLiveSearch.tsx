import { useMemo, useState } from "react";
import { useLang } from "../../locales";
import {
  cachedEntries,
  fetchAllSources,
  JB_SOURCES,
  type JbRemoteEntry,
} from "../../jbSources";
import { dedupImports } from "../../jbImport";
import { searchJailbreaks } from "../../jailbreaks";
import { importFetchUrl } from "../../api";
import type { JailbreakEntry } from "../../jailbreaks";

const PREVIEW_CAP = 200;

/** Живой поиск по белому списку GitHub-источников. Приватность: текст
 * запроса никуда не отправляется — источники скачиваются целиком (один
 * клик), парсятся и фильтруются локально; кэш живёт в памяти сессии. */
export function JailbreaksLiveSearch({
  entries,
  onChange,
}: {
  entries: JailbreakEntry[];
  onChange: (list: JailbreakEntry[]) => void;
}) {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [done, setDone] = useState("");
  // Пул в state: кэш — модульная мутабельная мапа, реакт про неё не знает,
  // поэтому после загрузки перечитываем явно (setPool триггерит ререндер)
  const [pool, setPool] = useState<JbRemoteEntry[]>(() => cachedEntries());
  const warm = pool.length > 0;

  const remoteEntries = useMemo(
    () =>
      pool.map((e, i) => ({
        id: `remote-${i}`,
        name: e.name,
        model: e.model,
        text: e.text,
        reasoning: "any" as const,
        year: e.year,
        tags: e.tags,
        createdAt: 0,
        updatedAt: 0,
        // поля живого поиска: дженерик searchJailbreaks их не теряет
        sourceLabel: e.sourceLabel,
        path: e.path,
      })),
    [pool],
  );

  const results = useMemo(
    () =>
      searchJailbreaks(remoteEntries, {
        query: query.trim(),
        model: "",
        year: "",
        sort: "relevance",
      }),
    [remoteEntries, query],
  );
  const shown = results.slice(0, PREVIEW_CAP);
  const selCount = results.filter((e) => selIds.has(e.id)).length;

  const load = async () => {
    setLoading(true);
    setErrors([]);
    setDone("");
    setSelIds(new Set());
    try {
      const errs = await fetchAllSources(importFetchUrl, (p) =>
        setProgress(
          p.done >= p.total
            ? ""
            : t("jb.liveLoading", {
                i: String(p.done + 1),
                n: String(p.total),
                src: p.current,
              }),
        ),
      );
      setErrors(errs);
      setPool(cachedEntries());
      setSelIds(new Set());
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  const toggle = (id: string) =>
    setSelIds((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doImport = () => {
    const chosen = pool.filter((_, i) => selIds.has(`remote-${i}`));
    if (chosen.length === 0) return;
    const { toAdd, skippedDup } = dedupImports(entries, chosen, Date.now());
    if (toAdd.length > 0) onChange([...entries, ...toAdd]);
    setDone(t("jb.importDone", { n: String(toAdd.length), d: String(skippedDup) }));
    setSelIds(new Set());
  };

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-halo-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs font-medium text-halo-text">
          {t("jb.liveTitle")}
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:opacity-40"
        >
          {warm ? t("jb.liveRefresh") : t("jb.liveSearch")}
        </button>
      </div>
      <p className="text-[0.625rem] leading-relaxed text-halo-muted/70">
        {t("jb.liveHint", { n: String(JB_SOURCES.length) })}
      </p>
      {loading && <p className="text-xs text-halo-muted">{progress || t("jb.importBusy")}</p>}
      {errors.length > 0 && (
        <div className="space-y-0.5">
          {errors.map((e) => (
            <p key={e} className="text-[0.625rem] leading-relaxed text-red-400">
              {e}
            </p>
          ))}
        </div>
      )}
      {done && <p className="text-xs leading-relaxed text-emerald-400">{done}</p>}

      {warm && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("jb.searchPh")}
            className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-[0.625rem] text-halo-muted">
              {t("jb.foundOf", { n: String(results.length), m: String(pool.length) })}
            </p>
            <button
              onClick={() => setSelIds(new Set(results.map((e) => e.id)))}
              className="shrink-0 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("jb.importSelectAll")}
            </button>
          </div>
          <div className="scroll-slim max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {shown.map((e) => (
              <button
                key={e.id}
                onClick={() => toggle(e.id)}
                className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  selIds.has(e.id)
                    ? "border-halo-accent/50 bg-halo-surface/60"
                    : "border-halo-line bg-halo-surface/30 hover:border-halo-muted/40"
                }`}
              >
                <span
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded border ${
                    selIds.has(e.id) ? "border-halo-accent bg-halo-accent" : "border-halo-line"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-halo-text">{e.name}</span>
                    {e.model && (
                      <span className="rounded bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
                        {e.model}
                      </span>
                    )}
                    {e.year && (
                      <span className="rounded bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
                        {e.year}
                      </span>
                    )}
                    <span className="text-[0.5625rem] text-halo-muted/60">{e.sourceLabel}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[0.6875rem] leading-relaxed text-halo-muted">
                    {e.text}
                  </span>
                </span>
              </button>
            ))}
            {results.length > shown.length && (
              <p className="text-center text-[0.625rem] text-halo-muted">
                {t("jb.importPreviewCapped", { m: String(results.length) })}
              </p>
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={doImport}
              disabled={selCount === 0}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("jb.liveImport", { n: String(selCount) })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
