import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Сохранённый профиль ключа: связка «ключ + провайдер + модель» для быстрого
    переключения. Живёт внутри ApiSettings (settings.json). */
export interface ApiProfile {
  id: string;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  provider: string;
}

export interface ApiSettings {
  api_key: string;
  base_url: string;
  model: string;
  /** Метка пресета провайдера ("deepseek", "anthropic", …; "custom" — свой URL) */
  provider: string;
  /** Шифрование ключей (AES-256-GCM + Credential Manager) */
  encrypt_keys?: boolean;
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
    return raw
      ? (JSON.parse(raw) as ProfilesStore)
      : { profiles: [], active: "" };
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
  return invoke("crypto_setup", { password });
}

/** Разблокировка существующим паролем */
export async function cryptoUnlock(password: string): Promise<void> {
  return invoke("crypto_unlock", { password });
}

/** Полный сброс: зашифрованные ключи будут утеряны (confirm="RESET") */
export async function cryptoReset(confirm = "RESET"): Promise<void> {
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
}

let cachedSchemas: unknown = null;

/** M3: OpenAI-схемы инструментов агента (+ инструменты MCP-серверов).
    Кэш сбрасывается при изменении набора соединений — вызов дешёвый. */
export async function getToolSchemas(): Promise<unknown> {
  if (!inTauri) {
    throw new Error("Agent mode works in the native app (npm run tauri dev)");
  }
  cachedSchemas = await invoke<unknown>("get_tool_schemas");
  return cachedSchemas;
}

export function invalidateToolSchemas(): void {
  cachedSchemas = null;
}

/** M3: исполнение инструмента агента в Rust */
export async function runTool(name: string, args: string): Promise<string> {
  if (!inTauri) {
    throw new Error("Agent mode works in the native app (npm run tauri dev)");
  }
  return invoke<string>("run_tool", { name, arguments: args });
}

/** Синхронизация серверного слоя прав (PermMode + project roots) */
export async function permSet(mode: string, roots: string[]): Promise<void> {
  if (!inTauri) return;
  return invoke("perm_set", { mode, roots });
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

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
    return raw ? (JSON.parse(raw) as ApiSettings) : { ...DEFAULT_SETTINGS };
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
  onDelta: (delta: string) => void;
  onThought: (thought: string) => void;
  onUsage: (usage: ChatUsage) => void;
  onToolCalls?: (calls: ToolCallInfo[]) => void;
}): Promise<void> {
  if (!inTauri) {
    throw new Error("Чат работает в нативном приложении (npm run tauri dev)");
  }

  const offChunk = await listen<{ requestId: string; delta: string }>(
    "chat-chunk",
    (e) => {
      if (e.payload.requestId === opts.requestId) opts.onDelta(e.payload.delta);
    },
  );
  const offThought = await listen<{ requestId: string; thought: string }>(
    "chat-thought",
    (e) => {
      if (e.payload.requestId === opts.requestId) {
        opts.onThought(e.payload.thought);
      }
    },
  );
  const offUsage = await listen<{
    requestId: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>("chat-usage", (e) => {
    if (e.payload.requestId === opts.requestId) {
      opts.onUsage({
        prompt: e.payload.promptTokens,
        completion: e.payload.completionTokens,
        total: e.payload.totalTokens,
      });
    }
  });
  const offToolCalls = await listen<{
    requestId: string;
    calls: ToolCallInfo[];
  }>("chat-tool-calls", (e) => {
    if (e.payload.requestId === opts.requestId) {
      opts.onToolCalls?.(e.payload.calls);
    }
  });

  try {
    await invoke("chat_stream", {
      requestId: opts.requestId,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools ?? null,
      reasoning_effort:
        opts.reasoningEffort && opts.reasoningEffort !== "off"
          ? opts.reasoningEffort
          : null,
    });
  } finally {
    offChunk();
    offThought();
    offUsage();
    offToolCalls();
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

// ---------- M4.2: файловый менеджер ----------

export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

/** Системный диалог выбора папки проекта. null — пользователь отменил */
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
}

/** Снимок файлов проекта; возвращает метаданные созданного чекпоинта */
export async function checkpointSave(path: string, label: string): Promise<CheckpointMeta | null> {
  if (!inTauri) return null;
  try {
    return await invoke<CheckpointMeta>("checkpoint_save", { path, label });
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
  return invoke<number>("checkpoint_restore", { path, id });
}

export async function checkpointDelete(path: string, id: string): Promise<void> {
  await invoke("checkpoint_delete", { path, id });
}

// ---------- M6: интерактивный PTY-терминал ----------

export async function ptyCreate(
  id: string,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<void> {
  if (!inTauri) {
    throw new Error("Консоль работает в нативном приложении (npm run tauri dev)");
  }
  return invoke("pty_create", { id, cwd, cols, rows });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  if (!inTauri) return;
  return invoke("pty_write", { id, data });
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
    const n = parseInt(km[1], 10);
    if (n >= 16 && n <= 2048) return n * 1000;
  }
  return heuristicContextLimit(model);
}

/** Совместимый вызов: оценка только по имени модели */
export function guessContextLimit(model: string): number {
  return heuristicContextLimit(model);
}

// ---------- MCP: внешние инструменты-серверы ----------

export interface McpServerCfg {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
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
}

export interface ComputerConfig {
  enabled: boolean;
}

export async function browserGetConfig(): Promise<BrowserConfig> {
  if (!inTauri) return { enabled: true, headless: true, executable: "" };
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
  return invoke<ImageGenConfig>("imagegen_get_config");
}

export async function imageGenSetConfig(config: ImageGenConfig): Promise<void> {
  return invoke("imagegen_set_config", { config });
}

// ---------- Свои звуки уведомлений ----------

/** Диалог выбора аудиофайла; null — отмена */
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
}

export async function pluginRead(path: string): Promise<Partial<Plugin>> {
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

/** localStorage-ключи, входящие в экспорт (всё, что не в config-файлах) */
export const LS_EXPORT_KEYS: string[] = [
  "haloui-automations",
  "haloui-theme-profiles",
  "haloui-appearance",
  "haloui-header-color",
  "haloui-theme",
  "haloui-lang",
  "haloui-sidebar-width",
  "haloui-sidebar-group",
  "haloui-sidebar-projects",
  "haloui-notify",
  "haloui-keep-awake",
  "haloui-browser-panel",
];

export function collectLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LS_EXPORT_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

export function restoreLocal(data: Record<string, string>): void {
  for (const [k, v] of Object.entries(data)) {
    localStorage.setItem(k, v);
  }
}

export async function settingsReadAll(): Promise<Record<string, unknown>> {
  if (!inTauri) return {};
  return invoke<Record<string, unknown>>("settings_read_all");
}

export async function settingsWriteAll(
  files: Record<string, unknown>,
): Promise<number> {
  return invoke<number>("settings_write_all", { files });
}

export async function settingsExportWrite(path: string, content: string): Promise<void> {
  return invoke("settings_export_write", { path, content });
}

export async function settingsImportRead(
  path: string,
): Promise<{ files?: Record<string, unknown>; local?: Record<string, string> }> {
  return invoke("settings_import_read", { path });
}

/** Диалог «Сохранить как» для экспорта; null — отмена */
export async function pickSaveFile(defaultName: string): Promise<string | null> {
  if (!inTauri) {
    throw new Error("Экспорт работает в нативном приложении (npm run tauri dev)");
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "JSON", extensions: ["json"] }],
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
