/**
 * Настройки медиа-минибара (вкладка «Интеграции»). Всё опционально:
 *  - bar — сама полоска над чатом (мастер-тумблер);
 *  - lyrics — текст песни через lrclib.net: ЕДИНСТВЕННОЕ, что уходит в сеть
 *    (артист + название трека); по умолчанию выключен;
 *  - cover — обложка из системного плеера, чистая ОС, по умолчанию включён.
 * Управление плеером (пауза/переключение) — системные медиа-контролы ОС:
 * никаких аккаунтов и облака, концепция Local-only не покидается.
 */

export interface MediaPrefs {
  bar: boolean;
  lyrics: boolean;
  cover: boolean;
}

const LS_KEY = "haloui-media";

export function loadMediaPrefs(): MediaPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { bar: false, lyrics: false, cover: true };
    const p = JSON.parse(raw) as Partial<MediaPrefs>;
    return {
      bar: p.bar === true,
      lyrics: p.lyrics === true,
      cover: p.cover !== false,
    };
  } catch {
    return { bar: false, lyrics: false, cover: true };
  }
}

export function saveMediaPrefs(p: MediaPrefs) {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}
