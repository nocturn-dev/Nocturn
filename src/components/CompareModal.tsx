/**
 * Сравнение моделей бок-о-бок: один промпт уходит параллельно в 2–3
 * подключения (активное + профили), ответы стримятся в колонки с метриками
 * (время до первого токена, токены, общее время). Запросы — тот же
 * chat_stream, что и у обычного чата, напрямую к настроенным провайдерам:
 * никаких новых сетевых адресов (принцип Nocturn). Инструментов нет —
 * сравнивается именно чистая генерация.
 */

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDelayedUnmount } from "../motion";
import {
  abortChat,
  chatStream,
  type ApiProfile,
  type ApiSettings,
  type ChatMsgParam,
  type ChatUsage,
} from "../api";
import { useLang } from "../locales";
import ProviderIcon, { shortModelName } from "./ProviderIcon";

interface CompareModalProps {
  open: boolean;
  onClose: () => void;
  /** Кандидаты: ключи уже расшифрованы бекендом при загрузке профилей */
  profiles: ApiProfile[];
  current: ApiSettings;
}

interface Target {
  key: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
}

interface LaneState {
  text: string;
  running: boolean;
  error: string | null;
  /** Время до первого токена, мс */
  ttft: number | null;
  totalMs: number | null;
  usage: ChatUsage | null;
}

const EMPTY_LANE: LaneState = {
  text: "",
  running: false,
  error: null,
  ttft: null,
  totalMs: null,
  usage: null,
};

const MAX_LANES = 3;

/** Ссылки из ответа — во внешнее окно (как в карточке ответа) */
function CompareLink(props: ComponentPropsWithoutRef<"a">) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

