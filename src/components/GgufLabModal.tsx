/**
 * GGUF Lab (волна §28, PLAN.md): хирургия локальных GGUF-моделей.
 * Конвейер: pull (Ollama) → export (блоб → appdata/gguf) → inspect →
 * cut (post-flight внутри бекенда) → тест (llama-server) / импорт обратно
 * в Ollama. Прогресс — событие gguf-progress; все тяжёлые шаги под
 * Busy-гардом бекенда. Точка входа — Settings → API → «Локальные модели».
 * Токены halo — тема применяется сама; красный — семантика ошибок
 * (исключение из AGENTS.md).
 */

import { useCallback, useEffect, useState } from "react";
import {
  detectLocalRuntimes,
  ggufCancel,
  ggufCut,
  ggufExport,
  ggufInspect,
  ggufLabFiles,
  ggufLlamaDownload,
  ggufLlamaStatus,
  ggufOllamaImport,
  ggufPull,
  ggufServeStart,
  ggufServeStop,
  type GgufInspect,
  type GgufLabFile,
  type GgufLlamaStatus,
  type GgufProgress,
  type GgufServeInfo,
  type GgufSurgeryReport,
  type LocalModel,
} from "../api";
import { useLang } from "../locales";
import { useDelayedUnmount } from "../motion";
import { XSmallIcon } from "./cards/icons";

interface GgufLabModalProps {
  open: boolean;
  onClose: () => void;
  /** Подключить поднятый сервер к текущим настройкам чата */
  onUseAsChatProvider: (baseUrl: string, model: string) => void;
}

const fmtBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
};

