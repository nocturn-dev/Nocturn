import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isSeqGap } from "./hooks/streamBuffer";

/** Сохранённый профиль ключа: связка «ключ + провайдер + модель» для быстрого
    переключения. Живёт внутри ApiSettings (settings.json). */
export interface ApiProfile {
  id: string;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  provider: string;
  /** Fallback-модель профиля (подставляется вместе с остальной связкой) */
  fallback_model?: string;
  /** Оформление, сохранённое вместе с профилем (opt-in «тема из профиля») */
  appearance?: Partial<Appearance>;
}

export interface ApiSettings {
  api_key: string;
  base_url: string;
  model: string;
  /** Метка пресета провайдера ("deepseek", "anthropic", …; "custom" — свой URL) */
  provider: string;
  /** Шифрование ключей (AES-256-GCM + Credential Manager) */
  encrypt_keys?: boolean;
  /** Fallback-модель: второй прогон при исчерпании ретраев на 429/5xx */
  fallback_model?: string;
}

/** Хранилище профилей: profiles.json (Rust) / localStorage (превью) */
export interface ProfilesStore {
  profiles: ApiProfile[];
  /** id применённого профиля ("" — ручной ввод) */
  active: string;
}

const LS_PROFILES = "haloui-profiles";

export async function loadProfiles(): Promise<ProfilesStore> {
  if (!inTauri) {
    const raw = localStorage.getItem(LS_PROFILES);
    if (!raw) return { profiles: [], active: "" };
    try {
      return JSON.parse(raw) as ProfilesStore;
    } catch {
      // битый localStorage (браузерное превью) — не кидаем исключение в загрузчике
      return { profiles: [], active: "" };
    }
  }
  return invoke<ProfilesStore>("load_profiles");
}

export async function saveProfiles(
  store: ProfilesStore,
  encrypt = false,
): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(LS_PROFILES, JSON.stringify(store));
    return;
  }
  return invoke("save_profiles", {
    profiles: store.profiles,
    active: store.active,
    encrypt,
  });
}

/** Включить/выключить шифрование ключей: перезаписывает settings.json
    и profiles.json на диске (шифрует или расшифровывает ключи) */
export async function setKeyEncryption(enable: boolean): Promise<void> {
  if (!inTauri) return;
  return invoke("set_key_encryption", { enable });
}

// ---------- Мастер-пароль (Zero-Knowledge режим) ----------

export interface CryptoStatus {
  /** Шифрование включено (encrypt_keys в settings.json) */
  enabled: boolean;
  /** Пароль уже создан (crypto.json существует) */
  setup: boolean;
  /** Ключ в памяти — ввод пароля уже прошёл */
  unlocked: boolean;
}

export async function cryptoStatus(): Promise<CryptoStatus> {
  if (!inTauri) {
    return { enabled: false, setup: false, unlocked: false };
  }
  return invoke<CryptoStatus>("crypto_status");
}

/** Первое создание мастер-пароля (минимум 8 символов) */
export async function cryptoSetup(password: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Хранилище ключей работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("crypto_setup", { password });
}

/** Разблокировка существующим паролем */
export async function cryptoUnlock(password: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Хранилище ключей работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("crypto_unlock", { password });
}

/** Полный сброс: зашифрованные ключи будут утеряны (confirm="RESET") */
export async function cryptoReset(confirm = "RESET"): Promise<void> {
  if (!inTauri) {
    throw new Error("Хранилище ключей работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("crypto_reset", { confirm });
}

export async function loadProjectsStore(): Promise<unknown> {
  if (!inTauri) return null;
  return invoke<unknown>("load_projects");
}

export async function saveProjectsStore(projects: unknown): Promise<void> {
  if (!inTauri) return;
  return invoke("save_projects", { projects });
}

/** Пресеты провайдеров: клик подставляет Base URL, нужен только API-ключ.
    kind "anthropic" — нативный протокол (адаптер выбирается в Rust по URL). */
import type { Appearance } from "./appearance";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  kind: "openai" | "anthropic";
}

export const PROVIDERS: ProviderPreset[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "openai" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", kind: "openai" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", kind: "openai" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", kind: "openai" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", kind: "openai" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", kind: "openai" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", kind: "openai" },
  { id: "nanogpt", label: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", kind: "openai" },
  { id: "requesty", label: "Requesty", baseUrl: "https://router.requesty.ai/v1", kind: "openai" },
  { id: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", kind: "openai" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", kind: "anthropic" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", kind: "openai" },
  { id: "colibri", label: "Colibri", baseUrl: "http://localhost:8000/v1", kind: "openai" },
  { id: "litellm", label: "LiteLLM", baseUrl: "http://localhost:4000/v1", kind: "openai" },
];

/** Восстановить метку провайдера по Base URL (для старых настроек без поля) */
export function providerFromBaseUrl(baseUrl: string): string {
  const norm = baseUrl.trim().toLowerCase();
  const hit = PROVIDERS.find((p) => {
    try {
      return new URL(p.baseUrl).host === new URL(norm).host;
    } catch {
      return false;
    }
  });
  return hit?.id ?? "custom";
}

export interface ChatMsgParam {
  role: string;
  // Строка ИЛИ массив [{type:"text"|"image_url", ...}] для vision-моделей
  content: unknown;
  // Агентные поля: assistant с tool_calls, tool с tool_call_id
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
  /** Thinking-блок Anthropic {thinking, signature, redacted} для assistant-хода:
      Messages API требует вернуть его для хода с tool_use при extended thinking */
  thinking?: unknown;
}

let cachedSchemas: unknown = null;

/** M3: OpenAI-схемы инструментов агента (+ инструменты MCP-серверов).
    Кэш сбрасывается при изменении набора соединений — вызов дешёвый. */
export async function getToolSchemas(): Promise<unknown> {
  if (!inTauri) {
    throw new Error("Agent mode works in the native app (npm run tauri dev)");
  }
  // FIX: кэш существовал, но никогда не читался (write-only) — каждый агентный
  // send платил лишний IPC-раундтрип. Читаем до invoke; invalidateToolSchemas
  // снова обретает смысл.
  if (cachedSchemas !== null) return cachedSchemas;
  cachedSchemas = await invoke<unknown>("get_tool_schemas");
  return cachedSchemas;
}

export function invalidateToolSchemas(): void {
  cachedSchemas = null;
}

/** M3: исполнение инструмента агента в Rust. requestId связывает вызов с
 * прогоном: Stop поднимает флаг отмены и Rust убивает процесс немедленно.
 * disabledTools — чёрный список задачи: сервер отклонит скрытый инструмент,
 * даже если схема просочилась в запрос (субагенты наследуют список) */
export async function runTool(
  name: string,
  args: string,
  requestId?: string,
  disabledTools?: string[],
): Promise<string> {
  if (!inTauri) {
    throw new Error("Agent mode works in the native app (npm run tauri dev)");
  }
  return invoke<string>("run_tool", {
    name,
    arguments: args,
    requestId,
    disabledTools: disabledTools ?? [],
  });
}

/** Синхронизация серверного слоя прав (PermMode + project roots) */
export async function permSet(mode: string, roots: string[]): Promise<void> {
  if (!inTauri) return;
  return invoke("perm_set", { mode, roots });
}

// FIX: ToolCallInfo определялся здесь И в types.ts (дублирующие контракты —
// рассинхрон не ловил компилятор). Единый контракт — в types.ts
import type { ToolCallInfo } from "./types";
export type { ToolCallInfo };

/** В браузерном превью (npm run dev) Tauri недоступен — храним в localStorage */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LS_SETTINGS = "haloui-api";
const LS_SESSIONS = "haloui-sessions";

export const DEFAULT_SETTINGS: ApiSettings = {
  api_key: "",
  base_url: "https://openrouter.ai/api/v1",
  model: "",
  provider: "openrouter",
};

export async function loadSettings(): Promise<ApiSettings> {
  if (!inTauri) {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return JSON.parse(raw) as ApiSettings;
    } catch {
      // битый localStorage — дефолты вместо исключения
      return { ...DEFAULT_SETTINGS };
    }
  }
  return invoke<ApiSettings>("load_settings");
}

export async function saveSettings(settings: ApiSettings): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    return;
  }
  return invoke("save_settings", { settings });
}