export default function CompareModal({ open, onClose, profiles, current }: CompareModalProps) {
  const { t } = useLang();
  const show = useDelayedUnmount(open, 170);
  const [prompt, setPrompt] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [lanes, setLanes] = useState<Record<string, LaneState>>({});
  const [active, setActive] = useState<Target[]>([]);
  const [running, setRunning] = useState(false);
  const reqIdsRef = useRef<string[]>([]);
  const remainingRef = useRef(0);

  // Цели и разумный дефолт выбора (первые две) — на каждое открытие
  useEffect(() => {
    if (!open) return;
    const list: Target[] = [
      {
        key: "current",
        label: t("cmp.current"),
        baseUrl: current.base_url,
        apiKey: current.api_key,
        model: current.model,
        provider: current.provider,
      },
      ...profiles.map((p) => ({
        key: p.id,
        label: p.name,
        baseUrl: p.base_url,
        apiKey: p.api_key,
        model: p.model,
        provider: p.provider,
      })),
    ];
    setTargets(list);
    setSelected(
      list
        .slice(0, 2)
        .map((x) => x.key)
        .filter((k) => k !== "current" || current.model.trim() !== ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setLane = (key: string, patch: Partial<LaneState>) => {
    setLanes((prev) => {
      const base = prev[key] ?? EMPTY_LANE;
      return { ...prev, [key]: { ...base, ...patch } };
    });
  };

  // Дельты полос батчатся через rAF — тот же C17-паттерн, что в useAgentRun:
  // setLanes на каждую SSE-дельту (до ~100+/сек × 3 полосы) ре-рендерил
  // модалку целиком на каждую порцию токенов
  const laneBufRef = useRef<Map<string, string>>(new Map());
  const laneRafRef = useRef(0);
  const laneTimerRef = useRef<number | null>(null);

  const flushLanes = () => {
    laneRafRef.current = 0;
    if (laneTimerRef.current !== null) {
      window.clearTimeout(laneTimerRef.current);
      laneTimerRef.current = null;
    }
    const buf = laneBufRef.current;
    if (buf.size === 0) return;
    const pending = [...buf.entries()];
    buf.clear();
    setLanes((prev) => {
      let next = prev;
      for (const [key, delta] of pending) {
        const base = next[key] ?? EMPTY_LANE;
        next = { ...next, [key]: { ...base, text: base.text + delta } };
      }
      return next;
    });
  };

  const scheduleLaneFlush = () => {
    if (laneRafRef.current || laneTimerRef.current !== null) return;
    if (typeof requestAnimationFrame === "function" && !document.hidden) {
      laneRafRef.current = requestAnimationFrame(flushLanes);
    } else {
      // C17: в свёрнутом/перекрытом окне rAF не тикает — фолбэк на таймер
      laneTimerRef.current = window.setTimeout(flushLanes, 250);
    }
  };

  // Отложенный флаж пережил компонент — тикать в размонтированный нечего
  useEffect(() => {
    return () => {
      if (laneRafRef.current) cancelAnimationFrame(laneRafRef.current);
      if (laneTimerRef.current !== null) window.clearTimeout(laneTimerRef.current);
    };
  }, []);

  const laneFinished = (key: string, totalMs: number, error: string | null) => {
    // Хвостовые дельты — в ленту ДО статуса «готово», иначе последний кусок
    // ответа потеряется в буфере
    flushLanes();
    setLane(key, { running: false, totalMs, error });
    remainingRef.current -= 1;
    if (remainingRef.current <= 0) setRunning(false);
  };

  const stopAll = () => {
    reqIdsRef.current.forEach((rid) => void abortChat(rid).catch(() => {}));
  };

  const handleClose = () => {
    if (running) stopAll();
    onClose();
  };

  // Esc — закрыть (и остановить прогон)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running]);

  const run = () => {
    const chosen = targets.filter((tg) => selected.includes(tg.key));
    const clean = prompt.trim();
    if (running || chosen.length === 0 || clean === "") return;
    const stamp = Date.now();
    const ridByKey = new Map<string, string>();
    const initial: Record<string, LaneState> = {};
    const reqIds: string[] = [];
    for (const tg of chosen) {
      const rid = `cmp-${stamp}-${tg.key}`;
      ridByKey.set(tg.key, rid);
      reqIds.push(rid);
      initial[tg.key] = {
        text: "",
        running: true,
        error: null,
        ttft: null,
        totalMs: null,
        usage: null,
      };
    }
    setLanes(initial);
    // Буфер от прошлого прогона не должен втекать в новые полосы
    laneBufRef.current.clear();
    setActive(chosen);
    setRunning(true);
    remainingRef.current = chosen.length;
    reqIdsRef.current = reqIds;

    for (const tg of chosen) {
      const rid = ridByKey.get(tg.key)!;
      const t0 = performance.now();
      let firstDelta = true;
      const messages: ChatMsgParam[] = [{ role: "user", content: clean }];
      void chatStream({
        requestId: rid,
        baseUrl: tg.baseUrl,
        apiKey: tg.apiKey,
        model: tg.model,
        provider: tg.provider,
        messages,
        onDelta: (delta) => {
          if (firstDelta) {
            firstDelta = false;
            setLane(tg.key, { ttft: Math.round(performance.now() - t0) });
          }
          // Дельта — в буфер, рендер по rAF (см. flushLanes выше)
          laneBufRef.current.set(
            tg.key,
            (laneBufRef.current.get(tg.key) ?? "") + delta,
          );
          scheduleLaneFlush();
        },
        onThought: () => {},
        onUsage: (usage) => setLane(tg.key, { usage }),
      })
        .then(() => laneFinished(tg.key, Math.round(performance.now() - t0), null))
        .catch((e) => laneFinished(tg.key, Math.round(performance.now() - t0), String(e)));
    }
  };

  const toggle = (key: string) => {
    setSelected((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : prev.length >= MAX_LANES
          ? prev
          : [...prev, key],
    );
  };

  const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const isAborted = (e: string): boolean => e.toLowerCase().includes("abort");

  if (!show) return null;

  return (
    <div
      className={`fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm ${open ? "anim-fade" : "anim-fade-out"}`}
      onClick={handleClose}
    >
      <div
        className={`glass-pane mx-auto my-8 w-full max-w-6xl rounded-2xl border border-halo-line bg-halo-deep p-6 shadow-2xl ${open ? "anim-pop" : "anim-pop-out"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="mb-1 flex items-start justify-between">
          <h1 className="text-2xl font-bold text-halo-text">{t("cmp.title")}</h1>
          <button
            onClick={handleClose}
            title={t("common.close")}
            className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-halo-muted">{t("cmp.hint")}</p>

        {/* Подключения-кандидаты */}
        <div className="mb-3 flex flex-wrap gap-2">
          {targets.map((tg) => {
            const on = selected.includes(tg.key);
            return (
              <button
                key={tg.key}
                onClick={() => toggle(tg.key)}
                disabled={running}
                title={`${tg.baseUrl} → ${tg.model}`}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                  on
                    ? "border-halo-accent/60 bg-halo-accent/10 text-halo-text"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                <ProviderIcon modelId={tg.model} size={13} />
                <span className="max-w-36 truncate font-medium">{tg.label}</span>
                <span className="max-w-32 truncate text-[10px] text-halo-muted/70">
                  {shortModelName(tg.model)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Общий промпт */}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter — запуск; isComposing: IME-энтер не отправляет
            if (
              (e.key === "Enter") &&
              (e.ctrlKey || e.metaKey) &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              run();
            }
          }}
          rows={3}
          placeholder={t("cmp.promptPh")}
          disabled={running}
          className="mb-3 w-full resize-y rounded-xl border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-60"
        />

        {/* Кнопка пуска/останова */}
        <div className="mb-4 flex items-center gap-2">
          {running ? (
            <button
              onClick={stopAll}
              className="flex items-center gap-1.5 rounded-lg bg-red-400/15 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-400/25"
            >
              ■ {t("cmp.stop")}
            </button>
          ) : (
            <button
              onClick={run}
              disabled={selected.length === 0 || prompt.trim() === ""}
              className="rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              ▶ {t("cmp.run")}
            </button>
          )}
          {selected.length === 0 && (
            <span className="text-xs text-halo-muted/70">{t("cmp.empty")}</span>
          )}
          <span className="ml-auto text-[10px] text-halo-muted/50">Ctrl+Enter</span>
        </div>

        {/* Колонки ответов */}
        {active.length > 0 && (
          <div className="overflow-x-auto">
            <div className="flex min-w-max gap-3 lg:min-w-0">
              {active.map((tg) => {
                const lane = lanes[tg.key];
                if (!lane) return null;
                return (
                  <div
                    key={tg.key}
                    className="flex min-w-72 flex-1 flex-col rounded-xl border border-halo-line/70 bg-halo-surface/40"
                  >
                    <div className="flex items-center gap-1.5 border-b border-halo-line/50 px-3 py-2">
                      <ProviderIcon modelId={tg.model} size={14} />
                      <span className="truncate text-xs font-semibold text-halo-text">
                        {tg.label}
                      </span>
                      <span className="truncate text-[10px] text-halo-muted/70">
                        {shortModelName(tg.model)}
                      </span>
                      <span className="ml-auto shrink-0">
                        {lane.running ? (
                          <span className="typing-dot size-1.5 rounded-full bg-halo-accent" />
                        ) : lane.error ? (
                          <span className="text-xs text-red-400">✕</span>
                        ) : (
                          <span className="text-xs text-emerald-400">✓</span>
                        )}
                      </span>
                    </div>
                    <div className="markdown scroll-slim max-h-[46vh] min-h-24 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-halo-text">
                      {lane.text !== "" ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{ a: CompareLink }}
                        >
                          {lane.text}
                        </ReactMarkdown>
                      ) : lane.running ? (
                        <span className="typing-dot size-1.5 rounded-full bg-halo-muted" />
                      ) : lane.error ? (
                        <span className="text-xs text-red-400">
                          {isAborted(lane.error) ? t("cmp.stopped") : lane.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3 border-t border-halo-line/50 px-3 py-1.5 text-[10px] tabular-nums text-halo-muted/70">
                      <span title={t("cmp.ttft")}>
                        {t("cmp.ttft")}:{" "}
                        {lane.ttft !== null ? fmtSec(lane.ttft) : "—"}
                      </span>
                      <span title={t("cmp.time")}>
                        {t("cmp.time")}:{" "}
                        {lane.totalMs !== null ? fmtSec(lane.totalMs) : "—"}
                      </span>
                      <span className="ml-auto" title={t("cmp.tokens")}>
                        {lane.usage
                          ? `↑${lane.usage.prompt} ↓${lane.usage.completion}`
                          : "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
