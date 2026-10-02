import { useState } from "react";
import { useLang } from "../../locales";
import {
  dedupImports,
  parseJbImport,
  type JbImportDraft,
} from "../../jbImport";
import { importFetchUrl, importTextRead, pickImportFile } from "../../api";
import type { JailbreakEntry } from "../../jailbreaks";

interface ParsedState {
  drafts: JbImportDraft[];
  format: string;
  truncated: boolean;
  skippedRows: number;
  source: string;
  selected: boolean[];
}

/** Панель импорта в карточке джейлбрейков: файл или ссылка → разбор →
 * предпросмотр с галочками → дедуп и добавление. Чтение файла и сеть
 * (одиночный GET по явному клику) — через гардалы importer.rs. */
export function JailbreaksImport({
  entries,
  onChange,
}: {
  entries: JailbreakEntry[];
  onChange: (list: JailbreakEntry[]) => void;
}) {
  const { t } = useLang();
  const [urlMode, setUrlMode] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [parsed, setParsed] = useState<ParsedState | null>(null);
  const [done, setDone] = useState("");

  const load = async (getText: () => Promise<string>, source: string) => {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const text = await getText();
      const r = parseJbImport(text, source);
      if (r.drafts.length === 0) {
        setError(t("jb.importBad"));
        setParsed(null);
        return;
      }
      setParsed({
        ...r,
        source,
        selected: r.drafts.map(() => true),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setParsed(null);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    try {
      const path = await pickImportFile();
      if (!path) return;
      const name = path.split(/[\\/]/).pop() ?? path;
      await load(() => importTextRead(path), name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const fetchUrl = async () => {
    if (!url.trim()) return;
    // имя для TXT-фолбэка: последний сегмент пути без хвостовых параметров
    const name = (url.split(/[?#]/)[0] ?? url).split("/").filter(Boolean).pop() ?? "import";
    await load(() => importFetchUrl(url.trim()), name);
  };

  const toggle = (i: number) =>
    setParsed((p) =>
      p ? { ...p, selected: p.selected.map((s, j) => (j === i ? !s : s)) } : p,
    );

  const doImport = () => {
    if (!parsed) return;
    const selected = parsed.drafts.filter((_, i) => parsed.selected[i]);
    if (selected.length === 0) return;
    const { toAdd, skippedDup } = dedupImports(entries, selected, Date.now());
    if (toAdd.length > 0) onChange([...entries, ...toAdd]);
    setDone(
      t("jb.importDone", { n: String(toAdd.length), d: String(skippedDup) }),
    );
    setParsed(null);
    setUrl("");
  };

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-halo-line p-3">
      <p className="text-xs font-medium text-halo-text">{t("jb.importTitle")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={pickFile}
          disabled={busy}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:opacity-40"
        >
          {t("jb.importFile")}
        </button>
        <button
          onClick={() => setUrlMode((v) => !v)}
          disabled={busy}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:opacity-40"
        >
          {t("jb.importUrl")}
        </button>
        <span className="min-w-0 flex-1 text-[0.625rem] leading-tight text-halo-muted/70">
          {t("jb.importHint")}
        </span>
      </div>
      {urlMode && (
        <div className="flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void fetchUrl();
            }}
            placeholder={t("jb.importUrlPh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <button
            onClick={fetchUrl}
            disabled={busy || !url.trim()}
            className="shrink-0 rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("jb.importFetch")}
          </button>
        </div>
      )}
      {busy && <p className="text-xs text-halo-muted">{t("jb.importBusy")}</p>}
      {error && <p className="text-xs leading-relaxed text-red-400">{error}</p>}
      {done && <p className="text-xs leading-relaxed text-emerald-400">{done}</p>}
      {parsed && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-halo-muted">
              {t("jb.importParseOk", {
                n: String(parsed.drafts.length),
                fmt: parsed.format,
                d: String(
                  // дубли уже видны после разбора — счёт появится при импорте;
                  // здесь честно показываем отброшенные разбором строки
                  parsed.skippedRows,
                ),
              })}
              {parsed.truncated ? ` · ${t("jb.importTruncated")}` : ""}
            </p>
            <button
              onClick={() => setParsed({ ...parsed, selected: parsed.selected.map(() => true) })}
              className="shrink-0 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("jb.importSelectAll")}
            </button>
            <button
              onClick={() => setParsed({ ...parsed, selected: parsed.selected.map(() => false) })}
              className="shrink-0 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("jb.importSelectNone")}
            </button>
          </div>
          <div className="scroll-slim max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {parsed.drafts.slice(0, 200).map((d, i) => (
              <button
                key={i}
                onClick={() => toggle(i)}
                className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  parsed.selected[i]
                    ? "border-halo-accent/50 bg-halo-surface/60"
                    : "border-halo-line bg-halo-surface/30 opacity-60"
                }`}
              >
                <span
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded border ${
                    parsed.selected[i]
                      ? "border-halo-accent bg-halo-accent"
                      : "border-halo-line"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-halo-text">
                      {d.name || d.text.slice(0, 40)}
                    </span>
                    {d.model && (
                      <span className="rounded bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
                        {d.model}
                      </span>
                    )}
                    {d.year && (
                      <span className="rounded bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
                        {d.year}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[0.6875rem] leading-relaxed text-halo-muted">
                    {d.text}
                  </span>
                </span>
              </button>
            ))}
            {parsed.drafts.length > 200 && (
              <p className="text-center text-[0.625rem] text-halo-muted">
                {t("jb.importPreviewCapped", { m: String(parsed.drafts.length) })}
              </p>
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={doImport}
              disabled={!parsed.selected.some(Boolean)}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("jb.importDo", {
                n: String(parsed.selected.filter(Boolean).length),
              })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
