/**
 * Драйвер встроенного YouTube-плеера (интеграция «Интеграции → YouTube»).
 *
 * Принцип local-first: только ОФИЦИАЛЬНЫЙ embed (youtube-nocookie.com) —
 * санкционированный Google путь. Никаких ключей/OAuth/обходов: ссылку даёт
 * пользователь (или очередь), звук/видео отдаёт сам embed. Единственная
 * сеть — сам iframe и превью i.ytimg.com (img-src https: уже был).
 *
 * Управление — hand-rolled postMessage-протокол того же канала, которым
 * пользуется официальный IFrame API (enablejsapi=1): команды JSON-строкой
 * в contentWindow, состояние — push-события infoDelivery. Модуль один,
 * так что при поломке протокола миграция на официальный API-скрипт не
 * тронет UI (запасной вариант, CSP script-src остаётся чистым).
 *
 * Очередь/громкость живут в localStorage; окно плеера может быть свёрнуто —
 * iframe НЕ размонтируется (звук продолжает играть), управляет минибар.
 */

export interface YtTrack {
  videoId: string;
  title: string;
  author: string;
}

export interface YtState {
  /** iframe создан и handshaked — команды реально уходят */
  ready: boolean;
  track: YtTrack | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number; // 0..100
  queue: YtTrack[];
  queueIndex: number;
  /** Окно плеера открыто (свернутое = false, но iframe живёт) */
  open: boolean;
  /** Код ошибки embed (101/150 — видео запрещено встраивать и т.п.) */
  errorCode: number | null;
}

const LS_KEY = "haloui-yt";

let state: YtState = {
  ready: false,
  track: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 80,
  queue: [],
  queueIndex: -1,
  open: false,
  errorCode: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<YtState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeYt(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getYtState(): YtState {
  return state;
}

/** Восстановить очередь/громкость (без автозапуска — iframe нет до play) */
export function loadYtPersisted(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as { queue?: unknown; volume?: unknown };
    const queue = Array.isArray(p.queue)
      ? p.queue.filter(
          (t): t is YtTrack =>
            !!t &&
            typeof t === "object" &&
            typeof (t as YtTrack).videoId === "string" &&
            (t as YtTrack).videoId.length > 0,
        )
      : [];
    set({
      queue,
      queueIndex: queue.length > 0 ? 0 : -1,
      volume: typeof p.volume === "number" ? Math.min(100, Math.max(0, p.volume)) : 80,
    });
  } catch {
    // битый JSON — стартуем с пустой очередью
  }
}

function persist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ queue: state.queue, volume: state.volume }),
    );
  } catch {
    // переполнение квоты — очередь живёт только в памяти
  }
}

// ---------------------------------------------------------------------------
// Разбор ссылок: watch?v=, youtu.be/, shorts/, embed/, live/, голый id
// ---------------------------------------------------------------------------

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  let url: URL | null = null;
  try {
    url = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return id && ID_RE.test(id) ? id : null;
  }
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;
  const v = url.searchParams.get("v");
  if (v && ID_RE.test(v)) return v;
  const m = /^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{11})/.exec(url.pathname);
  return m?.[1] ?? null;
}

export function thumbUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

// ---------------------------------------------------------------------------
// iframe + postMessage
// ---------------------------------------------------------------------------

let iframe: HTMLIFrameElement | null = null;
let handshakeTimers: ReturnType<typeof setTimeout>[] = [];

/** React-слой регистрирует iframe после монтирования */
export function attachYtIframe(el: HTMLIFrameElement | null) {
  iframe = el;
  if (!el) {
    for (const t of handshakeTimers) clearTimeout(t);
    handshakeTimers = [];
    set({ ready: false });
  }
}

/** Базовый src первого iframe: дальше видео грузятся loadVideoById без
 *  перезагрузки фрейма (пересоздание = потеря playback-состояния) */
export function ytEmbedSrc(firstVideoId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const params = new URLSearchParams({
    enablejsapi: "1",
    autoplay: "1",
    rel: "0",
    playsinline: "1",
    iv_load_policy: "3",
    modestbranding: "1",
  });
  if (origin) params.set("origin", origin);
  return `https://www.youtube-nocookie.com/embed/${firstVideoId}?${params}`;
}

function send(func: string, args: unknown[] = []) {
  if (!iframe?.contentWindow) return;
  // targetOrigin '*': embed сам валидирует свой origin-параметр, а наш
  // origin в WebView2 (https://tauri.localhost) может не совпасть с тем,
  // что ждёт чужая сторона — команды не содержат секретов
  iframe.contentWindow.postMessage(
    JSON.stringify({ event: "command", func, args }),
    "*",
  );
}

/** Handshake «listening»: без него embed молчит. Повторы — onLoad в
 *  WebView2 срабатывает раньше, чем слушатель внутри embed поднимется */
export function ytHandshake() {
  for (const t of handshakeTimers) clearTimeout(t);
  handshakeTimers = [];
  for (const delay of [0, 400, 900, 1600]) {
    handshakeTimers.push(
      setTimeout(() => {
        iframe?.contentWindow?.postMessage(
          JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
          "*",
        );
      }, delay),
    );
  }
}

