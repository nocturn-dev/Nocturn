/**
 * Живой просмотр браузера агента: правая панель с трансляцией кадров
 * агентовского Chromium (CDP captureScreenshot ~2.5 к/с, кадры шлёт
 * Rust при изменении). Адресная строка — только отображение,
 * селектор разрешения задаёт вьюпорт через Emulation.
 */

import { useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../motion";
import {
  browserViewStart,
  browserViewStop,
  browserViewSetSize,
  listenBrowserFrame,
} from "../api";
import { useLang } from "../locales";

// Числовые размеры — язык-нейтральные; «Fit» подписывается из словаря
// в рендере (SIZES живёт на уровне модуля, t там недоступен)
const SIZES: { label: string | null; w: number | null; h: number | null }[] = [
  { label: null, w: null, h: null },
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
  // Ошибка запуска трансляции: без неё панель висит в «ожидании» без причины
  const [startErr, setStartErr] = useState(false);
  // Отписка от событий: тапл из listen + признак размонтирования
  const unlistenRef = useRef<(() => void) | null>(null);
  // Выбранный размер в реф: эффект старта не должен перезапускаться
  // при смене селектора, а вьюпорт пере-применять ему нужно актуальный
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStartErr(false);
    setUrl("");
    // start больше не void — cleanup при быстром закрытии раньше
    // вызывался ДО завершения start, stop обгонял start, и CDP-трансляция
    // оставалась жить в Rust с мёртвым подписчиком. Ждём start и гасим
    // по флагу, если панель уже закрылась
    (async () => {
      try {
        await browserViewStart();
      } catch (e) {
        console.error("[nocturn] browser view start:", e);
        if (alive) setStartErr(true);
        return;
      }
      if (!alive) {
        void browserViewStop().catch(() => {});
        return;
      }
      // Вьюпорт пере-применяем при каждом открытии: агент мог сменить
      // разрешение через Emulation, а селектор панель показывает свой —
      // источник правды о размере здесь панель
      const s = SIZES[sizeRef.current];
      if (s) {
        void browserViewSetSize(s.w, s.h).catch(() => {
          if (alive) setSize(0);
        });
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

  const show = useDelayedUnmount(open, 200);
  if (!show) return null;

  const applySize = (idx: number) => {
    const prev = size;
    setSize(idx);
    const s = SIZES[idx];
    if (!s) return;
    void browserViewSetSize(s.w, s.h).catch(() => {
      // Селектор показывает применённый размер: при сбое возвращаем
      // предыдущее значение, чтобы подпись не врала
      if (sizeRef.current === idx) setSize(prev);
    });
  };

  return (
    <div className={`fixed inset-y-0 right-0 z-[var(--halo-z-panel-top)] flex w-[440px] flex-col border-l border-halo-line bg-halo-deep shadow-2xl ${open ? "anim-slide-left" : "anim-slide-left-out"}`}>
      {/* Шапка: адрес + размер + закрыть */}
      <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-3 py-2">
        <input
          readOnly
          value={url}
          placeholder={t("browserPanel.noPage")}
          className="min-w-0 flex-1 truncate rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[0.6875rem] text-halo-muted outline-none"
        />
        <select
          value={size}
          onChange={(e) => applySize(parseInt(e.target.value, 10))}
          title={t("browserPanel.size")}
          className="shrink-0 rounded-lg border border-halo-line bg-halo-surface px-1.5 py-1.5 text-[0.6875rem] text-halo-muted outline-none"
        >
          {SIZES.map((s, i) => (
            <option key={s.label ?? "fit"} value={i}>
              {s.label ?? t("browserPanel.fit")}
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
        {startErr ? (
          <p className="max-w-[280px] text-center text-xs leading-relaxed text-red-400">
            {t("browserPanel.startError")}
          </p>
        ) : frame ? (
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
        <p className="text-[0.625rem] text-halo-muted/60">{t("browserPanel.note")}</p>
      </div>
    </div>
  );
}
