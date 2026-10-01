/**
 * Настройки медиа-минибара (вкладка «Интеграции»). Всё опционально:
 *  - mode — ЧТО отслеживаем, взаимоисключающе (radio, не два сразу):
 *      desktop — сессия десктопного Spotify-клиента;
 *      browser — вкладка браузера (web-плеер Spotify, YouTube и др.);
 *      off — минибар выключен;
 *  - lyrics — текст песни через lrclib.net: ЕДИНСТВЕННОЕ, что уходит в сеть
 *    (артист + название трека); по умолчанию выключен;
 *  - cover — обложка из системного плеера, чистая ОС, по умолчанию включён.
 * Управление плеером (пауза/переключение) — системные медиа-контролы ОС:
 * никаких аккаунтов и облака, концепция Local-only не покидается.
 */

export type MediaTrackMode = "off" | "desktop" | "browser";

export interface MediaPrefs {
  mode: MediaTrackMode;
  lyrics: boolean;
  cover: boolean;
}

const LS_KEY = "haloui-media";

export function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { mode: "off", lyrics: false, cover: true };
    const p = JSON.parse(raw) as Partial<MediaPrefs> & { bar?: boolean };
    // Миграция старого булева bar:true → режим desktop
    const mode: MediaTrackMode =
      p.mode === "desktop" || p.mode === "browser"
        ? p.mode
        : p.mode === "off"
          ? "off"
          : p.bar === true
            ? "desktop"
            : "off";
    return {
      mode,
      lyrics: p.lyrics === true,
      cover: p.cover !== false,
    };
  } catch {
    return { mode: "off", lyrics: false, cover: true };
  }
}

export function saveMediaPrefs(p: MediaPrefs) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}