export function handleYtMessage(data: unknown) {
  if (typeof data !== "string" || !data.startsWith("{")) return;
  let msg: {
    event?: string;
    info?: {
      playerState?: number;
      currentTime?: number;
      duration?: number;
      videoData?: { video_id?: string; title?: string; author?: string };
    };
  };
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.event === "infoDelivery" && msg.info) {
    const i = msg.info;
    const patch: Partial<YtState> = {
      ready: true,
      errorCode: null,
      currentTime: typeof i.currentTime === "number" ? i.currentTime : state.currentTime,
      duration: typeof i.duration === "number" ? i.duration : state.duration,
      playing: i.playerState === 1 || i.playerState === 3,
    };
    const vd = i.videoData;
    if (vd?.video_id) {
      const track: YtTrack = {
        videoId: vd.video_id,
        title: vd.title || vd.video_id,
        author: vd.author || "",
      };
      patch.track = track;
      // Синхронизировать очередь с фактом: плеер сам перешёл на следующий
      const qi = state.queue.findIndex((t) => t.videoId === vd.video_id);
      if (qi >= 0 && qi !== state.queueIndex) patch.queueIndex = qi;
    }
    set(patch);
  } else if (msg.event === "onStateChange" && typeof msg.info === "number") {
    // Убедиться, что infoDelivery несёт числа — страховка на другой формат
    if (msg.info === 0) onEnded();
    else set({ playing: msg.info === 1 || msg.info === 3, ready: true });
  } else if (msg.event === "onError" && typeof msg.info === "number") {
    // 2/5 — плохой параметр, 100 — видео удалено, 101/150 — запрет embed
    set({ errorCode: msg.info, playing: false });
  }
}

function onEnded() {
  const next = state.queueIndex + 1;
  const nt = next >= 0 ? state.queue[next] : undefined;
  if (nt) {
    set({ queueIndex: next });
    send("loadVideoById", [nt.videoId]);
    send("playVideo");
  } else {
    set({ playing: false });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (e) => {
    if (e.origin !== "https://www.youtube-nocookie.com") return;
    handleYtMessage(e.data);
  });
  // Очередь/громкость прошлой сессии: восстанавливаются сразу, без автозапуска
  loadYtPersisted();
}

// ---------------------------------------------------------------------------
// Публичные команды (для UI и минибара)
// ---------------------------------------------------------------------------

/** Включить ссылку/ID: если что-то уже играет/стоит в очереди — добавить
 *  в конец, иначе начать с неё (первый трек создаёт iframe) */
export function ytPlayUrl(input: string): { ok: boolean; error?: string } {
  const id = parseYouTubeId(input);
  if (!id) return { ok: false, error: "bad-url" };
  const track: YtTrack = { videoId: id, title: id, author: "" };
  if (state.track) {
    const queue = [...state.queue, track];
    set({ queue });
    persist();
    return { ok: true };
  }
  set({
    track,
    queue: [track],
    queueIndex: 0,
    playing: true,
    currentTime: 0,
    duration: 0,
    errorCode: null,
  });
  persist();
  if (iframe) {
    // Повторный первый-плей после сброса очереди: iframe уже жив
    send("loadVideoById", [id]);
    send("playVideo");
  }
  // Если iframe ещё нет — его создаст React-слой по факту state.track:
  // src = embed/<id>?autoplay=1 сам стартует, handshake уйдёт из onLoad
  return { ok: true };
}

export function ytToggle(): void {
  if (!state.track) return;
  if (state.playing) send("pauseVideo");
  else send("playVideo");
}

export function ytSeek(secs: number): void {
  send("seekTo", [Math.max(0, secs), true]);
}

export function ytSetVolume(v: number): void {
  const vol = Math.min(100, Math.max(0, Math.round(v)));
  set({ volume: vol });
  send("setVolume", [vol]);
  persist();
}

export function ytNext(): void {
  const next = state.queueIndex + 1;
  const nt = next >= 0 ? state.queue[next] : undefined;
  if (!nt) return;
  set({ queueIndex: next, playing: true, currentTime: 0, duration: 0 });
  send("loadVideoById", [nt.videoId]);
  send("playVideo");
}

export function ytPrev(): void {
  const prev = state.queueIndex - 1;
  const pt = prev >= 0 ? state.queue[prev] : undefined;
  if (!pt) return;
  set({ queueIndex: prev, playing: true, currentTime: 0, duration: 0 });
  send("loadVideoById", [pt.videoId]);
  send("playVideo");
}

export function ytRemoveAt(index: number): void {
  if (index < 0 || index >= state.queue.length) return;
  const queue = state.queue.filter((_, i) => i !== index);
  let queueIndex = state.queueIndex;
  if (index < state.queueIndex) queueIndex -= 1;
  else if (index === state.queueIndex) queueIndex = -1;
  set({ queue, queueIndex });
  persist();
}

/** Прыжок по очереди из UI (клик по пункту) */
export function ytPlayAt(index: number): void {
  const it = index >= 0 ? state.queue[index] : undefined;
  if (!it) return;
  set({ queueIndex: index, playing: true, currentTime: 0, duration: 0 });
  send("loadVideoById", [it.videoId]);
  send("playVideo");
}

export function ytSetOpen(open: boolean): void {
  set({ open });
}

export function ytToggleOpen(): void {
  set({ open: !state.open });
}

/** Полный сброс (интеграция выключена — слой размонтирован) */
export function ytReset(): void {
  attachYtIframe(null);
  set({
    ready: false,
    track: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    queue: [],
    queueIndex: -1,
    errorCode: null,
  });
}
