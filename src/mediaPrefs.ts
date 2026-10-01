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