export interface ModelInfo {
  id: string;
  vision: boolean;
  text: boolean;
  /** Контекстное окно от провайдера (если отдаёт в /models); null — нет данных */
  context: number | null;
}

export async function testConnection(
  baseUrl: string,
  apiKey: string,
): Promise<ModelInfo[]> {
  if (!inTauri) {
    throw new Error(
      "Проверка подключения работает в нативном приложении (npm run tauri dev)",
    );
  }
  return invoke<ModelInfo[]>("test_connection", { baseUrl, apiKey });
}

export interface ChatUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Стриминговый чат. Rust читает SSE и пробрасывает события:
 * "chat-chunk" (текст), "chat-thought" (reasoning) и "chat-usage" (токены).
 * Команда разрешается при успешном завершении потока и отклоняется при ошибке.
 */
export async function chatStream(opts: {
  requestId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMsgParam[];
  /** Определения инструментов для агентного режима (M2) */
  tools?: unknown;
  /** Усилие размышлений: "off"/null — не отправлять провайдеру */
  reasoningEffort?: "off" | "low" | "high" | "max";
  /** Метка провайдера из настроек ("anthropic", …): выбор адаптера протокола
      на бэкенде. Раньше адаптер выбирался поиском "api.anthropic.com" в
      Base URL — прокси с таким путём получал чужой формат авторизации */
  provider?: string;
  onDelta: (delta: string, seq?: number) => void;
  onThought: (thought: string, seq?: number) => void;
  /** Барьер (ZCode-паттерн, блок 12): событие-финал — обработчик обязан
   *  дренировать батч-буфер дельт до обработки барьера */
  onUsage: (usage: ChatUsage, barrier?: boolean, seq?: number) => void;
  onToolCalls?: (calls: ToolCallInfo[], barrier?: boolean, seq?: number) => void;
  /** Закрытый thinking-блок Anthropic: подпись + redacted для возврата в историю */
  onThinkingBlock?: (block: { thinking: string; signature: string; redacted: string[] }, seq?: number) => void;
}): Promise<void> {
  if (!inTauri) {
    throw new Error("Чат работает в нативном приложении (npm run tauri dev)");
  }

  // FIX [HIGH]: все 4 регистрации теперь внутри try и через Promise.all —
  // если любая упадёт, finally снимет уже установленные. Раньше упавший
  // 3-й/4-й listen терял unlisten-функции первых двух: вечная утечка слушателей
  // на каждый неудавшийся send.
  const offs: Array<() => void> = [];
  // Гэп-детект: seq идёт сквозь все каналы потока; пропуск в DEV — сигнал
  // потерянного события (в релизе молча, чтобы не шуметь)
  let lastSeq = -1;
  const checkSeq = (seq?: number) => {
    if (seq === undefined) return;
    if (isSeqGap(lastSeq, seq)) {
      if (import.meta.env.DEV) {
        console.warn(`[feed] seq gap: ${lastSeq} -> ${seq}`);
      }
    }
    lastSeq = seq;
  };
  try {
    offs.push(
      ...(await Promise.all([
        listen<{ requestId: string; delta: string; seq?: number }>("chat-chunk", (e) => {
          if (e.payload.requestId === opts.requestId) {
            checkSeq(e.payload.seq);
            opts.onDelta(e.payload.delta, e.payload.seq);
          }
        }),
        listen<{ requestId: string; thought: string; seq?: number }>("chat-thought", (e) => {
          if (e.payload.requestId === opts.requestId) {
            checkSeq(e.payload.seq);
            opts.onThought(e.payload.thought, e.payload.seq);
          }
        }),
        listen<{
          requestId: string;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
          barrier?: boolean;
          seq?: number;
        }>("chat-usage", (e) => {
          if (e.payload.requestId === opts.requestId) {
            checkSeq(e.payload.seq);
            opts.onUsage(
              {
                prompt: e.payload.promptTokens,
                completion: e.payload.completionTokens,
                total: e.payload.totalTokens,
              },
              e.payload.barrier,
              e.payload.seq,
            );
          }
        }),
        listen<{ requestId: string; calls: ToolCallInfo[]; barrier?: boolean; seq?: number }>(
          "chat-tool-calls",
          (e) => {
            if (e.payload.requestId === opts.requestId) {
              checkSeq(e.payload.seq);
              opts.onToolCalls?.(e.payload.calls, e.payload.barrier, e.payload.seq);
            }
          },
        ),
        listen<{
          requestId: string;
          thinking: string;
          signature: string;
          redacted: string[];
          seq?: number;
        }>("chat-thinking", (e) => {
          if (e.payload.requestId === opts.requestId) {
            checkSeq(e.payload.seq);
            opts.onThinkingBlock?.(e.payload, e.payload.seq);
          }
        }),
      ])),
    );
    await invoke("chat_stream", {
      requestId: opts.requestId,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools ?? null,
      provider: opts.provider ?? null,
      // Ключ аргумента должен быть camelCase: Tauri 2 ищет параметры команды
      // по to_lower_camel_case(rust_name), snake_case молча превращался в null
      reasoningEffort:
        opts.reasoningEffort && opts.reasoningEffort !== "off"
          ? opts.reasoningEffort
          : null,
    });
  } finally {
    // FIX: снимаем только то, что успело установиться; двойной вызов off безопасен
    for (const off of offs) {
      try {
        off();
      } catch {
        // уже снят — не падаем
      }
    }
  }
}

