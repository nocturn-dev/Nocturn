/**
 * Настройки медиа-минибара (вкладка «Интеграции»). Всё опционально:
 *  - bar — сама полоска над чатом (мастер-тумблер, карточка Spotify);
 *  - lyrics — текст песни через lrclib.net: ЕДИНСТВЕННОЕ, что уходит в сеть
 *    (артист + название трека); по умолчанию выключен;
 *  - cover — обложка из системного плеера, чистая ОС, по умолчанию включён;
 *  - lyricColorMode/lyricColor — подсветка текущей строки лирики: токены
 *    темы Nocturn или собственный цвет.
 * Управление плеером (пауза/переключение) — системные медиа-контролы ОС
 * и (Desktop-режим) WM_APPCOMMAND окну Spotify: без аккаунтов и облака.
 */

/** Снимок лирики для AmbientLayer (режим «Ambient Lyrics»): строки с
 *  таймкодами + индекс активной. Поднимается из MediaBar колбэком —
 *  слой рисует ленту строк поверх сцены */
export interface MediaLyricsSnapshot {
  lines: { t: number; text: string }[];
  index: number;
}

export interface MediaPrefs {
  bar: boolean;
  lyrics: boolean;
  cover: boolean;
  lyricColorMode: "theme" | "custom";
  lyricColor: string;
  /** Изолированный шиммер текста минибара (лирика + плитки трека):
   *  не зависит от глобального тумблера «Кастомизации» */
  textShimmer: boolean;
  /** Интеграция YouTube (встроенный плеер): РАДИО с bar — включённой
   *  может быть только одна карточка («Интеграций») */
  youtube: boolean;
  /** Фоновый режим: окно плеера сворачивается само через 10 с после
   *  старта воспроизведения */
  ytAutoCollapse: boolean;
  /** Повтор очереди: кончилась — начинать с первого */
  ytLoopQueue: boolean;
  /** Ambient Lyrics: лента строк лирики поверх фона чата (режим
   *  Spotify/YouTube-интеграции, НЕ модификация ambient-сцен) */
  ribbon: boolean;
  /** Размер строк ленты: 0.3–1.0 — от компактной полоски до «на весь экран» */
  ribbonScale: number;
  /** Перетаскивание окна плеера за шапку */
  ytDraggable: boolean;
  /** Клик по фону/чату не сворачивает окно (закрывать крестиком/биндом) */
  ytKeepOpen: boolean;
  /** Размер окна плеера: s | m | l */
  ytSize: "s" | "m" | "l";
  /** Пара цветов переливания (от → к), #rrggbb */
  shimmerFrom: string;
  shimmerTo: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** Дефолтная пара переливания минибара: лосось → бирюза (динамично,
 *  но не кислотно на тёмных тонах) */
const SHIM_FROM = "#f4abab";
const SHIM_TO = "#38c7ee";

function shimPair(p: Partial<MediaPrefs>): { shimmerFrom: string; shimmerTo: string } {
  return {
    shimmerFrom: typeof p.shimmerFrom === "string" && HEX_RE.test(p.shimmerFrom)
      ? p.shimmerFrom
      : SHIM_FROM,
    shimmerTo: typeof p.shimmerTo === "string" && HEX_RE.test(p.shimmerTo)
      ? p.shimmerTo
      : SHIM_TO,
  };
}

const LS_KEY = "haloui-media";

export function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return {
        bar: false,
        lyrics: false,
        cover: true,
        lyricColorMode: "theme",
        lyricColor: "#f4abab",
        textShimmer: false,
        youtube: false,
        ytAutoCollapse: false,
        ytLoopQueue: false,
        ytDraggable: false,
        ribbon: false,
        ribbonScale: 0.6,
        ytKeepOpen: false,
        ytSize: "m",
        ...shimPair({}),
      };
    }
    const p = JSON.parse(raw) as Partial<MediaPrefs> & { mode?: string };
    // Миграция: старый mode:"desktop" → bar:true (браузерный режим вырезан)
    const bar = p.bar === true || p.mode === "desktop";
    return {
      bar,
      lyrics: p.lyrics === true,
      cover: p.cover !== false,
      lyricColorMode: p.lyricColorMode === "custom" ? "custom" : "theme",
      lyricColor:
        typeof p.lyricColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.lyricColor)
          ? p.lyricColor
          : "#f4abab",
      textShimmer: p.textShimmer === true,
      youtube: p.youtube === true,
      ytAutoCollapse: p.ytAutoCollapse === true,
      ytLoopQueue: p.ytLoopQueue === true,
      ytDraggable: p.ytDraggable === true,
      ribbon: p.ribbon === true,
      ribbonScale:
        typeof p.ribbonScale === "number"
          ? Math.min(1, Math.max(0.3, p.ribbonScale))
          : 0.6,
      ytKeepOpen: p.ytKeepOpen === true,
      ytSize: p.ytSize === "s" || p.ytSize === "l" ? p.ytSize : "m",
      ...shimPair(p),
    };
  } catch {
    return {
      bar: false,
      lyrics: false,
      cover: true,
      lyricColorMode: "theme",
      lyricColor: "#f4abab",
      textShimmer: false,
      youtube: false,
      ytAutoCollapse: false,
      ytLoopQueue: false,
      ytDraggable: false,
      ribbon: false,
      ribbonScale: 0.6,
      ytKeepOpen: false,
      ytSize: "m",
      ...shimPair({}),
    };
  }
}

export function saveMediaPrefs(p: MediaPrefs) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

const ACCEPT_KEY = "haloui-media-accepted";

/** Единоразовое предупреждение «Локальный хардкор»: принято навсегда? */
export function loadMediaAccepted(): boolean {
  return localStorage.getItem(ACCEPT_KEY) === "1";
}

export function saveMediaAccepted() {
  localStorage.setItem(ACCEPT_KEY, "1");
}
