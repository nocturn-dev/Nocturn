/**
 * Плавающее окно скачивания моделей (whisper-диктовка / voice wake):
 * слушает progress-события бекенда и показывает тематизированную карточку
 * в правом нижнем углу. Цвета — токены halo: подтягивается темой сам,
 * никаких захардкоженных тонов. Раньше прогресс скачивания был виден
 * только сменой текста кнопки в настройках — окно показывает ход явно.
 */

import { useEffect, useRef, useState } from "react";
import { useLang } from "../locales";

interface DownloadEvent {
  file: string;
  received: number;
  total: number;
}

const HIDE_AFTER_DONE_MS = 2500;

export default function DownloadProgress() {
  const { t, lang } = useLang();
  const [progress, setProgress] = useState<DownloadEvent | null>(null);
  const [done, setDone] = useState(false);
  const hideTimer = useRef(0);

  useEffect(() => {
    let disposed = false;
    let unlistens: (() => void)[] = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<DownloadEvent>("dictation-progress", (e) => onProgress(e.payload));
      if (disposed) {
        off();
        return;
      }
      unlistens.push(off);
      const off2 = await listen<DownloadEvent>("voice-progress", (e) => onProgress(e.payload));
      if (disposed) {
        off2();
        return;
      }
      unlistens.push(off2);
    })();
    function onProgress(p: DownloadEvent) {
      if (typeof p?.received !== "number") return;
      window.clearTimeout(hideTimer.current);
      setDone(p.total > 0 && p.received >= p.total);
      setProgress(p);
      if (p.total > 0 && p.received >= p.total) {
        // Финал держим на экране: пользователь должен увидеть завершение
        hideTimer.current = window.setTimeout(() => setProgress(null), HIDE_AFTER_DONE_MS);
      }
    }
    return () => {
      disposed = true;
      for (const u of unlistens) u();
      unlistens = [];
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!progress) return null;
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  const unit = lang === "ru" ? "МБ" : "MB";

  return (
    <div
      role="status"
      className="anim-fade-up fixed bottom-4 right-4 z-[70] w-72 rounded-xl border border-halo-line bg-halo-raised/95 p-3.5 shadow-2xl"
    >
      <p className="text-xs font-medium text-halo-text">{done ? t("dl.done") : t("dl.title")}</p>
      <p className="mt-0.5 truncate text-[10px] text-halo-muted" title={progress.file}>
        {progress.file}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-halo-deep">
        <div className="h-full rounded-full bg-halo-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-right text-[10px] tabular-nums text-halo-muted">
        {done ? (
          `${pct}%`
        ) : (
          `${mb(progress.received)} / ${mb(progress.total)} ${unit} · ${pct}%`
        )}
      </p>
    </div>
  );
}
