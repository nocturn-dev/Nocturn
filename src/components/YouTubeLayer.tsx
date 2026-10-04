import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLang } from "../locales";
import {
  attachYtIframe,
  getYtState,
  subscribeYt,
  thumbUrl,
  ytEmbedSrc,
  ytNext,
  ytOnIframeReady,
  ytPlayAt,
  ytPlayUrl,
  ytPrev,
  ytRemoveAt,
  ytSeek,
  ytSetOpen,
  ytSetRate,
  ytSetRepeatOne,
  ytSetVolume,
  ytReset,
  ytHandshake,
  ytToggle,
  type YtTrack,
} from "../yt/ytPlayer";
import { NextTrackIcon, PauseIcon, PlayIcon, PrevTrackIcon, XSmallIcon } from "./cards/icons";

function mmss(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
const SIZE_CLASSES: Record<"s" | "m" | "l", string> = {
  s: "w-[min(640px,92vw)]",
  m: "w-[min(820px,92vw)]",
  l: "w-[min(1000px,94vw)]",
};

/**
 * Слой YouTube: МОДАЛЬНЫЙ оверлей (fixed на весь интерфейс, верхний слой
 * z-modal) — центр только flexbox'ом контейнера (items/justify-center),
 * никаких ручных сдвигов. Фон: затемнение + лёгкий backdrop-blur, клик по
 * нему сворачивает окно (тумблер keepOpen делает фон «стеклянным» для
 * кликов — чат работает, окно закрывают крестиком/биндом). Ключевой приём:
 * окно при сворачивании не размонтируется (CSS visibility с задержкой) —
 * iframe живёт, звук продолжает играть, управляет минибар. Монтируется
 * только при включённой интеграции — размонтирование = полный сброс.
 * Опционально: перетаскивание за шапку (drag), размер s/m/l,
 * авто-сворачивание после старта воспроизведения (autoCollapse).
 */
export function YouTubeLayer({
  closeBind,
  autoCollapse = false,
  keepOpen = false,
  draggable = false,
  size = "m",
}: {
  closeBind: string;
  autoCollapse?: boolean;
  keepOpen?: boolean;
  draggable?: boolean;
  size?: "s" | "m" | "l";
}) {
  const { t } = useLang();
  const yt = useSyncExternalStore(subscribeYt, getYtState);
  const [src, setSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Драг за шапку: смещение от центра (flex-центр остаётся базой)
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Первый трек: один раз создаём iframe с его id в src; дальше —
  // loadVideoById без перезагрузок
  useEffect(() => {
    if (!src && yt.track) setSrc(ytEmbedSrc(yt.track.videoId));
  }, [yt.track, src]);

  // iframe в DOM → регистрируем в драйвере и делаем handshake
  useEffect(() => {
    const el = iframeRef.current;
    attachYtIframe(el);
    if (el) {
      const on = () => {
        ytHandshake();
        ytOnIframeReady();
      };
      el.addEventListener("load", on);
      return () => el.removeEventListener("load", on);
    }
    return;
  }, [src]);

  // Размонтирование слоя = интеграция выключена: полный сброс
  useEffect(() => () => ytReset(), []);

  // Фоновый режим: после старта воспроизведения окно сворачивается само
  useEffect(() => {
    if (!autoCollapse || !yt.playing || !yt.open) return;
    const timer = setTimeout(() => {
      if (getYtState().playing) ytSetOpen(false);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [autoCollapse, yt.playing, yt.open]);

  // Тумблер драга выключен — вернуть окно в центр
  useEffect(() => {
    if (!draggable) setDrag({ x: 0, y: 0 });
  }, [draggable]);

  const onDragStart = (e: React.PointerEvent) => {
    if (!draggable) return;
    dragRef.current = { px: e.clientX, py: e.clientY, x: drag.x, y: drag.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  const submitDraft = () => {
    const res = ytPlayUrl(draft);
    if (!res.ok) {
      setDraftError(true);
      return;
    }
    setDraftError(false);
    setDraft("");
    ytSetOpen(true);
  };

  const track = yt.track;
  const duration = yt.duration > 0 ? yt.duration : 0;
  const pos = scrub ?? yt.currentTime;

  return (
    <div
      className={`fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center p-6 ${
        yt.open ? "pointer-events-auto" : "pointer-events-none"
      }`}
    >
      {/* Фон: затемнение + лёгкий блюр интерфейса (blur — условно, правило
          дома). keepOpen: фон прозрачен для кликов — чат работает, окно
          не сворачивается (закрывать крестиком/биндом) */}
      <div
        onClick={() => {
          if (!keepOpen) ytSetOpen(false);
        }}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          yt.open ? "opacity-100 backdrop-blur-sm" : "opacity-0"
        } ${keepOpen ? "pointer-events-none" : ""}`}
      />
      {/* Обёртка драга: transform живёт здесь, чтобы не конфликтовать
          с transition окна (yt-pop анимирует transform) */}
      <div
        className="relative"
        style={draggable ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
      >
      <div
        className={`yt-pop relative ${SIZE_CLASSES[size]} rounded-2xl border border-halo-line bg-halo-deep shadow-2xl ${
          yt.open ? "yt-pop-open" : "yt-pop-closed"
        }`}
      >
        {/* Шапка: превью + название, крестик сворачивает (звук играет дальше).
            Драг (по тумблеру) — за шапку, pointer-capture */}
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className={`flex items-center gap-2.5 border-b border-halo-line/60 px-3.5 py-2.5 ${
            draggable ? "cursor-move select-none touch-none" : ""
          }`}
          title={draggable ? t("media.ytDrag") : undefined}
        >
          {track ? (
            <img
              src={thumbUrl(track.videoId)}
              alt=""
              className="h-9 w-16 shrink-0 rounded-md object-cover"
            />
          ) : (
            <div className="h-9 w-16 shrink-0 rounded-md bg-halo-surface" />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium text-halo-text">
              {track ? track.title : t("media.ytEmpty")}
            </p>
            {track && track.author && (
              <p className="truncate text-[0.6875rem] text-halo-muted">
                {track.author}
              </p>
            )}
          </div>
          <button
            onClick={() => ytSetOpen(false)}
            title={t("media.ytClose")}
            className="rounded-lg p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Видео/ввод: пока трека нет — ЗОНА ВИДЕО и есть текстовое поле
            (вставил ссылку → Enter); с треком — iframe, поле уезжает вниз
            и работает только на добавление в очередь */}
        <div className="bg-black">
          {src ? (
            <iframe
              ref={iframeRef}
              src={src}
              title="YouTube"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              // WebView2 может молчать про Referer — политика явная (правило
              // webview-плееров: без реферера YouTube отдаёт 150/153)
              referrerPolicy="strict-origin-when-cross-origin"
              className="aspect-video w-full border-0"
            />
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 bg-halo-surface/30 px-8">
              <div className="text-halo-muted/40">
                <YouTubeGlyph />
              </div>
              <div className="flex w-full max-w-md items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDraftError(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) submitDraft();
                  }}
                  placeholder={t("media.ytEmpty")}
                  className={`h-10 min-w-0 flex-1 rounded-xl border bg-halo-deep px-3.5 text-sm text-halo-text outline-none placeholder:text-halo-muted/50 ${
                    draftError
                      ? "border-halo-error/60"
                      : "border-halo-line focus:border-halo-accent/50"
                  }`}
                />
                <button
                  onClick={submitDraft}
                  className="h-10 shrink-0 rounded-xl border border-halo-accent/40 bg-halo-accent/10 px-4 text-sm font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
                >
                  {t("media.ytPlay")}
                </button>
              </div>
              {draftError && (
                <p className="text-xs text-halo-error">{t("media.ytBadUrl")}</p>
              )}
            </div>
          )}
        </div>

        {/* Ошибка embed (запрет встраивания/удалено) — честная плашка */}
        {yt.errorCode !== null && (
          <p className="border-t border-halo-line/60 px-3.5 py-2 text-xs text-halo-error">
            {t("media.ytBlocked")} <span className="text-halo-muted/60">({yt.errorCode})</span>
          </p>
        )}

        {/* Управление: seek, play, prev/next, скорость, громкость, цикл */}
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <button
            onClick={ytPrev}
            disabled={yt.queueIndex <= 0}
            title={t("media.ttPrev")}
            className="rounded p-1 text-halo-muted transition-colors hover:text-halo-text disabled:opacity-30"
          >
            <PrevTrackIcon />
          </button>
          <button
            onClick={ytToggle}
            disabled={!track && yt.queue.length === 0}
            title={t("media.ttPlay")}
            className="rounded-full bg-halo-accent p-1.5 text-halo-on-accent transition-transform hover:scale-105 disabled:opacity-40"
          >
            {yt.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            onClick={ytNext}
            disabled={yt.queueIndex >= yt.queue.length - 1}
            title={t("media.ttNext")}
            className="rounded p-1 text-halo-muted transition-colors hover:text-halo-text disabled:opacity-30"
          >
            <NextTrackIcon />
          </button>
          {/* Скорость: сегмент 0.75–2 */}
          <div className="flex shrink-0 items-center rounded-lg border border-halo-line p-0.5">
            {RATES.map((r) => (
              <button
                key={r}
                onClick={() => ytSetRate(r)}
                className={`rounded-md px-1.5 py-0.5 text-[0.5625rem] tabular-nums transition-colors ${
                  yt.rate === r
                    ? "bg-halo-accent/20 text-halo-accent"
                    : "text-halo-muted hover:text-halo-text"
                }`}
              >
                {r}×
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={1}
            value={pos}
            onChange={(e) => setScrub(Number(e.target.value))}
            onMouseUp={() => {
              if (scrub !== null) ytSeek(scrub);
              setScrub(null);
            }}
            onTouchEnd={() => {
              if (scrub !== null) ytSeek(scrub);
              setScrub(null);
            }}
            className="min-w-0 flex-1"
            disabled={!track || !duration}
          />
          <span className="shrink-0 text-[0.625rem] tabular-nums text-halo-muted/70">
            {mmss(yt.currentTime)} / {mmss(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={yt.volume}
            onChange={(e) => ytSetVolume(Number(e.target.value))}
            className="w-20 shrink-0"
            title={`${yt.volume}%`}
          />
          {/* Повтор трека: цикл */}
          <button
            onClick={() => ytSetRepeatOne(!yt.repeatOne)}
            title={t("media.ttRepeat")}
            className={`rounded p-1 transition-colors ${
              yt.repeatOne
                ? "text-halo-accent"
                : "text-halo-muted hover:text-halo-text"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {yt.repeatOne && (
                <text x="12" y="15.5" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none">
                  1
                </text>
              )}
            </svg>
          </button>
        </div>

        {/* Очередь: видна и после рестарта (track ещё null, но очередь
            восстановлена — иначе сохранённую очередь не увидеть и не
            запустить; старт пункта создаёт track по пути «первого плей») */}
        {(track || yt.queue.length > 0) && (
          <div className="border-t border-halo-line/60 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDraftError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submitDraft();
                }}
                placeholder={t("media.ytQueuePlaceholder")}
                className={`h-8 min-w-0 flex-1 rounded-lg border bg-halo-surface/60 px-2.5 text-xs text-halo-text outline-none placeholder:text-halo-muted/50 ${
                  draftError ? "border-halo-error/60" : "border-halo-line focus:border-halo-accent/50"
                }`}
              />
              <button
                onClick={submitDraft}
                className="h-8 shrink-0 rounded-lg border border-halo-accent/40 bg-halo-accent/10 px-3 text-xs font-medium text-halo-accent transition-colors hover:bg-halo-accent/20"
              >
                {t("media.ytEnqueue")}
              </button>
            </div>
            {yt.queue.length > 0 && (
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto scroll-slim">
                {yt.queue.map((q: YtTrack, i: number) => (
                  <div
                    key={q.videoId + i}
                    className={`group flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${
                      i === yt.queueIndex
                        ? "bg-halo-accent/10 text-halo-text"
                        : "text-halo-muted hover:bg-halo-hover/50"
                    }`}
                  >
                    <img
                      src={thumbUrl(q.videoId)}
                      alt=""
                      className="h-6 w-10 shrink-0 rounded object-cover"
                    />
                    <button
                      onClick={() => ytPlayAt(i)}
                      className="min-w-0 flex-1 truncate text-left"
                      title={q.title}
                    >
                      {q.title}
                    </button>
                    <button
                      onClick={() => ytRemoveAt(i)}
                      className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:text-halo-text"
                      title={t("media.ytRemove")}
                    >
                      <XSmallIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Подсказка закрытия по бинду (бинд — из «Горячих клавиш») — всегда */}
        <p className="border-t border-halo-line/60 px-3.5 py-2 text-center text-[0.625rem] text-halo-muted/50">
          {t("media.ytHint", { bind: closeBind })}
        </p>
      </div>
      </div>
    </div>
  );
}

function YouTubeGlyph() {
  return (
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" opacity={0.3}>
      <rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="currentColor" />
      <path d="M10 8.8v6.4l5.6-3.2L10 8.8z" fill="var(--halo-deep)" />
    </svg>
  );
}
