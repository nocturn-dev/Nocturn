import { useEffect, useState } from "react";
import {
  lyricsFetch,
  mediaControl,
  mediaSetMode,
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
 * плеер через SMTC (бекенд), время тикает локально от (позиция, метка) —
 * ноль IPC-спама. Текст песни — lrclib.net, листается стрелками вручную.
 * Ничего не играет / тумблер выключен — компонент не рендерится вовсе.
 */
export function MediaBar({ prefs }: { prefs: MediaPrefs }) {
  const { t } = useLang();
  const [state, setState] = useState<MediaStateDto | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricIdx, setLyricIdx] = useState(0);
  const [, setTick] = useState(0);

  // Начальный снимок + живые события бекенда (смена трека/пауза/seek)
  useEffect(() => {
    if (prefs.mode === "off") return;
    let disposed = false;
    let un: (() => void) | null = null;
    void (async () => {
      // Режим обязателен ДО первого снимка: бекенд фильтрует сессии по нему
      try {
        await mediaSetMode(prefs.mode);
      } catch {
        // нет бекенда (браузерное превью) — минибар молчит
      }
      try {
        const st = await mediaStatus();
        if (!disposed) setState(st);
      } catch {
        // нет бекенда — минибар молчит
      }
      try {
        un = await onMediaState(() => {
          if (disposed) return;
          void mediaStatus()
            .then((st) => {
              // st может быть null: в выбранном режиме ничего не играет
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
  }, [prefs.mode]);

  // Текст песни: по смене трека, только при включённом тумблере (lrclib)
  useEffect(() => {
    if (!prefs.lyrics || !state?.title) {
      setLyrics(null);
      return;
    }
    let disposed = false;
    setLyrics(null);
    setLyricIdx(0);
    void lyricsFetch(state.artist ?? "", state.title, null)
      .then((r) => {
        if (disposed) return;
        const lines = parseLyrics(r.synced, r.plain);
        setLyrics(lines.length > 0 ? lines : null);
      })
      .catch(() => {
        if (!disposed) setLyrics(null);
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

  if (prefs.mode === "off" || !state || !state.title) return null;

  // Прошедшее время: позиция бекенда + локальная интерполяция с момента
  // снимка (пересчёт в теле рендера — тик выше просто перерисовывает)
  const drift = state.playing
    ? Math.max(0, Math.floor((Date.now() - state.updatedAtMs) / 1000))
    : 0;
  const elapsed = state.positionSecs + drift;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const lyric = lyrics?.[Math.min(lyricIdx, lyrics.length - 1)];
  const nextLyric = lyrics?.[Math.min(lyricIdx + 1, lyrics.length - 1)];

  return (
    <div className="anim-fade relative z-20 flex h-9 items-center gap-2.5 border-b border-halo-line/60 bg-halo-deep/60 px-4 backdrop-blur">
      {prefs.cover && state.cover && (
        <img
          src={state.cover}
          alt=""
          className="h-6 w-6 shrink-0 rounded-md object-cover"
        />
      )}
      <div className="min-w-0 flex-1 leading-tight">
        {lyric ? (
          <>
            <p className="truncate text-xs text-halo-text">{lyric.text}</p>
            {nextLyric && nextLyric.text !== lyric.text && (
              <p className="truncate text-[0.625rem] text-halo-muted/60">
                {nextLyric.text}
              </p>
            )}
          </>
        ) : (
          <p className="truncate text-xs text-halo-muted">
            {state.title}
            {state.artist ? ` — ${state.artist}` : ""}
          </p>
        )}
      </div>
      {lyrics && lyrics.length > 1 && (
        <div className="flex shrink-0 flex-col leading-none">
          <button
            onClick={() => setLyricIdx((v) => Math.max(0, v - 1))}
            title={t("media.ttLyricsUp")}
            className="rounded px-1 text-[0.5rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            ▲
          </button>
          <button
            onClick={() => setLyricIdx((v) => Math.min(lyrics.length - 1, v + 1))}
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