/** Реальное прерывание: Rust поднимает флаг отмены, поток гаснет */
export async function abortChat(requestId: string): Promise<void> {
  if (!inTauri) return;
  return invoke("chat_abort", { requestId });
}

/** Автообнаружение локальной Ollama (localhost:11434). null — не найдена */
export async function detectOllama(): Promise<string[] | null> {
  if (!inTauri) {
    // В браузерном превью пробуем напрямую (Ollama разрешает CORS для localhost)
    try {
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), 3000);
      const r = await fetch("http://localhost:11434/v1/models", {
        signal: ctl.signal,
      });
      window.clearTimeout(timer);
      if (!r.ok) return null;
      const j = (await r.json()) as { data?: { id: string }[] };
      return (j.data ?? []).map((m) => m.id);
    } catch {
      return null;
    }
  }
  return invoke<string[] | null>("detect_ollama");
}

export async function loadSessions(): Promise<string | null> {
  if (!inTauri) {
    return localStorage.getItem(LS_SESSIONS);
  }
  return invoke<string | null>("load_sessions");
}

export async function saveSessions(data: string): Promise<void> {
  if (!inTauri) {
    localStorage.setItem(LS_SESSIONS, data);
    return;
  }
  return invoke("save_sessions", { data });
}

/** Сессии проекта: читаются из <root>/.nocturn/sessions.json (ZCode-стиль —
 *  данные проекта живут в папке проекта). Нет хранилища — null */
export async function loadProjectSessions(root: string): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("load_project_sessions", { root });
}

/** Сессии проекта: атомарная запись в <root>/.nocturn/sessions.json */
export async function saveProjectSessions(root: string, data: string): Promise<void> {
  if (!inTauri) return;
  return invoke("save_project_sessions", { root, data });
}

// ---------- M4.2: файловый менеджер ----------

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

/** Ambient: системный диалог выбора видеофайла пользователя (mp4/webm/…).
 *  null — пользователь отменил */
export async function pickVideoFile(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Выбор видео работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Video", extensions: ["mp4", "webm", "mov", "m4v", "mkv", "ogv", "ogg"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** Ambient: разрешить вебвью читать выбранное видео (asset-протокол,
 *  скоуп расширяется ровно на этот файл) */
export async function ambientRegisterVideo(path: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Ambient-видео работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("ambient_video_register", { path });
}

/** Диалог выбора произвольного файла (открытие файла как проекта).
 *  null — пользователь отменил */
export async function pickAnyFile(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false });
  return typeof picked === "string" ? picked : null;
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Выбор папки работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

