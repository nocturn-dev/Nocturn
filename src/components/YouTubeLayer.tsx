import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLang } from "../locales";
import {
  attachYtIframe,
  getYtState,
  subscribeYt,
  thumbUrl,
  ytEmbedSrc,
  ytNext,
  ytPlayAt,
  ytPlayUrl,
  ytPrev,
  ytRemoveAt,
  ytSeek,
  ytSetOpen,
  ytSetVolume,
  ytReset,
  ytHandshake,
  ytToggle,
  type YtTrack,
} from "../yt/ytPlayer";
import { NextTrackIcon, PauseIcon, PlayIcon, PrevTrackIcon } from "./cards/icons";

function mmss(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Слой YouTube: всплывающее окно плеера под минибаром (как окно настроек,
 * но сверху) + ПОСТОЯННЫЙ хост iframe. Ключевой приём: окно при сворачивании
 * не размонтируется (CSS visibility с задержкой) — iframe живёт, звук
 * продолжает играть, управляет минибар. Монтируется только при включённой
 * интеграции (prefs.youtube) — размонтирование = полный сброс драйвера.
 */
export function YouTubeLayer({ closeBind }: { closeBind: string }) {
  const { t } = useLang();
  const yt = useSyncExternalStore(subscribeYt, getYtState);
  const [src, setSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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
      const on = () => ytHandshake();
      el.addEventListener("load", on);
      return () => el.removeEventListener("load", on);
    }
    return;
  }, [src]);

  // Размонтирование слоя = интеграция выключена: полный сброс
  useEffect(() => () => ytReset(), []);

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
    <div className="pointer-events-none fixed inset-x-0 top-0 flex justify-center">
      <div
        className={`yt-pop pointer-events-auto mx-4 mt-[88px] w-[min(760px,94vw)] rounded-2xl border border-halo-line bg-halo-deep/95 shadow-2xl backdrop-blur ${
          yt.open ? "yt-pop-open" : "yt-pop-closed"
        }`}
        style={{ zIndex: "var(--halo-z-modal)" }}
      >
        {/* Шапка: превью + название, крестик сворачивает (звук играет дальше) */}
        <div className="flex items-center gap-2.5 border-b border-halo-line/60 px-3.5 py-2.5">
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

        {/* Видео: iframe живёт здесь всегда (сворачивание — только CSS) */}
        <div className="bg-black">
          {src ? (
            <iframe
              ref={iframeRef}
              src={src}
              title="YouTube"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="aspect-video w-full border-0"
            />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center bg-halo-surface/40 text-halo-muted/50">
              <YouTubeGlyph />
            </div>
          )}
        </div>

        {/* Ошибка embed (запрет встраивания/удалено) — честная плашка */}
        {yt.errorCode !== null && (
          <p className="border-t border-halo-line/60 px-3.5 py-2 text-xs text-halo-error">
            {t("media.ytBlocked")} <span className="text-halo-muted/60">({yt.errorCode})</span>
          </p>
        )}

        {/* Управление: seek, play, prev/next, громкость */}
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
            disabled={!track}
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
        </div>

        {/* Очередь: ссылка/ID + список (пустой — то же поле, оно и стартует) */}
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
              {track ? t("media.ytEnqueue") : t("media.ytPlay")}
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
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Подсказка закрытия по бинду (бинд — из «Горячих клавиш») */}
          <p className="mt-2 text-[0.625rem] text-halo-muted/50">
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
