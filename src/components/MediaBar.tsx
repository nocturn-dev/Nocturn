import { useEffect, useState } from "react";
import {
  lyricsFetch,
  mediaControl,
  mediaStatus,
  onMediaState,
  type MediaStateDto,
} from "../api";
import { useLang } from "../locales";
import type { MediaPrefs } from "../mediaPrefs";
import {
  NextTrackIcon,
  PauseIcon,
  PlayIcon,
  PrevTrackIcon,
} from "./cards/icons";

interface LyricLine {
  t: number;
  text: string;
}

/** LRC "[mm:ss.xx] строка" → отсортированные строки (плейн — t = -1) */
function parseLyrics(synced: string | null, plain: string | null): LyricLine[] {
  if (synced) {
    const out: LyricLine[] = [];
    for (const row of synced.split("\n")) {
      const m = /^\s*\[(\d+):(\d+)(?:[.:](\d+))?\]\s*(.*)$/.exec(row);
      if (!m) continue;
      const mi = m[1];
      const se = m[2];
      const fr = m[3];
      const text = (m[4] ?? "").trim();
      if (!mi || !se || !text) continue;
      const t = Number(mi) * 60 + Number(se) + (fr ? Number(`0.${fr}`) : 0);
      out.push({ t, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  if (plain) {
    return plain
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => text)
      .map((text) => ({ t: -1, text }));
  }
  return [];
}

/**
 * Мини-бар плеера: тонкая полоска под шапкой чата. Состояние — системный
 * плеер через SMTC / оконный fallback (бекенд), время тикает локально.
 * Лирика авто-следит за воспроизведением (строки по LRC-таймкодам),
 * подсветка текущей строки — токены темы или собственный цвет.
 * Ничего не играет / тумблер выключен — компонент не рендерится вовсе.
 */
export function MediaBar({ prefs }: { prefs: MediaPrefs }) {
  const { t } = useLang();
  const [state, setState] = useState<MediaStateDto | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricOffset, setLyricOffset] = useState(0);
  const [, setTick] = useState(0);

  // Начальный снимок + живые события бекенда (смена трека/пауза/seek)
  useEffect(() => {
    if (!prefs.bar) return;
    let disposed = false;
    let un: (() => void) | null = null;
    void (async () => {
      try {
        const st = await mediaStatus();
        if (!disposed) setState(st);
      } catch {
        // нет бекенда (браузерное превью) — минибар молчит
      }
      try {
        un = await onMediaState(() => {
          if (disposed) return;
          void mediaStatus()
            .then((st) => {
              // st может быть null: плеер закрыт/ничего не играет
              if (!disposed) setState(st);
            })
            .catch(() => {});
        });
      } catch {
        // событие недоступно — остаёмся на снимке
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, [prefs.bar]);

  // Текст песни: по смене трека, только при включённом тумблере (lrclib)
  useEffect(() => {
    if (!prefs.lyrics || !state?.title) {
      setLyrics(null);
      setLyricsLoading(false);
      return;
    }
    let disposed = false;
    setLyrics(null);
    setLyricOffset(0);
    setLyricsLoading(true);
    void lyricsFetch(state.artist ?? "", state.title, null)
      .then((r) => {
        if (disposed) return;
        const lines = parseLyrics(r.synced, r.plain);
        setLyrics(lines.length > 0 ? lines : null);
      })
      .catch(() => {
        if (!disposed) setLyrics(null);
      })
      .finally(() => {
        if (!disposed) setLyricsLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [prefs.lyrics, state?.title, state?.artist, state?.trackId]);

  // Локальный тик времени: раз в секунду, только пока играет
  useEffect(() => {
    if (!state?.playing) return;
    const iv = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(iv);
  }, [state?.playing, state?.trackId]);

  if (!prefs.bar || !state || !state.title) return null;

  // Прошедшее время: позиция бекенда + локальная интерполяция с момента
  // снимка (пересчёт в теле рендера — тик выше просто перерисовывает)
  const drift = state.playing
    ? Math.max(0, Math.floor((Date.now() - state.updatedAtMs) / 1000))
    : 0;
  const elapsed = state.positionSecs + drift;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  // Авто-следящая строка: последняя строка с t <= elapsed (синхронная
  // лирика); смещение стрелками — ручной подвод, сбрасывается на новом треке
  const autoIdx = lyrics
    ? lyrics.reduce((acc, l, i) => (l.t >= 0 && l.t <= elapsed ? i : acc), -1)
    : -1;
  const viewIdx = lyrics
    ? Math.min(
        lyrics.length - 1,
        Math.max(0, Math.max(autoIdx, 0) + lyricOffset),
      )
    : 0;
  const lyric = lyrics?.[viewIdx];
  const nextLyric = lyrics?.[viewIdx + 1];
  const customColor =
    prefs.lyricColorMode === "custom" ? prefs.lyricColor : null;

  return (
    <div className="anim-fade relative z-20 flex h-9 items-center gap-2.5 border-b border-halo-line/60 bg-halo-deep/60 px-4 backdrop-blur">
      {prefs.cover && state.cover && (
        <img
          src={state.cover}
          alt=""
          className="h-6 w-6 shrink-0 rounded-md object-cover"
        />
      )}
      {/* Трек — артист: слева, фиксированный блок (фидбек владельца) */}
      <div className="w-40 shrink-0 truncate text-xs text-halo-muted">
        {state.title}
        {state.artist ? ` — ${state.artist}` : ""}
      </div>
      {/* Лирика: по центру, авто-следящая; смена строки — плавный фейд
          (keyed remount, токены motion), без «дёрганья» */}
      <div className="relative flex h-full min-w-0 flex-1 items-center justify-center">
        {lyricsLoading ? (
          <span className="text-[0.625rem] text-halo-muted/60">…</span>
        ) : lyric ? (
          <div key={viewIdx} className="anim-fade w-full leading-tight">
            {/* Текущая строка: подсветка темой (accent) или своим цветом */}
            <p
              className={`truncate text-center text-xs ${
                customColor ? "" : "text-halo-accent"
              }`}
              style={customColor ? { color: customColor } : undefined}
            >
              {lyric.text}
            </p>
            {nextLyric && nextLyric.text !== lyric.text && (
              <p className="truncate text-center text-[0.625rem] text-halo-muted/60">
                {nextLyric.text}
              </p>
            )}
          </div>
        ) : (
          <span className="rounded-md border border-halo-line/50 bg-halo-surface/60 px-2.5 py-1 text-[0.625rem] text-halo-muted/70">
            {t("media.lyricsMissing")}
          </span>
        )}
      </div>
      {lyrics && lyrics.length > 1 && (
        <div className="flex shrink-0 flex-col leading-none">
          <button
            onClick={() => setLyricOffset((v) => Math.max(-Math.max(autoIdx, 0), v - 1))}
            title={t("media.ttLyricsUp")}
            className="rounded px-1 text-[0.5rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            ▲
          </button>
          <button
            onClick={() =>
              setLyricOffset((v) =>
                Math.min(lyrics.length - 1 - Math.max(autoIdx, 0), v + 1),
              )
            }
            title={t("media.ttLyricsDown")}
            className="rounded px-1 text-[0.5rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            ▼
          </button>
        </div>
      )}
      <span className="shrink-0 text-[0.625rem] tabular-nums text-halo-muted/70">
        {mmss}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={() => void mediaControl("prev").catch(() => {})}
          title={t("media.ttPrev")}
          className="rounded p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <PrevTrackIcon />
        </button>
        <button
          onClick={() =>
            void mediaControl(state.playing ? "pause" : "play").catch(() => {})
          }
          title={t("media.ttPlay")}
          className="rounded p-1 text-halo-text transition-colors hover:bg-halo-hover"
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          onClick={() => void mediaControl("next").catch(() => {})}
          title={t("media.ttNext")}
          className="rounded p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <NextTrackIcon />
        </button>
      </div>
    </div>
  );
}