export default function GgufLabModal({
  open,
  onClose,
  onUseAsChatProvider,
}: GgufLabModalProps) {
  const { t } = useLang();
  const [files, setFiles] = useState<GgufLabFile[]>([]);
  const [ollama, setOllama] = useState<LocalModel[] | null>(null);
  const [llama, setLlama] = useState<GgufLlamaStatus | null>(null);
  const [inspect, setInspect] = useState<GgufInspect | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<GgufProgress | null>(null);
  const [report, setReport] = useState<GgufSurgeryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pullName, setPullName] = useState("");
  const [ollamaName, setOllamaName] = useState("");
  const [serve, setServe] = useState<GgufServeInfo | null>(null);
  const [appliedUrl, setAppliedUrl] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  /** Обёртка действия: busy + ошибка в одну строку статуса */
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [fs, llamaStatus] = await Promise.all([ggufLabFiles(), ggufLlamaStatus()]);
    setFiles(fs);
    setLlama(llamaStatus);
    setOllama(await detectLocalRuntimes().then((r) => r.ollama));
  }, []);

  // Слушатель прогресса: успех фазы → рефреш (новый файл в хранилище)
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let off: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<GgufProgress>("gguf-progress", (e) => {
        const p = e.payload;
        setProgress(p);
        if (p.status === "success" || p.phase === "done") {
          void refresh();
        }
      });
      if (disposed) {
        un();
        return;
      }
      off = un;
    })();
    return () => {
      disposed = true;
      off?.();
    };
  }, [open, refresh]);

  useEffect(() => {
    if (open) {
      setError(null);
      void refresh();
    }
  }, [open, refresh]);

  const doPull = () =>
    run(async () => {
      const name = pullName.trim();
      if (!name) return;
      await ggufPull(name);
      setPullName("");
      await refresh();
    });

  const doExport = (m: LocalModel) =>
    run(async () => {
      setExportingId(m.id);
      try {
        await ggufExport(m.id);
        await refresh();
      } finally {
        setExportingId(null);
      }
    });

  const toggleInspect = (f: GgufLabFile) =>
    run(async () => {
      if (inspect?.name === f.name) {
        setInspect(null);
        setSelected(new Set());
        return;
      }
      const info = await ggufInspect(f.name);
      setInspect(info);
      setSelected(new Set());
      setReport(null);
    });

  const toggleLayer = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const doCut = () =>
    run(async () => {
      if (!inspect || selected.size === 0) return;
      const r = await ggufCut(inspect.name, [...selected].sort((a, b) => a - b));
      setReport(r);
      setInspect(null);
      setSelected(new Set());
      await refresh();
    });

  const doServe = (f: GgufLabFile) =>
    run(async () => {
      const info = await ggufServeStart(f.name);
      setServe(info);
      setAppliedUrl(null);
    });

  const doStop = () =>
    run(async () => {
      await ggufServeStop();
      setServe(null);
      setAppliedUrl(null);
    });

  const doOllamaImport = (f: GgufLabFile) =>
    run(async () => {
      const name = ollamaName.trim();
      if (!name) return;
      await ggufOllamaImport(f.name, name);
      setOllamaName("");
    });

  const doDownloadLlama = () =>
    run(async () => {
      await ggufLlamaDownload();
      setLlama(await ggufLlamaStatus());
    });

  // Отмена активной операции (бекенд гасит циклы, tmp подчищается)
  const doCancel = () => {
    void ggufCancel();
  };

  const hybrid = inspect
    ? inspect.flags.hybridSsm || inspect.flags.hybridConv
    : false;
  const lastLayer = inspect?.blockCount != null ? inspect.blockCount - 1 : -1;
  const layersShown = inspect?.layers ?? [];
  // Паттерн CompareModal: анимация выхода до unmount
  const show = useDelayedUnmount(open, 170);

  if (!show) return null;

  const progressLine = (() => {
    if (!progress) return null;
    if (progress.status === "success" || progress.phase === "done")
      return t("ggufLab.status.done");
    switch (progress.phase) {
      case "pull":
        return t("ggufLab.status.pull", { status: progress.status ?? "" });
      case "export":
        return t("ggufLab.status.export");
      case "plan":
        return t("ggufLab.status.plan");
      case "surgery":
        return t("ggufLab.status.surgery", {
          step: progress.step ?? 0,
          steps: progress.steps ?? 0,
        });
      case "import":
        return t("ggufLab.status.import", { status: progress.status ?? "" });
      case "download":
        return t("ggufLab.status.download");
      default:
        return null;
    }
  })();

  return (
    <div
      className={`fixed inset-0 z-[var(--halo-z-modal)] overflow-y-auto bg-black/50 p-4 backdrop-blur-sm ${
        open ? "anim-fade" : "anim-fade-out"
      }`}
      onClick={busy ? undefined : onClose}
    >
      <div
        className={`glass-pane mx-auto my-8 w-full max-w-4xl rounded-2xl border border-halo-line bg-halo-deep p-6 shadow-2xl ${
          open ? "anim-pop" : "anim-pop-out"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between">
          <h1 className="text-2xl font-bold text-halo-text">{t("ggufLab.title")}</h1>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-40"
          >
            <XSmallIcon />
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-halo-muted">
          {t("ggufLab.desc")}
        </p>

        {/* Строка статуса: прогресс активной операции / ошибка */}
        {(progressLine || error || busy) && (
          <div className="mb-4 rounded-xl border border-halo-line bg-halo-surface p-3 text-xs">
            {busy && progressLine && (
              <div className="mb-1 flex items-center gap-2 text-halo-text">
                <span className="inline-block size-2 animate-pulse rounded-full bg-halo-accent" />
                <span className="flex-1 truncate">{progressLine}</span>
                <button
                  onClick={doCancel}
                  className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                >
                  ✕
                </button>
              </div>
            )}
            {busy && !progressLine && (
              <div className="text-halo-muted">{t("ggufLab.busy")}</div>
            )}
            {error && (
              <div className="break-all text-red-400">{error}</div>
            )}
          </div>
        )}

        {/* Pull через Ollama */}
        <div className="mb-3 rounded-xl border border-halo-line p-3">
          <div className="mb-2 text-sm font-medium text-halo-text">
            {t("ggufLab.pullLabel")}
          </div>
          <div className="flex gap-2">
            <input
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void doPull();
              }}
              placeholder={t("ggufLab.pullPlaceholder")}
              disabled={busy}
              className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-60"
            />
            <button
              onClick={() => void doPull()}
              disabled={busy || !pullName.trim()}
              className="shrink-0 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover disabled:opacity-50"
            >
              ↓
            </button>
          </div>
          {ollama !== null && ollama.length > 0 && (
            <>
              <div className="mb-1 mt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-halo-muted">
                {t("ggufLab.ollamaModels")}
              </div>
              <div className="scroll-slim max-h-36 space-y-1 overflow-y-auto">
                {ollama.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-halo-muted"
                  >
                    <span className="truncate font-mono">{m.id}</span>
                    {m.sizeBytes !== null && (
                      <span className="shrink-0 text-[0.5625rem] text-halo-muted/70">
                        {fmtBytes(m.sizeBytes)}
                      </span>
                    )}
                    <button
                      onClick={() => void doExport(m)}
                      disabled={busy}
                      className="ml-auto shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                    >
                      {exportingId === m.id ? "…" : t("ggufLab.export")}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Хранилище */}
        <div className="mb-3 rounded-xl border border-halo-line p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-halo-text">
              {t("ggufLab.files")}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => void refresh()}
              disabled={busy}
              className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
            >
              {t("ggufLab.refresh")}
            </button>
          </div>
          {files.length === 0 ? (
            <p className="text-xs text-halo-muted">{t("ggufLab.filesEmpty")}</p>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div key={f.name} className="rounded-md px-2 py-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-halo-text">
                      {f.name}
                    </span>
                    <span className="shrink-0 text-[0.5625rem] text-halo-muted/70">
                      {fmtBytes(f.sizeBytes)}
                    </span>
                    <span className="flex-1" />
                    <button
                      onClick={() => void toggleInspect(f)}
                      disabled={busy}
                      className={`shrink-0 rounded-md border px-2 py-0.5 text-[0.625rem] transition-colors disabled:opacity-50 ${
                        inspect?.name === f.name
                          ? "border-halo-accent/60 bg-halo-accent/15 text-halo-accent"
                          : "border-halo-line text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                      }`}
                    >
                      {t("ggufLab.inspect")}
                    </button>
                    <button
                      onClick={() => void doServe(f)}
                      disabled={busy || serve !== null}
                      className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                    >
                      {t("ggufLab.test")}
                    </button>
                    <button
                      onClick={() => void doOllamaImport(f)}
                      disabled={busy}
                      className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                    >
                      {t("ggufLab.toOllama")}
                    </button>
                  </div>
                  {/* Ollama-имя для импорта конкретного файла */}
                  {inspect?.name === f.name && !hybrid && (
                    <div className="mt-1.5 flex items-center gap-2 pl-2">
                      <input
                        value={ollamaName}
                        onChange={(e) => setOllamaName(e.target.value)}
                        placeholder={t("ggufLab.ollamaNamePlaceholder")}
                        disabled={busy}
                        className="min-w-0 flex-1 rounded-md border border-halo-line bg-halo-surface px-2 py-1 font-mono text-[0.6875rem] text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-60"
                      />
                      <button
                        onClick={() => void doOllamaImport(f)}
                        disabled={busy || !ollamaName.trim()}
                        className="shrink-0 rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                      >
                        ↵
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Инспектор: слои выбранного файла */}
        {inspect && (
          <div className="mb-3 rounded-xl border border-halo-line p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-halo-text">
                {t("ggufLab.layers", { n: inspect.layers.length })}
              </span>
              <span className="font-mono text-[0.625rem] text-halo-muted/70">
                {inspect.architecture ?? "?"} · GGUF v{inspect.version} ·{" "}
                {t("ggufLab.tensorCount", {
                  n: inspect.tensorCount,
                  size: fmtBytes(inspect.totalTensorBytes),
                })}
              </span>
              <span className="flex-1" />
              {inspect.flags.swa && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-400">
                  {t("ggufLab.flags.swa")}
                </span>
              )}
              {inspect.flags.moe && (
                <span className="rounded bg-halo-accent/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-halo-accent">
                  {t("ggufLab.flags.moe")}
                </span>
              )}
              {inspect.flags.nextn && (
                <span className="rounded bg-halo-accent/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-halo-accent">
                  {t("ggufLab.flags.nextn")}
                </span>
              )}
              {hybrid && (
                <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-red-400">
                  {t("ggufLab.flags.hybrid")}
                </span>
              )}
            </div>
            {inspect.warnings.length > 0 && (
              <div className="mb-2 space-y-0.5 text-[0.6875rem] text-amber-400">
                {inspect.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
            {!hybrid && (
              <>
                <div className="mb-1 flex items-center gap-2 text-[0.625rem] text-halo-muted">
                  <span>
                    {t("ggufLab.selected", {
                      n: selected.size,
                      total: inspect.layers.length,
                    })}
                  </span>
                  <span className="flex-1" />
                  <span>{t("ggufLab.cutHint")}</span>
                </div>
                {selected.has(lastLayer) && (
                  <div className="mb-1 text-[0.6875rem] text-amber-400">
                    {t("ggufLab.lastLayerWarn")}
                  </div>
                )}
                <div className="scroll-slim max-h-64 space-y-0.5 overflow-y-auto">
                  {layersShown.map((l) => (
                    <label
                      key={l.index}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-halo-hover"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(l.index)}
                        onChange={() => toggleLayer(l.index)}
                        disabled={busy}
                        className="accent-halo-accent"
                      />
                      <span className="font-mono text-halo-text">
                        {t("ggufLab.layerN", { n: l.index })}
                      </span>
                      <span className="text-[0.5625rem] text-halo-muted/70">
                        {t("ggufLab.tensorCount", {
                          n: l.tensors.length,
                          size: fmtBytes(l.totalBytes),
                        })}
                      </span>
                      {l.hasMoeExperts && (
                        <span className="rounded bg-halo-accent/15 px-1 text-[0.5625rem] text-halo-accent">
                          {t("ggufLab.flags.moe")}
                        </span>
                      )}
                      {l.hasNextn && (
                        <span className="rounded bg-halo-accent/15 px-1 text-[0.5625rem] text-halo-accent">
                          {t("ggufLab.flags.nextn")}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void doCut()}
                    disabled={busy || selected.size === 0}
                    className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover disabled:opacity-50"
                  >
                    {t("ggufLab.cut", { n: selected.size })}
                  </button>
                  <span className="text-[0.625rem] text-halo-muted">
                    {t("ggufLab.globalTensors", {
                      n: inspect.globalTensors.length,
                      size: fmtBytes(
                        inspect.totalTensorBytes -
                          inspect.layers.reduce((s, l) => s + l.totalBytes, 0),
                      ),
                    })}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Отчёт последней резки */}
        {report && (
          <div className="mb-3 rounded-xl border border-emerald-400/30 p-3">
            <div className="mb-1.5 text-sm font-medium text-halo-text">
              {t("ggufLab.report.title")}
            </div>
            <div className="text-xs text-halo-text">
              {t("ggufLab.report.output", {
                name: report.output,
                size: fmtBytes(report.outputSizeBytes),
              })}
            </div>
            <div className="mt-1 text-[0.6875rem] text-halo-muted">
              {t("ggufLab.report.verified", {
                tensors: report.verified.tensorsChecked,
                bytes: report.verified.bytesCompared.toLocaleString(),
              })}
            </div>
            {report.kvEdits.length > 0 && (
              <>
                <div className="mt-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-halo-muted">
                  {t("ggufLab.report.kvEdits")}
                </div>
                {report.kvEdits.map((e, i) => (
                  <div key={i} className="font-mono text-[0.6875rem] text-halo-muted">
                    {e}
                  </div>
                ))}
              </>
            )}
            {report.warnings.length > 0 && (
              <>
                <div className="mt-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-amber-400">
                  {t("ggufLab.report.warnings")}
                </div>
                {report.warnings.map((w, i) => (
                  <div key={i} className="text-[0.6875rem] text-amber-400">
                    {w}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Тестовый рантайм: llama-server */}
        <div className="rounded-xl border border-halo-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-halo-text">
              {serve
                ? t("ggufLab.serveRunning", {
                    port: serve.port,
                    model: serve.model,
                  })
                : llama?.resolvedPath
                  ? t("ggufLab.llamaFound")
                  : t("ggufLab.llamaMissing")}
            </span>
            <span className="flex-1" />
            {serve ? (
              <>
                <button
                  onClick={() => {
                    onUseAsChatProvider(serve.baseUrl, serve.model);
                    setAppliedUrl(serve.baseUrl);
                  }}
                  className="rounded-md border border-halo-accent/60 bg-halo-accent/15 px-2 py-0.5 text-[0.625rem] text-halo-accent transition-colors hover:bg-halo-accent/25"
                >
                  {t("ggufLab.serveUse")}
                </button>
                <button
                  onClick={() => void doStop()}
                  disabled={busy}
                  className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                >
                  {t("ggufLab.serveStop")}
                </button>
              </>
            ) : (
              !llama?.resolvedPath && (
                <button
                  onClick={() => void doDownloadLlama()}
                  disabled={busy}
                  className="rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-50"
                >
                  {t("ggufLab.llamaDownload")}
                </button>
              )
            )}
          </div>
          {appliedUrl && (
            <div className="mt-1 text-[0.6875rem] text-emerald-400">
              {t("ggufLab.serveApplied", { url: appliedUrl })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