/** Содержимое папки для дерева файлов (папки первыми) */
export async function listDir(path: string): Promise<FileEntry[]> {
  if (!inTauri) {
    throw new Error("Файловый менеджер работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<FileEntry[]>("list_dir", { path });
}

/** Git-статус папки (M5.1): относительный путь + код porcelain. null — не git-repo */
export interface GitEntry {
  path: string;
  code: string;
}

export async function gitStatus(path: string): Promise<GitEntry[] | null> {
  if (!inTauri) return null;
  try {
    return await invoke<GitEntry[]>("git_status", { path });
  } catch {
    return null; // не-repo или git отсутствует — просто без подсветки
  }
}

// ---------- Чекпоинты проекта ----------

export interface CheckpointMeta {
  id: string;
  ts: number;
  label: string;
  files: number;
  bytes: number;
  /** SHA коммита git-журнала (opt-in режим, блок 12 шаг 4) */
  git?: string;
}

/** Снимок файлов проекта; возвращает метаданные созданного чекпоинта.
 *  useGit — дополнительно записать коммит в git-журнал чекпоинтов
 *  (отдельный index-dir, ботовый автор); без git или без галочки — снимок
 *  как обычно */
export async function checkpointSave(
  path: string,
  label: string,
  useGit?: boolean,
): Promise<CheckpointMeta | null> {
  if (!inTauri) return null;
  try {
    return await invoke<CheckpointMeta>("checkpoint_save", {
      path,
      label,
      useGit: useGit === true,
    });
  } catch {
    return null; // нет доступа к папке — пропускаем, не мешая задаче
  }
}

export async function checkpointList(path: string): Promise<CheckpointMeta[]> {
  if (!inTauri) return [];
  try {
    return await invoke<CheckpointMeta[]>("checkpoint_list", { path });
  } catch {
    return [];
  }
}

/** Восстановить файлы из снимка; возвращает число восстановленных файлов */
export async function checkpointRestore(path: string, id: string): Promise<number> {
  if (!inTauri) {
    throw new Error("Откат чекпоинта работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<number>("checkpoint_restore", { path, id });
}

export async function checkpointDelete(path: string, id: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Удаление чекпоинта работает в нативном приложении (npm run tauri dev)");
  }
  await invoke("checkpoint_delete", { path, id });
}

/** Состояние файла снимка: «до» (base64) + текущее с диска (base64, null =
 *  удалён после снимка либо крупнее капа). Источник живого диффа для Review */
export interface CheckpointFileState {
  rel: string;
  before: string;
  current: string | null;
}

export async function checkpointFiles(
  path: string,
  id: string,
): Promise<CheckpointFileState[]> {
  if (!inTauri) return [];
  return invoke<CheckpointFileState[]>("checkpoint_files", { path, id });
}

// ---------- Автозапуск с ОС (tauri-plugin-autostart; JS-пакет не нужен —
// команды плагина дергаются invoke-ом напрямую) ----------

export async function autostartIsEnabled(): Promise<boolean> {
  if (!inTauri) return false;
  return invoke<boolean>("plugin:autostart|is_enabled");
}

export async function autostartSet(enable: boolean): Promise<void> {
  if (!inTauri) {
    throw new Error("Автозапуск работает в нативном приложении (npm run tauri dev)");
  }
  return invoke(enable ? "plugin:autostart|enable" : "plugin:autostart|disable");
}

// ---------- Хранилище (размеры каталогов appdata + очистка) ----------

export interface StorageStats {
  config: number;
  checkpoints: number;
  images: number;
  sounds: number;
  fonts: number;
}

export async function storageStats(): Promise<StorageStats | null> {
  if (!inTauri) return null;
  return invoke<StorageStats>("storage_stats");
}

/** kind: "checkpoints" | "images" — возвращает число удалённых записей */
export async function storageCleanup(kind: string): Promise<number> {
  if (!inTauri) {
    throw new Error("Очистка хранилища работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<number>("storage_cleanup", { kind });
}

// ---------- Quick Entry (глобальное комбо + окно быстрого ввода) ----------

/** Ремап глобального комбо; формат плагина — "ctrl+alt+space" */
export async function quickentrySetBind(combo: string): Promise<void> {
  if (!inTauri) return;
  await invoke("quickentry_set_bind", { combo });
}

/** Зарегистрирован ли глобальный комбо: на Wayland-подобных системах — false */
export async function quickentryStatus(): Promise<boolean> {
  if (!inTauri) return true;
  return invoke<boolean>("quickentry_status");
}

/** Enter в Quick Entry: спрятать окно, сфокусировать главное, отдать текст */
export async function quickentrySubmit(text: string): Promise<void> {
  await invoke("quickentry_submit", { text });
}

/** Текст новой задачи из Quick Entry (слушает главное окно) */
export async function onQuickEntryTask(
  cb: (text: string) => void,
): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<string>("quickentry-task", (e) => cb(e.payload));
}

// ---------- Долговременная память агента (memory.json) ----------

export interface MemoryFact {
  id: string;
  text: string;
  /** Миллисунды — «когда запомнено» */
  ts: number;
}

export async function memoryList(): Promise<MemoryFact[]> {
  if (!inTauri) return [];
  return invoke<MemoryFact[]>("memory_list");
}

export async function memoryAdd(text: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Память работает в нативном приложении (npm run tauri dev)");
  }
  await invoke("memory_add", { text });
}

export async function memoryDelete(id: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Память работает в нативном приложении (npm run tauri dev)");
  }
  await invoke("memory_delete", { id });
}

export async function memoryClear(): Promise<void> {
  if (!inTauri) {
    throw new Error("Память работает в нативном приложении (npm run tauri dev)");
  }
  await invoke("memory_clear");
}

// ---------- Разовый вызов модели (Рефлексия в «Обзоре») ----------

/** Non-streaming completion без инструментов: сводка → короткий итог */
export async function chatOnce(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!inTauri) {
    throw new Error("Вызов модели работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<string>("chat_once", {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    provider: opts.provider ?? null,
    system: opts.system,
    user: opts.user,
    maxTokens: opts.maxTokens ?? 600,
  });
}

/** Правила проекта: AGENTS.md или CLAUDE.md из корня (null — файла нет) */
export async function projectRulesRead(root: string): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("project_rules_read", { root });
}

// ---------- Сетевые настройки (прокси / исключения / CA) ----------

export interface NetworkConfig {
  proxy: string;
  no_proxy: string;
  ca_path: string;
}

/** Сменить иконку трея (bold | classic); no-op вне Tauri */
export async function setTrayVariant(kind: "bold" | "classic"): Promise<void> {
  if (!inTauri) return;
  await invoke("set_tray_variant", { kind });
}

export async function networkGetConfig(): Promise<NetworkConfig> {
  if (!inTauri) return { proxy: "", no_proxy: "", ca_path: "" };
  return invoke("network_get_config");
}

export async function networkSetConfig(cfg: NetworkConfig): Promise<void> {
  if (!inTauri) return;
  await invoke("network_set_config", { config: cfg });
}

// ---------- M6: интерактивный PTY-терминал ----------

export async function ptyCreate(
  id: string,
  cwd: string | null,
  cols: number,
  rows: number,
  /** "cmd" | "gitbash"; undefined — PowerShell (auto) */
  shell?: string,
): Promise<void> {
  if (!inTauri) {
    throw new Error("Консоль работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("pty_create", { id, cwd, cols, rows, shell });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  if (!inTauri) return;
  return invoke("pty_write", { id, data });
}

/** D7: ресайз PTY под текущий размер панели (сигнал SIGWINCH для шелла) */
export async function ptyResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!inTauri) return;
  return invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  if (!inTauri) return;
  return invoke("pty_kill", { id });
}

// ---------- M-N1: заметки (vault) ----------

export interface NoteInfo {
  file: string;
  title: string;
  updated: number;
}

export async function notesList(): Promise<NoteInfo[]> {
  if (!inTauri) return [];
  return invoke<NoteInfo[]>("notes_list");
}

export async function notesRead(file: string): Promise<string> {
  if (!inTauri) return "";
  return invoke<string>("notes_read", { file });
}

export async function notesWrite(file: string, content: string): Promise<void> {
  if (!inTauri) return;
  return invoke("notes_write", { file, content });
}

export async function notesDelete(file: string): Promise<void> {
  if (!inTauri) return;
  return invoke("notes_delete", { file });
}

/** Грубая эвристика по имени, когда провайдер не отдаёт лимит в /models.
    Актуальные крупные окна учитывает; для неизвестных — консервативные 128k. */
function heuristicContextLimit(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("1m") || m.includes("-1m")) return 1_000_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("gpt-6") || m.includes("astra") || m.includes("gpt 6"))
    return 400_000;
  if (m.includes("gpt-5") || m.includes("o3") || m.includes("o4"))
    return 256_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("grok")) return 131_072;
  if (m.includes("kimi") || m.includes("moonshot")) return 256_000;
  if (m.includes("glm")) return 200_000;
  if (m.includes("llama")) return 128_000;
  if (m.includes("qwen")) return 262_144;
  if (m.includes("deepseek")) return 163_840;
  return 128_000;
}

/** Лимит контекста модели: сначала реальное значение от провайдера
    (точный id, затем нечёткий матч — провайдеры пишут id по-разному),
    эвристика "256k" в имени, затем эвристика по имени */
