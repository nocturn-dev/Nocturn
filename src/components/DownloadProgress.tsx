/**
 * Плавающее окно скачивания моделей (whisper-диктовка / voice wake):
 * слушает progress-события бекенда и показывает тематизированную карточку
 * в правом нижнем углу. Цвета — токены halo: подтягивается темой сам,
 * никаких захардкоженных тонов (красный провала — семантика статуса,
 * сознательное исключение из halo-токенов). Раньше прогресс скачивания
 * был виден только сменой текста кнопки в настройках — окно показывает
 * ход явно.
 */

import { useEffect, useRef, useState } from "react";
import { localeTag, useLang } from "../locales";
import { STATUS_ERR } from "../statusColors";

interface DownloadEvent {
  /** dictation-progress (whisper) поле не шлёт — показываем общий тайтл */
  file?: string;
  received: number;
  total: number;
  /** Срыв загрузки: бекенд рапортует тем же событием — ошибки команды
   *  в это окно иначе не доходит */
  error?: string;
}

/** Источник события: у whisper и wake-моделей отдельные окна — два
 *  параллельных скачивания не должны делить одно состояние и таймер */
type Source = "dictation" | "voice";

interface Entry {
  event: DownloadEvent;
  done: boolean;
  failed: boolean;
}

const HIDE_AFTER_DONE_MS = 2500;
const SOURCES: { source: Source; event: string }[] = [
  { source: "dictation", event: "dictation-progress" },
  { source: "voice", event: "voice-progress" },
];

export default function DownloadProgress() {
  const { t, lang } = useLang();
  const [entries, setEntries] = useState<Map<Source, Entry>>(() => new Map());
  const hideTimers = useRef(new Map<Source, number>());

  useEffect(() => {
    let disposed = false;
    let unlistens: (() => void)[] = [];
    // Экземпляр Map стабилен (useRef создаёт один раз) — но правило хуков
    // требует локальной ссылки для cleanup
    const timers = hideTimers.current;
    // Подписка может не состояться (нет IPC-моста в превью) — окна просто
    // не будет, ронять приложение из-за этого нельзя
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      for (const { source, event } of SOURCES) {
        const off = await listen<DownloadEvent>(event, (e) => onProgress(source, e.payload));
        if (disposed) {
          off();
          return;
        }
        unlistens.push(off);
      }
    })().catch(() => {});
    function onProgress(source: Source, p: DownloadEvent) {
      if (typeof p?.received !== "number" || typeof p?.total !== "number") return;
      const failed = typeof p.error === "string" && p.error.length > 0;
      const done = !failed && p.total > 0 && p.received >= p.total;
      window.clearTimeout(timers.get(source));
      timers.delete(source);
      setEntries((prev) => new Map(prev).set(source, { event: p, done, failed }));
      if (done || failed) {
        // Финал (включая провал) держим на экране: его надо увидеть
        timers.set(
          source,
          window.setTimeout(() => {
            timers.delete(source);
            setEntries((prev) => {
              const next = new Map(prev);
              next.delete(source);
              return next;
            });
          }, HIDE_AFTER_DONE_MS),
        );
      }
    }
    return () => {
      disposed = true;
      for (const u of unlistens) u();
      unlistens = [];
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  if (entries.size === 0) return null;
  // Мегабайты в локали UI: ru видел «0.0» с точкой — десятичный разделитель
  // обязан следовать языку интерфейса
  const mb = (n: number) =>
    (n / 1048576).toLocaleString(localeTag(lang), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  const unit = lang === "ru" ? "МБ" : "MB";

  return (
    <div className="fixed bottom-4 right-4 z-[var(--halo-z-toast)] flex w-72 flex-col gap-2">
      {[...entries.entries()].map(([source, entry]) => {
        const { event, done, failed } = entry;
        // total неизвестен бекенду (нет content-length) — полоса без
        // процента, иначе окно вечно висит на «0.0 / 0.0 МБ»
        const indet = !done && !failed && event.total <= 0;
        const pct =
          event.total > 0 ? Math.min(100, Math.round((event.received / event.total) * 100)) : 0;
        return (
          <div
            key={source}
            role="status"
            className="anim-fade-up rounded-xl border border-halo-line bg-halo-raised/95 p-3.5 shadow-2xl"
          >
            <p className="text-xs font-medium text-halo-text">
              {done ? t("dl.done") : failed ? t("dl.failed") : t("dl.title")}
            </p>
            <p className="mt-0.5 truncate text-[0.625rem] text-halo-muted" title={event.file}>
              {event.file || t("dl.title")}
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-halo-deep">
              {indet ? (
                <div className="dl-indet h-full rounded-full bg-halo-accent" />
              ) : (
                <div
                  className="h-full rounded-full"
                  style={
                    failed
                      ? { width: "100%", background: STATUS_ERR }
                      : { width: `${pct}%` }
                  }
                />
              )}
            </div>
            <p
              className="mt-1 truncate text-right text-[0.625rem] tabular-nums text-halo-muted"
              title={failed ? event.error : undefined}
              style={failed ? { color: STATUS_ERR } : undefined}
            >
              {done ? (
                `${pct}%`
              ) : failed ? (
                (event.error ?? "").slice(0, 60)
              ) : (
                `${mb(event.received)} / ${mb(event.total)} ${unit} · ${pct}%`
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
