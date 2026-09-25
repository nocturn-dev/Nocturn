/**
 * Живой просмотр браузера агента: правая панель с трансляцией кадров
 * агентовского Chromium (CDP captureScreenshot ~2.5 к/с, кадры шлёт
 * Rust при изменении). Адресная строка — только отображение,
 * селектор разрешения задаёт вьюпорт через Emulation.
 */

import { useEffect, useRef, useState } from "react";
import {
  browserViewStart,
  browserViewStop,
  browserViewSetSize,
  listenBrowserFrame,
} from "../api";
import { useLang } from "../locales";

const SIZES: { label: string; w: number | null; h: number | null }[] = [
  { label: "Fit", w: null, h: null },
  { label: "1280×720", w: 1280, h: 720 },
  { label: "1024×768", w: 1024, h: 768 },
  { label: "1920×1080", w: 1920, h: 1080 },
];

interface BrowserPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function BrowserPanel({ open, onClose }: BrowserPanelProps) {
  const { t } = useLang();
  const [frame, setFrame] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [size, setSize] = useState(0);
  // Отписка от событий: тапл из listen + признак размонтирования
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // D19: start больше не void — cleanup при быстром закрытии раньше
    // вызывался ДО завершения start, stop обгонял start, и CDP-трансляция
    // оставалась жить в Rust с мёртвым подписчиком. Ждём start и гасим
    // по флагу, если панель уже закрылась
    (async () => {
      try {
        await browserViewStart();
      } catch {
        return;
      }
      if (!alive) {
        void browserViewStop().catch(() => {});
        return;
      }
    })();
    void listenBrowserFrame((f) => {
      if (!alive) return;
      if (f.data) setFrame(f.data);
      setUrl(f.url ?? "");
    }).then((un) => {
      if (alive) unlistenRef.current = un;
      else un();
    });
    return () => {
      alive = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
      void browserViewStop().catch(() => {});
    };
  }, [open]);

  // При закрытии панели браузер сам не убиваем — только трансляцию
  useEffect(() => {
    if (open) setFrame(null);
  }, [open]);

  if (!open) return null;

  const applySize = (idx: number) => {
    setSize(idx);
    const s = SIZES[idx];
    if (!s) return;
    void browserViewSetSize(s.w, s.h).catch(() => {});
  };

  return (
    <div className="anim-slide-left fixed inset-y-0 right-0 z-40 flex w-[440px] flex-col border-l border-halo-line bg-halo-deep shadow-2xl">
      {/* Шапка: адрес + размер + закрыть */}
      <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-3 py-2">
        <input
          readOnly
          value={url}
          placeholder={t("browserPanel.noPage")}
          className="min-w-0 flex-1 truncate rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[11px] text-halo-muted outline-none"
        />
        <select
          value={size}
          onChange={(e) => applySize(parseInt(e.target.value, 10))}
          title={t("browserPanel.size")}
          className="shrink-0 rounded-lg border border-halo-line bg-halo-surface px-1.5 py-1.5 text-[11px] text-halo-muted outline-none"
        >
          {SIZES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          onClick={onClose}
          title={t("common.close")}
          className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Кадр */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/60">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="max-w-[280px] text-center text-xs leading-relaxed text-halo-muted/70">
            {t("browserPanel.hint")}
          </p>
        )}
      </div>

      {/* Подпись */}
      <div className="shrink-0 border-t border-halo-line px-3 py-1.5">
        <p className="text-[10px] text-halo-muted/60">{t("browserPanel.note")}</p>
      </div>
    </div>
  );
}