export function contextLimitFor(
  model: string,
  models: ModelInfo[] | null | undefined,
): number {
  const withCtx = (models ?? []).filter(
    (m) => typeof m.context === "number" && m.context > 0,
  );
  const hit =
    withCtx.find((m) => m.id === model) ??
    withCtx.find(
      (m) =>
        m.id.toLowerCase().includes(model.toLowerCase()) ||
        model.toLowerCase().includes(m.id.toLowerCase()),
    );
  if (hit?.context) return hit.context;
  // "…-256k" / "128k" прямо в имени модели
  const km = /(?:^|[^a-z0-9])(\d{2,4})\s*k(?:[a-z]|$)/i.exec(model);
  if (km) {
    const n = parseInt(km[1] ?? "", 10);
    if (n >= 16 && n <= 2048) return n * 1000;
  }
  return heuristicContextLimit(model);
}

// ---------- MCP: внешние инструменты-серверы ----------

export interface McpServerCfg {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** "http" | "sse" — удалённый сервер (streamable HTTP); нет — stdio-процесс */
  transport?: string;
  /** Endpoint удалённого сервера */
  url?: string;
  /** Заголовки запроса (Authorization: Bearer …) — токены доступа */
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  tools: McpToolInfo[];
}

export async function mcpListServers(): Promise<McpServerCfg[]> {
  if (!inTauri) return [];
  return invoke<McpServerCfg[]>("mcp_list_servers");
}

export async function mcpSaveServers(servers: McpServerCfg[]): Promise<void> {
  if (!inTauri) return;
  return invoke("mcp_save_servers", { servers });
}

/** Подключить сервер: возвращает обнаруженные инструменты */
export async function mcpConnect(name: string): Promise<McpToolInfo[]> {
  if (!inTauri) {
    throw new Error("MCP works in the native app (npm run tauri dev)");
  }
  return invoke<McpToolInfo[]>("mcp_connect", { name });
}

export async function mcpDisconnect(name: string): Promise<void> {
  if (!inTauri) return;
  return invoke("mcp_disconnect", { name });
}

export async function mcpStatus(): Promise<McpServerStatus[]> {
  if (!inTauri) return [];
  return invoke<McpServerStatus[]>("mcp_status");
}

/** Автоконнект включённых серверов при старте; возвращает сколько удалось */
export async function mcpAutoconnect(): Promise<number> {
  if (!inTauri) return 0;
  return invoke<number>("mcp_autoconnect");
}

// ---------- Browser Use / Computer Use (настройки) ----------

export interface BrowserConfig {
  enabled: boolean;
  headless: boolean;
  executable: string;
  /** SSRF-защита: разрешить навигацию в private/loopback-сеть */
  allowPrivateNetworks: boolean;
}

export interface ComputerConfig {
  enabled: boolean;
}

export async function browserGetConfig(): Promise<BrowserConfig> {
  if (!inTauri)
    return { enabled: true, headless: true, executable: "", allowPrivateNetworks: false };
  return invoke<BrowserConfig>("browser_get_config");
}

export async function browserSetConfig(config: BrowserConfig): Promise<void> {
  if (!inTauri) return;
  return invoke("browser_set_config", { config });
}

export async function computerGetConfig(): Promise<ComputerConfig> {
  if (!inTauri) return { enabled: true };
  return invoke<ComputerConfig>("computer_get_config");
}

export async function computerSetConfig(config: ComputerConfig): Promise<void> {
  if (!inTauri) return;
  return invoke("computer_set_config", { config });
}

// ---------- Генерация изображений (настройки; сам инструмент — в агенте) ----------

export interface ImageGenConfig {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  size: string;
}

export async function imageGenGetConfig(): Promise<ImageGenConfig> {
  // Браузерное превью: безопасная заглушка вместо raw TypeError из invoke
  if (!inTauri) return { enabled: false, base_url: "", api_key: "", model: "", size: "" };
  return invoke<ImageGenConfig>("imagegen_get_config");
}

