import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import {
  getYtState,
  subscribeYt,
  thumbUrl,
  ytNext,
  ytPrev,
  ytSetOpen,
  ytToggle,
} from "../yt/ytPlayer";
import {
  lyricsFetch,
  mediaControl,
  mediaStatus,
  onMediaState,
  type MediaStateDto,
} from "../api";
import { useLang } from "../locales";
import type { MediaPrefs, MediaLyricsSnapshot } from "../mediaPrefs";
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

function mmssFmt(secs: number): string {
  const sec = Math.max(0, Math.floor(secs));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Название YT-ролика → кандидат для lrclib: срезаем скобочный мусор
 *  («(Official Video)», «【MV】») и хвостовые разделители канала */
function cleanYtTitle(raw: string): string {
  return raw
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】|「[^」]*」/g, " ")
    .replace(/[\s|／·–——-]*$/u, "")
    .replace(/^[\s|／·–——-]+/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Мини-бар плеера: тонкая полоска под шапкой чата. Состояние — системный
 * плеер через SMTC / оконный fallback (бекенд), время тикает локально.
 * Лирика авто-следит за воспроизведением (строки по LRC-таймкодам),
 * подсветка текущей строки — токены темы или собственный цвет.
 * Ничего не играет / тумблер выключен — компонент не рендерится вовсе.
 */
export function MediaBar({
  prefs,
  onLyrics,
  onPlayingChange,
  onTrackChange,
}: {
  prefs: MediaPrefs;
  /** Снимок лирики наверх (LyricsRibbon): смена строки/текста, null —
   *  лирики нет или компонент размонтирован */
  onLyrics?: (snap: MediaLyricsSnapshot | null) => void;
  /** Играет ли музыка (маскоту — наушники и качание) */
  onPlayingChange?: (playing: boolean) => void;
  /** Смена трека наверх (Нок: «О, моя любимая!» / «Что смотришь?»).
   *  src — какая интеграция дала трек */
  onTrackChange?: (src: "spotify" | "yt") => void;
}) {
  const { t } = useLang();
  const [state, setState] = useState<MediaStateDto | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricOffset, setLyricOffset] = useState(0);
  // Тик времени: перерисовывает бар и перевычисляет снапшот лирики
  const [tick, setTick] = useState(0);
  // Лирика YouTube-режима (отдельно от Spotify-лирики)
  const [ytLyrics, setYtLyrics] = useState<LyricLine[] | null>(null);
  const yt = useSyncExternalStore(subscribeYt, getYtState);

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
    // Длительность — ключ выбора записи lrclib: без неё берётся самая
    // короткая выдача (часто джанк-таймлайн)
    void lyricsFetch(state.artist ?? "", state.title, state.durationSecs ?? null)
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
  }, [prefs.lyrics, state?.title, state?.artist, state?.trackId, state?.durationSecs]);

  // Локальный тик времени: раз в секунду, только пока играет
  useEffect(() => {
    if (!state?.playing) return;
    const iv = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(iv);
  }, [state?.playing, state?.trackId]);
  // Играет ли музыка — с учётом режима: в YouTube-режиме SMTC-стейт (Spotify)
  // может быть пуст, а музыка играет в embed — Нок иначе не надевает наушники
  // и не качается (реальный кейс 04.10: «Нок не реагирует на YouTube»)
  const playing = !!(prefs.youtube ? yt.playing : state?.playing);
  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);

  // Лирика для YouTube: автор = канал («Artist - Topic» → «Artist»),
  // название чистится. Deps — примитивы: объект track пересоздаётся
  // каждым тиком infoDelivery, строковые поля стабильны
  const ytTrackId = yt.track?.videoId ?? null;
  const ytTrackAuthor = yt.track?.author ?? "";
  const ytTrackTitle = yt.track?.title ?? "";
  const ytTrackDuration = yt.duration;
  // Смена трека наверх (Нок: «О, моя любимая!» / «Что смотришь?»).
  // Гард: трек/видео, уже лежащие на паузе при старте, — не событие
  const trackPrevRef = useRef<string | null>(null);
  useEffect(() => {
    const id = state?.trackId ?? null;
    const prev = trackPrevRef.current;
    trackPrevRef.current = id;
    if (!id || id === prev) return;
    if (prev === null && !playing) return;
    onTrackChange?.("spotify");
  }, [state?.trackId, playing, onTrackChange]);
  const ytTrackPrevRef = useRef<string | null>(null);
  useEffect(() => {
    const id = ytTrackId;
    const prev = ytTrackPrevRef.current;
    ytTrackPrevRef.current = id;
    if (!id || id === prev) return;
    if (prev === null && !yt.playing) return;
    onTrackChange?.("yt");
  }, [ytTrackId, yt.playing, onTrackChange]);
  useEffect(() => {
    if (!prefs.youtube || !prefs.lyrics || !ytTrackId) {
      setYtLyrics(null);
      return;
    }
    let disposed = false;
    const artist = ytTrackAuthor.replace(/\s*-\s*Topic$/i, "").trim();
    const title = cleanYtTitle(ytTrackTitle);
    void lyricsFetch(
      artist,
      title,
      ytTrackDuration > 0 ? Math.round(ytTrackDuration) : null,
    )
      .then((r) => {
        if (disposed) return;
        const lines = parseLyrics(r.synced, r.plain);
        setYtLyrics(lines.length > 0 ? lines : null);
      })
      .catch(() => {
        if (!disposed) setYtLyrics(null);
      });
    return () => {
      disposed = true;
    };
  }, [prefs.youtube, prefs.lyrics, ytTrackId, ytTrackAuthor, ytTrackTitle, ytTrackDuration]);

  // Снимок лирики наверх (LyricsRibbon) — ДО ранних return'ов компонента
  // (rules-of-hooks). Источник — активная интеграция: YouTube-режим берёт
  // лирику embed-плеера и его же currentTime, иначе SMTC-лирика системного
  // плеера с локальной интерполяцией позиции. Индекс — последняя строка
  // с t <= elapsed; ручной подвод бара в ленту не тащим. tick в deps —
  // продвижение индекса между событиями бекенда (интерполяция живёт в
  // рендере, без тика лента замирает до следующего события SMTC).
  // Вызов — только на смене строки или набора строк: дедуп не даёт
  // секундным тикам дёргать App.
  // Дедуп по ИДЕНТИЧНОСТИ набора + индексу, не по {длина, индекс}:
  // у нового трека совпадение длины и стартового индекса — не редкость
  const lyricsSnapRef = useRef<{ lines: LyricLine[] | null; i: number } | null>(
    null,
  );
  useEffect(() => {
    if (!onLyrics) return;
    const push = (lines: LyricLine[] | null, idx: number) => {
      const prev = lyricsSnapRef.current;
      if (!lines) {
        // Повторный null не отправляем: App и так без снапшота
        if (!prev) return;
        lyricsSnapRef.current = null;
        onLyrics(null);
        return;
      }
      if (prev && prev.lines === lines && prev.i === idx) return;
      lyricsSnapRef.current = { lines, i: idx };
      onLyrics({ lines, index: Math.max(0, idx) });
    };
    if (prefs.youtube) {
      if (!ytLyrics || ytLyrics.length < 2) return push(null, -1);
      const idx = ytLyrics.reduce(
        (acc, l, i) => (l.t >= 0 && l.t <= yt.currentTime ? i : acc),
        -1,
      );
      push(ytLyrics, idx);
      return;
    }
    if (!lyrics || lyrics.length < 2) return push(null, -1);
    const driftNow = state?.playing
      ? Math.max(0, Math.floor((Date.now() - state.updatedAtMs) / 1000))
      : 0;
    const el = (state?.positionSecs ?? 0) + driftNow;
    const idx = lyrics.reduce(
      (acc, l, i) => (l.t >= 0 && l.t <= el ? i : acc),
      -1,
    );
    push(lyrics, idx);
  }, [onLyrics, prefs.youtube, ytLyrics, yt.currentTime, lyrics, state, tick]);
  // Размонтирование бара — лента гаснет
  useEffect(() => () => onLyrics?.(null), [onLyrics]);

  // Режим YouTube: интеграция — радио с Spotify (bar=false), минибар
  // показывает трек embed-плеера; без трека — узкая полоска-вход в плеер
  if (prefs.youtube) {
    const tr = yt.track;
    return (
      <div className="anim-fade relative z-[var(--halo-z-panel)] flex h-9 items-center gap-2.5 border-b border-halo-line/60 bg-halo-deep/60 px-4 backdrop-blur">
        {tr ? (
          <img
            src={thumbUrl(tr.videoId)}
            alt=""
            className="h-7 w-12 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="flex h-7 w-12 shrink-0 items-center justify-center rounded-md bg-halo-surface text-halo-muted/60">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="1.5" y="4.5" width="21" height="15" rx="4.5" />
              <path d="M10 8.8v6.4l5.6-3.2L10 8.8z" fill="var(--halo-deep)" />
            </svg>
          </div>
        )}
        <div className="w-40 shrink-0 leading-tight" title={tr?.title}>
          <p className="truncate text-xs font-medium text-halo-text">
            {tr ? tr.title : "YouTube"}
          </p>
          {(() => {
            const idx =
              ytLyrics && tr
                ? ytLyrics.reduce(
                    (acc, l, i) => (l.t >= 0 && l.t <= yt.currentTime ? i : acc),
                    -1,
                  )
                : -1;
            const line = idx >= 0 ? (ytLyrics ?? [])[idx] : undefined;
            if (line) {
              return (
                <p className="truncate text-[0.6875rem] text-halo-accent">
                  {line.text}
                </p>
              );
            }
            return tr && tr.author ? (
              <p className="truncate text-[0.6875rem] text-halo-muted">
                {tr.author}
              </p>
            ) : null;
          })()}
        </div>
        {/* Play — по центру, как у минибара-скетча; без трека открывает плеер */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
          <button
            onClick={ytPrev}
            disabled={!tr || yt.queueIndex <= 0}
            title={t("media.ttPrev")}
            className="rounded p-1 text-halo-muted transition-colors hover:text-halo-text disabled:opacity-30"
          >
            <PrevTrackIcon />
          </button>
          <button
            onClick={() => (tr ? ytToggle() : ytSetOpen(true))}
            title={t("media.ttPlay")}
            className="rounded-full p-1.5 text-halo-text transition-colors hover:bg-halo-hover"
          >
            {tr && yt.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            onClick={ytNext}
            disabled={!tr || yt.queueIndex >= yt.queue.length - 1}
            title={t("media.ttNext")}
            className="rounded p-1 text-halo-muted transition-colors hover:text-halo-text disabled:opacity-30"
          >
            <NextTrackIcon />
          </button>
        </div>
        <span className="shrink-0 text-[0.625rem] tabular-nums text-halo-muted/70">
          {tr ? mmssFmt(yt.currentTime) : "0:00"}
        </span>
        <button
          onClick={() => ytSetOpen(true)}
          title={t("media.ytOpenPlayer")}
          className="rounded p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 10l8-6 8 6v10H4V10z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
  }

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

  // Пара цветов переливания: var'ы на корне бара, CSS-градиент их читает
  // (см. .media-text-shimmer в index.css)
  const shimmerVars = {
    "--shim-from": prefs.shimmerFrom,
    "--shim-to": prefs.shimmerTo,
  } as CSSProperties;

  return (
    <div
      className={`anim-fade relative z-[var(--halo-z-panel)] flex h-9 items-center gap-2.5 border-b border-halo-line/60 bg-halo-deep/60 px-4 backdrop-blur ${
        prefs.textShimmer ? "media-text-shimmer" : ""
      }`}
      style={shimmerVars}
    >
      {prefs.cover && state.cover && (
        <img
          src={state.cover}
          alt=""
          className="h-6 w-6 shrink-0 rounded-md object-cover"
        />
      )}
      {/* Артист + трек: слева, две плитки (артист первой, название ниже) */}
      <div className="w-40 shrink-0 leading-tight">
        <p
          className={`truncate text-xs font-medium text-halo-text ${
            prefs.textShimmer ? "shimmer-text" : ""
          }`}
        >
          {state.artist ?? state.title}
        </p>
        {state.artist && (
          <p className="truncate text-[0.6875rem] text-halo-muted">
            {state.title}
          </p>
        )}
      </div>
      {/* Лирика: по центру, авто-следящая; смена строки — плавный фейд
          (keyed remount, токены motion), без «дёрганья» */}
      <div className="relative flex h-full min-w-0 flex-1 items-center justify-center">
        {lyricsLoading ? (
          <span className="text-[0.625rem] text-halo-muted/60">…</span>
        ) : lyric ? (
          <div key={viewIdx} className="anim-fade w-full leading-tight">
            {/* Текущая строка: подсветка темой (accent) или своим цветом;
                шиммер перекрывает статичный цвет переливанием */}
            <p
              className={`truncate text-center text-xs ${
                customColor ? "" : "text-halo-accent"
              } ${prefs.textShimmer ? "shimmer-text" : ""}`}
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