export async function imageGenSetConfig(config: ImageGenConfig): Promise<void> {
  if (!inTauri) {
    throw new Error("Настройка генерации картинок работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("imagegen_set_config", { config });
}

// ---------- Веб-поиск (SearXNG / Brave) ----------

export interface WebSearchConfig {
  enabled: boolean;
  /** "searxng" | "brave" */
  provider: string;
  searxng_url: string;
  brave_key: string;
}

export async function webSearchGetConfig(): Promise<WebSearchConfig> {
  if (!inTauri) return { enabled: false, provider: "searxng", searxng_url: "", brave_key: "" };
  return invoke<WebSearchConfig>("websearch_get_config");
}

export async function webSearchSetConfig(config: WebSearchConfig): Promise<void> {
  if (!inTauri) {
    throw new Error("Настройка веб-поиска работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("websearch_set_config", { config });
}

// ---------- Свои звуки уведомлений ----------

/** Диалог выбора файла шрифта; null — пользователь отменил */
export async function pickFontFile(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Импорт шрифта работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2"] }],
  });
  return typeof picked === "string" ? picked : null;
}

// ---------- Пользовательские шрифты (appdata/fonts, asset-протокол) ----------

export interface CustomFont {
  id: string;
  /** Безопасное CSS-имя семейства (генерируется в Rust) */
  family: string;
  /** Отображаемое имя */
  name: string;
  path: string;
}

export async function fontImport(src: string): Promise<CustomFont> {
  if (!inTauri) {
    throw new Error("Импорт шрифта работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<CustomFont>("font_import", { src });
}

export async function fontList(): Promise<CustomFont[]> {
  if (!inTauri) return [];
  return invoke<CustomFont[]>("font_list");
}

export async function fontDelete(id: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Удаление шрифта работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("font_delete", { id });
}

/** Диалог выбора картинки (обои чата); null — отмена */
export async function pickImageFile(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Выбор картинки работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Обои чата: разрешить вебвью читать выбранную картинку (asset-протокол) */
export async function wallpaperRegister(path: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Обои чата работают в нативном приложении (npm run tauri dev)");
  }
  return invoke("wallpaper_register", { path });
}

export async function pickAudioFile(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Импорт звука работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "flac"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** Импортировать файл; возвращает "имя|расширение" */
export async function soundImport(src: string): Promise<string> {
  if (!inTauri) {
    throw new Error("Импорт звука работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<string>("sound_import", { src });
}

/** Своя мелодия как data URL; null — не импортирована */
export async function soundData(): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("sound_data");
}

export async function soundDelete(): Promise<void> {
  if (!inTauri) return;
  return invoke("sound_delete");
}

/** Не давать компьютеру уснуть (Automations) */
export async function keepAwake(enable: boolean): Promise<void> {
  if (!inTauri) return;
  return invoke("keep_awake", { enable });
}

// ---------- Живой просмотр браузера агента ----------

export interface BrowserFrame {
  /** JPEG base64 — только при изменении кадра; null = картинка прежняя */
  data: string | null;
  url: string;
}

export async function browserViewStart(): Promise<void> {
  if (!inTauri) return;
  return invoke("browser_view_start");
}

export async function browserViewStop(): Promise<void> {
  if (!inTauri) return;
  return invoke("browser_view_stop");
}

/** Размер вьюпорта агентовского браузера (null/null — как есть) */
export async function browserViewSetSize(w: number | null, h: number | null): Promise<void> {
  if (!inTauri) return;
  return invoke("browser_view_size", { w, h });
}

/** Подписка на кадры живого просмотра; возвращает функцию отписки */
export async function listenBrowserFrame(
  cb: (f: BrowserFrame) => void,
): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<BrowserFrame>("browser-frame", (e) => cb(e.payload));
}

/** Пункт «Clear All Data» в трее: окно показано, фронт просит подтверждение */
export async function onClearDataRequest(cb: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen("clear-data-request", () => cb());
}

/** Полный сброс: стереть пользовательские данные и перезапустить приложение.
 *  Не возвращает управление — процесс рестартует. confirm="RESET" —
 *  серверный гардал (паритет с crypto_reset): фронтовой модалки недостаточно. */
export async function factoryReset(): Promise<void> {
  if (!inTauri) {
    throw new Error("Полный сброс работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("factory_reset", { confirm: "RESET" });
}

// ---------- Colibri (локальный MoE-движок, coli serve) ----------

export interface ColibriStatus {
  running: boolean;
  pid?: number;
}

/** Параметры запуска coli serve; модель и ключ уходят в COLI_MODEL/COLI_API_KEY */
export interface ColibriLaunch {
  exe: string;
  model?: string;
  apiKey?: string;
  args?: string;
}

/** Запустить сервер; если уже запущен — возвращает его статус без второго процесса */
export async function colibriStart(launch: ColibriLaunch): Promise<ColibriStatus> {
  if (!inTauri) {
    throw new Error("Запуск coli serve работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<ColibriStatus>("colibri_start", { launch });
}

export async function colibriStop(): Promise<ColibriStatus> {
  if (!inTauri) {
    throw new Error("Остановка coli serve работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<ColibriStatus>("colibri_stop");
}

export async function colibriStatus(): Promise<ColibriStatus> {
  // Браузерное превью: безопасная заглушка вместо raw TypeError из invoke
  if (!inTauri) return { running: false };
  return invoke<ColibriStatus>("colibri_status");
}

/** Поток логов сервера (stdout как есть, stderr с префиксом "[err] ") */
export async function listenColibriLog(cb: (line: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return await listen<string>("colibri-log", (e) => cb(e.payload));
}

/** Конфиг запуска Colibri — UI-уровень (exe/порт/аргументы), живёт в localStorage */
export interface ColibriLocal {
  exe: string;
  port: number;
  args: string;
}

export const COLIBRI_DEFAULT: ColibriLocal = { exe: "coli", port: 8000, args: "" };

export function loadColibriLocal(): ColibriLocal {
  try {
    return {
      ...COLIBRI_DEFAULT,
      ...(JSON.parse(localStorage.getItem("haloui-colibri") ?? "{}") as Partial<ColibriLocal>),
    };
  } catch {
    return { ...COLIBRI_DEFAULT };
  }
}

export function saveColibriLocal(c: ColibriLocal): void {
  localStorage.setItem("haloui-colibri", JSON.stringify(c));
}

// ---------- Хуки (пользовательские команды на событиях агента) ----------

export interface Hook {
  id: string;
  event: string; // PreToolUse | PostToolUse | UserPromptSubmit | Stop | SessionStart
  /** Подстрока имени инструмента; пусто = все */
  matcher: string;
  command: string;
  /** Секунды */
  timeout: number;
  enabled: boolean;
}

export interface HookFile {
  hooks: Hook[];
}

export interface HookOutcome {
  id: string;
  ran: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  blocked: boolean;
  reason: string;
  additionalContext: string;
}

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
] as const;

export async function hooksLoad(): Promise<HookFile> {
  if (!inTauri) return { hooks: [] };
  return invoke<HookFile>("hooks_load");
}

export async function hooksSave(file: HookFile): Promise<void> {
  if (!inTauri) return;
  return invoke("hooks_save", { file });
}

/** Прогнать хук на пробном payload (кнопка «Тест») */
export async function hooksTest(hook: Hook, payload: unknown): Promise<HookOutcome> {
  if (!inTauri) {
    throw new Error("Тест хуков работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<HookOutcome>("hooks_test", { hook, payload });
}

/** Событие из фронтенда: UserPromptSubmit / Stop / SessionStart */
export async function hooksRunEvent(event: string, payload: unknown): Promise<HookOutcome[]> {
  if (!inTauri) return [];
  return invoke<HookOutcome[]>("hooks_run_event", { event, payload });
}

// ---------- Пользовательские горячие клавиши ----------

export async function shortcutsLoad(): Promise<Record<string, string>> {
  if (!inTauri) return {};
  return invoke<Record<string, string>>("shortcuts_load");
}

export async function shortcutsSave(binds: unknown): Promise<void> {
  if (!inTauri) return;
  return invoke("shortcuts_save", { binds });
}

// ---------- Цвета моделей в статистике ----------

export async function usageColorsLoad(): Promise<Record<string, string>> {
  if (!inTauri) return {};
  return invoke<Record<string, string>>("usage_colors_load");
}

export async function usageColorsSave(colors: Record<string, string>): Promise<void> {
  if (!inTauri) return;
  return invoke("usage_colors_save", { colors });
}

// ---------- Конфиг субагентов ----------

export async function subagentsLoad(): Promise<Record<string, unknown>> {
  if (!inTauri) return {};
  return invoke<Record<string, unknown>>("subagents_load");
}

export async function subagentsSave(config: unknown): Promise<void> {
  if (!inTauri) return;
  return invoke("subagents_save", { config });
}

// ---------- Пользовательские slash-команды ----------

export interface UserCommand {
  name: string;
  description: string;
  /** Шаблон промта; $ARGUMENTS заменяется текстом после команды */
  template: string;
}

export async function commandsLoad(): Promise<UserCommand[]> {
  if (!inTauri) return [];
  const file = await invoke<{ commands?: UserCommand[] }>("commands_load");
  return Array.isArray(file.commands) ? file.commands : [];
}

export async function commandsSave(commands: UserCommand[]): Promise<void> {
  if (!inTauri) return;
  return invoke("commands_save", { file: { commands } });
}

// ---------- Плагины ----------

export interface PluginSkill {
  id: string;
  name: string;
  desc: { ru: string; en: string };
  prompt: string;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  commands: { name: string; description: string; template: string }[];
  skills: PluginSkill[];
  roles: {
    id: string;
    name: string;
    systemPrompt: string;
    tools: string[] | null;
    maxSteps: number;
  }[];
  /** Хуки пака: исполняемые по своей природе — применяются только после
   *  явного подтверждения при установке пака */
  hooks?: Hook[];
  /** MCP-серверы пака: имя совпадает с установленным — пак перезаписывает */
  mcpServers?: McpServerCfg[];
}

/** Экспортируемый набор: все установленные плагины одним файлом */
export interface PluginPackFile {
  kind: "nocturn-plugin-pack";
  version: 1;
  plugins: Plugin[];
}

export async function pluginRead(path: string): Promise<Partial<Plugin>> {
  if (!inTauri) {
    throw new Error("Чтение плагина работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("plugin_read", { path });
}

export async function pluginsLoad(): Promise<Plugin[]> {
  if (!inTauri) return [];
  const file = await invoke<{ installed?: Plugin[] }>("plugins_load");
  return Array.isArray(file.installed) ? file.installed : [];
}

export async function pluginsSave(installed: Plugin[]): Promise<void> {
  if (!inTauri) return;
  return invoke("plugins_save", { file: { installed } });
}

// ---------- Автообновление (tauri-plugin-updater) ----------

/** Проверить обновление; предложить установку. Ошибки молча (нет сети/
    не настроен pubkey/браузерное превью). */
export async function checkForUpdate(opts: {
  available: (version: string) => boolean;
  installed: () => void;
}): Promise<void> {
  if (!inTauri) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    if (!opts.available(update.version ?? "")) return;
    await update.downloadAndInstall();
    opts.installed();
  } catch {
    // тихо: обновление не критично
  }
}

// ---------- Экспорт/импорт настроек одним файлом ----------

/** Экспортируются ВСЕ haloui-* ключи, кроме перечисленных здесь.
 *  Прежний ручной allow-list вёлся за собой: комментарий обещал «всё, что
 *  не в config-файлах», а фактически 12 ключей из ~50 — половина тумблеров
 *  молча терялась при переносе. Exclude — только машинно-специфичное и
 *  зеркала данных с серверным источником истины */
const LS_EXCLUDE_KEYS: ReadonlySet<string> = new Set([
  // Зеркала браузер-превью: истина в settings.json/profiles.json на бекенде
  // (там работает маскирование) — сырые ключи в «поделенный» файл не должны
  // утекать через localStorage
  "haloui-api",
  "haloui-profiles",
  "haloui-sessions",
  // Машинно-специфичное: абсолютные пути и железо другой машины бессмысленны
  "haloui-project-root",
  "haloui-mic-device",
  "haloui-colibri",
  // Состояние, а не настройка: журнал расхода токенов, кэш аватара,
  // флаг онбординга (свежая машина должна пройти онбординг заново)
  "haloui-usage",
  "haloui-usage-backfill",
  "haloui-user-profile",
  "haloui-onboarded",
]);

export function collectLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === null || !k.startsWith("haloui-") || LS_EXCLUDE_KEYS.has(k)) continue;
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

export function restoreLocal(data: Record<string, string>): void {
  // Только наше пространство имён: чужой/сбитый файл импорта не должен
  // засорять localStorage произвольными ключами
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith("haloui-") || LS_EXCLUDE_KEYS.has(k)) continue;
    localStorage.setItem(k, v);
  }
}

export async function settingsReadAll(includeSecrets = false): Promise<Record<string, unknown>> {
  if (!inTauri) return {};
  // include_secrets: API-ключи маскируются на бэкенде — файлом настроек
  // можно делиться, не отдавая ключи провайдеров
  return invoke<Record<string, unknown>>("settings_read_all", { includeSecrets });
}

export async function settingsWriteAll(
  files: Record<string, unknown>,
  /** hooks.json/mcp.json исполняемы — пишутся только после явного подтверждения */
  allowExecutableConfigs = false,
): Promise<number> {
  if (!inTauri) {
    throw new Error("Импорт настроек работает в нативном приложении (npm run tauri dev)");
  }
  return invoke<number>("settings_write_all", { files, allowExecutableConfigs });
}

export async function settingsExportWrite(path: string, content: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Экспорт настроек работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("settings_export_write", { path, content });
}

/** Сохранить файл экспорта чата (.md/.json) — те же гарды пути, что у настроек */
export async function chatExportWrite(path: string, content: string): Promise<void> {
  if (!inTauri) {
    throw new Error("Экспорт чата работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("chat_export_write", { path, content });
}

export async function settingsImportRead(
  path: string,
): Promise<{ files?: Record<string, unknown>; local?: Record<string, string> }> {
  if (!inTauri) {
    throw new Error("Импорт настроек работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("settings_import_read", { path });
}

/** Диалог «Сохранить как» для экспорта; null — отмена */
export async function pickSaveFile(
  defaultName: string,
  ext: "json" | "md" | "txt" = "json",
): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Экспорт работает в нативном приложении (npm run tauri dev)");
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const filterName = { json: "JSON", md: "Markdown", txt: "Text" }[ext];
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  return typeof path === "string" ? path : null;
}

/** Диалог выбора JSON-файла для импорта; null — отмена */
export async function pickJsonFile(): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Импорт работает в нативном приложении (npm run tauri dev)");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  return typeof picked === "string" ? picked : null;
}

// ---------- Диктовка (Whisper): mic → PCM → whisper-cli ----------

export interface DictationStatus {
  cliFound: boolean;
  cliPath: string | null;
  modelExists: boolean;
  modelBytes: number;
  downloading: boolean;
}

/** Статус диктовки: найден ли CLI и скачана ли модель */
export async function dictationStatus(): Promise<DictationStatus> {
  if (!inTauri) {
    return { cliFound: false, cliPath: null, modelExists: false, modelBytes: 0, downloading: false };
  }
  return invoke<DictationStatus>("dictation_status");
}

/** Скачать модель whisper (~57 МБ, Hugging Face → appdata) */
export async function dictationDownloadModel(): Promise<void> {
  if (!inTauri) return;
  await invoke("dictation_download_model");
}

/** Сохранить путь к whisper-cli (null — искать в PATH) */
export async function dictationSetConfig(cliPath: string | null): Promise<void> {
  if (!inTauri) return;
  await invoke("dictation_set_config", { cliPath });
}

/** Транскрибировать запись: base64(int16 LE PCM, 16 кГц моно) → текст */
export async function dictationTranscribe(audioBase64: string): Promise<string> {
  if (!inTauri) throw new Error("Диктовка работает в нативном приложении (npm run tauri dev)");
  return invoke<string>("dictation_transcribe", { audioBase64 });
}

// ---------- Voice Wake («Jarvis-режим»): openWakeWord, офлайн ----------

export interface VoiceFileStatus {
  name: string;
  exists: boolean;
  bytes: number;
}

export interface VoiceStatus {
  files: VoiceFileStatus[];
  downloading: boolean;
}

/** Статус моделей wake-детектора в appdata/voice */
export async function voiceStatus(wakeModel: string): Promise<VoiceStatus> {
  if (!inTauri) return { files: [], downloading: false };
  return invoke<VoiceStatus>("voice_status", { wakeModel });
}

/** Скачать недостающие модели (~3-5 МБ суммарно, GitHub Releases → appdata) */
export async function voiceDownloadModels(wakeModel: string): Promise<void> {
  if (!inTauri) return;
  await invoke("voice_download_models", { wakeModel });
}

/** Байты модели (base64) для инференса в вебвью: ort-web строит сессию
 *  из ArrayBuffer. Имя — строго из белого списка на бекенде */
export async function voiceReadModel(name: string): Promise<string> {
  if (!inTauri) throw new Error("Voice Wake работает в нативном приложении (npm run tauri dev)");
  return invoke<string>("voice_read_model", { name });
}

/** Озвучить текст: локальный SAPI-синтез (Windows), ноль сети. Промис
 *  разрешается по завершении речи — индикатор карточки гаснет сам.
 *  output — имя устройства вывода (audio_outputs); null — системное */
export async function ttsSpeak(text: string, output?: string | null): Promise<void> {
  if (!inTauri) throw new Error("Озвучка работает в нативном приложении (npm run tauri dev)");
  await invoke("tts_speak", { text, output: output || null });
}

/** Устройства вывода звука (для селектора речи); не Windows — пусто */
export async function audioOutputs(): Promise<string[]> {
  if (!inTauri) return [];
  return invoke<string[]>("audio_outputs");
}

/** Остановить текущую озвучку (idempotent) */
export async function ttsStop(): Promise<void> {
  if (!inTauri) return;
  await invoke("tts_stop");
}

// ---------- Базы знаний (RAG): локальный SQLite FTS5, см. kb.rs ----------

export interface KbMeta {
  id: string;
  name: string;
  created: number;
  docs: number;
  chunks: number;
}

export interface KbDoc {
  id: number;
  title: string;
  path: string;
  chunks: number;
}

export interface KbHit {
  docTitle: string;
  text: string;
  score: number;
}

/** Создать базу (каталог + meta + пустой FTS-индекс в appdata) */
export async function kbCreate(name: string): Promise<string> {
  if (!inTauri) throw new Error("Базы знаний работают в нативном приложении (npm run tauri dev)");
  return invoke<string>("kb_create", { name });
}

/** Список баз со статистикой */
export async function kbList(): Promise<KbMeta[]> {
  if (!inTauri) return [];
  return invoke<KbMeta[]>("kb_list");
}

/** Удалить базу целиком */
export async function kbDelete(id: string): Promise<void> {
  if (!inTauri) return;
  await invoke("kb_delete", { id });
}

/** Проиндексировать документ (текстовые форматы; путь из диалога) */
export async function kbAddDocument(id: string, path: string): Promise<number> {
  if (!inTauri) throw new Error("Базы знаний работают в нативном приложении (npm run tauri dev)");
  return invoke<number>("kb_add_document", { id, path });
}

/** Убрать документ из базы */
export async function kbRemoveDocument(id: string, docId: number): Promise<void> {
  if (!inTauri) return;
  await invoke("kb_remove_document", { id, docId });
}

/** Документы базы */
export async function kbDocuments(id: string): Promise<KbDoc[]> {
  if (!inTauri) return [];
  return invoke<KbDoc[]>("kb_documents", { id });
}

/** Поиск по базе: топ-k фрагментов (локальный bm25 + префиксная морфология) */
export async function kbQuery(id: string, query: string, topK = 6): Promise<KbHit[]> {
  if (!inTauri) return [];
  return invoke<KbHit[]>("kb_query", { id, query, topK });
}

/** Диалог выбора документов для индексации (мультивыбор, текстовые форматы) */
export async function pickDocFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    filters: [
      {
        name: "Documents",
        extensions: [
          "md", "markdown", "txt", "csv", "json", "log", "xml", "yaml", "yml",
          "ini", "toml", "html", "ts", "tsx", "js", "jsx", "py", "rs", "go",
          "java", "sql", "sh",
        ],
      },
    ],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

/** Выбрать бинарник whisper-cli вручную (когда его нет в PATH) */
export async function pickCliFile(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    filters: [
      { name: "Executable", extensions: ["exe"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** Git-автокоммит перед правками прогона (Aider-паттерн); false — не репо/нечего коммитить */
export async function gitAutocommit(root: string, message: string): Promise<boolean> {
  if (!inTauri) return false;
  return invoke<boolean>("git_autocommit", { root, message });
}

/** Разворот/восстановление окна: кастомная анимация в Rust — нативный
 *  maximize для безрамочного окна ломает циклы maximize↔restore (tao#471) */
export async function windowToggleMaximize(): Promise<void> {
  if (!inTauri) return;
  await invoke("window_toggle_maximize");
}

/** Полный экран (назначаемое действие в «Горячих клавишах») */
export async function windowToggleFullscreen(): Promise<void> {
  if (!inTauri) return;
  await invoke("window_toggle_fullscreen");
}

/** Скрыть окно в трей (крестик при «сворачивать в трей») */
export async function hideToTray(): Promise<void> {
  if (!inTauri) return;
  await invoke("hide_to_tray");
}
