import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AskQuestion, Attachment, ChangedFile, Message, PermissionMode, PlanTask, Session, ToolCallInfo } from "../types";
import type { PromptPreset } from "../presets";
import { normalizePath, parseWriteResult } from "../diff";
import type { SlashCommand } from "../commands";
import QuickSettings from "./QuickSettings";
import NocturnMark from "./NocturnMark";
import GreetingDashboard from "./GreetingDashboard";
import { ArtifactsPanel, type ArtifactView } from "./ArtifactsPanel";
import type { Appearance } from "../appearance";
import { getToolSchemas, contextLimitFor, dictationTranscribe, type ModelInfo } from "../api";
import type { Theme } from "../types";
import SystemPromptModal from "./SystemPromptModal";
import TerminalPanel from "./TerminalPanel";
import { uid } from "../hooks/useAgentRun";
import WindowControls from "./WindowControls";
import ProviderIcon, { brandName } from "./ProviderIcon";
import { useLang, type MsgKey } from "../locales";
import { dayPeriod } from "../time";
import { getUserDisplayName } from "../userProfile";
import { BUILTIN_SKILLS, type Skill } from "../skills";
import type { SubRunState } from "../subagents";
import type { UserCommand } from "../api";
import { BUILTIN_COMMANDS } from "../commands";
import { AskClosedCard, AskPanel } from "./cards/AskUserCard";
import { AssistantCard } from "./cards/AssistantCard";
import { RunCard } from "./cards/RunCard";
import { ChangedFilesCard } from "./cards/ChangedFilesCard";
import { ConfirmCard } from "./cards/ConfirmCard";
import { ContextRing } from "./cards/ContextRing";
import { MessageNav } from "./cards/MessageNav";
import { PlanPanel } from "./cards/PlanPanel";
import { SubagentCard } from "./cards/SubagentCard";
import { buildStepRows, type StepRow } from "../agent/steps";
import { ToolStepCard } from "./cards/ToolStepCard";
import { TypingBubble } from "./cards/TypingBubble";
import { ErrorBoundary } from "./ErrorBoundary";
import { UserCard } from "./cards/UserCard";
import { ArrowUpIcon, BookIcon, ChevronDownIcon, CorrectIcon, MicIcon, PaperclipIcon, PermModeIcon, QueueIcon, QuoteIcon, RobotIcon, ScalesIcon, ShieldIcon, SlidersIcon, SparkIcon, StopIcon, SystemPromptIcon, TerminalIcon, TrashIcon, WrenchIcon, XSmallIcon } from "./cards/icons";
import { fmtInt, fmtK } from "./cards/util";
import { CHART_COLORS } from "../chartColors";

/** Заголовок артефакта из <title>/<h1> частичного HTML; null — заголовка
 *  ещё нет (стрим в начале). Единая эвристика для openArtifact и
 *  живого артефакта — раньше она жила только в openArtifact */
function artifactTitleFromHtml(html: string): string | null {
  const m =
    /<title[^>]*>([\s\S]{1,120}?)<\/title>/i.exec(html) ??
    /<h1[^>]*>([\s\S]{1,120}?)<\/h1>/i.exec(html);
  const captured = m?.[1];
  return captured ? captured.replace(/<[^>]*>/g, "").trim() || null : null;
}

/** Единая анатомия чипов нижней панели композера: одна высота, паддинги
 *  и кегль у всех контролов — раньше каждый чип жил со своими px/py/кеглем,
 *  и ряд «плясал» по вертикали (фидбек владельца про непропорциональные
 *  иконки; референсы — Claude Desktop и ZCode) */
const COMPOSER_CHIP =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[0.6875rem] font-medium transition duration-150 disabled:cursor-not-allowed disabled:opacity-40";
const COMPOSER_CHIP_ON = "bg-halo-accent/15 text-halo-accent";
const COMPOSER_CHIP_OFF = "text-halo-muted hover:bg-halo-hover hover:text-halo-text";

/** Стабильная пустая лента результатов tool-вызовов: `?? []` в рендере
 *  создавал новый массив на каждую пересборку ленты и пробивал поверхностное
 *  сравнение memo AssistantCard — исторические карточки без инструментов
 *  ре-рендерились (с ре-парсом markdown) на каждый флеш стрима.
 *  Убрано вместе с per-round рендером: результаты теперь всегда есть
 *  у владельца (resultsOf), пустой фолбэк больше не нужен */

interface ChatAreaProps {
  session: Session | null;
  typing: boolean;
  /** Живой статус модели (размышляет / вызывает инструмент) — null скрыт */
  activity: string | null;
  model: string;
  /** id сообщения, которое сейчас стримится (null — ничего не генерится) */
  streamingMsgId: string | null;
  /** Принимает ли выбранная модель изображения (undefined — неизвестно) */
  visionCapable?: boolean;
  /** Модель запущена локально (Ollama) */
  isLocal?: boolean;
  /** Агентный режим задачи */
  agentMode: boolean;
  /** Режим разрешений агента (plan / ask / edit / full) */
  permissionMode: PermissionMode;
  onPermissionModeChange: (m: PermissionMode) => void;
  /** Инструменты, скрытые пользователем из этой задачи (Session.disabledTools) */
  disabledTools: string[];
  onToggleDisabledTool: (name: string) => void;
  /** Ожидающее подтверждение агента */
  pendingConfirm: { requestId: string; call: ToolCallInfo } | null;
  /** Все сессии: дашборд приветствия показывает незавершённые задачи */
  sessions: Session[];
  /** Открыть сессию из дашборда приветствия */
  onOpenSession: (id: string) => void;
  /** Открыть настройки на конкретной секции (карточки статусов дашборда) */
  onOpenSettingsSection?: (section: "mcp" | "main") => void;
  /** Встроенные роли (Код / Инженер / …) — QuickSettings-поповер композера */
  promptPresets: PromptPreset[];
  /** Пользовательские роли из библиотеки */
  customPresets: PromptPreset[];
  onSend: (
    text: string,
    attachments?: Attachment[],
    overrideTargetId?: string,
    quote?: string,
  ) => void;
  /** Цитата из Review-панели (клик по строке диффа): nonce растёт с каждым кликом */
  pendingQuote?: { text: string; nonce: number } | null;
  onClearChat: () => void;
  /** Очередь корректирующих сообщений: отправятся после ответа агента */
  queued: { id: string; text: string }[];
  onQueue: (text: string, attachments?: Attachment[], quote?: string) => void;
  onQueuedRemove: (id: string) => void;
  /** Поправка агенту на ходу: уходит модели в следующем раунде, не прерывая работу */
  onCorrect?: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
  /** Открыть «Сравнение моделей» / «Базы знаний» (иконки в шапке чата) */
  onOpenCompare?: () => void;
  onOpenKnowledge?: () => void;
  onSetSystemPrompt: (prompt: string | null) => void;
  onApplyPreset: (prompt: string) => void;
  onToggleAgent: () => void;
  onConfirmDecision: (d: "once" | "always" | "deny") => void;
  /** Живой вопрос ask_user (панель над композером); null — вопросa нет */
  pendingAsk: { msgId: string; ask: AskQuestion } | null;
  /** Ответ пользователя на вопрос агента (ask_user) */
  onAskAnswer: (mid: string, answer: { answers: string[]; custom?: string }) => void;
  /** Откат записи агента: восстановить before или удалить созданный файл */
  onUndoWrite: (f: ChangedFile) => void;
  /** Review: открыть правую панель с живым диффом прогона (App собирает
   *  fs_write + чекпоинт). Не передан — кнопка Review не рендерится */
  onReviewChanges?: (files: ChangedFile[], focusPath?: string) => void;
  /** Open на строке карточки изменений: системное открытие файла (App
   *  резолвит корень проекта и показывает ошибку тостом) */
  onOpenFileExternal?: (path: string) => void;
  /** Редактирование отправленного сообщения (карандаш): правка + перезапрос */
  onEditMessage?: (msgId: string, newText: string) => void;
  /** Живые прогоны субагентов (ключ — tool call id) */
  subRuns?: Record<string, SubRunState>;
  /** План задач агента: виджет Progress в левом верхнем углу чата */
  plan?: PlanTask[];
  /** Пользовательские slash-команды (commands.json) */
  userCommands?: UserCommand[];
  /** Скилы из плагинов — в палитре «&» после встроенных */
  extraSkills?: Skill[];
  /** Терминальный режим (M4.5): панель снизу */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** Корень проекта — рабочая папка консоли терминала (M6) */
  projectRoot: string | null;
  /** Оболочка консоли: auto | powershell | cmd | gitbash */
  termShell: string;
  /** 16 ANSI-цветов выбранной палитры (проброс в терминал) */
  termPalette?: string[];
  /** Размытие фона терминала, px (0 — выключено; S3: blur(0px) всё равно
   *  заставляет движок снапшотить фон каждый кадр) */
  termBlur?: number;
  /** Стартовые подсказки скрыты (эргономика) */
  hideStarter: boolean;
  onToggleStarter: () => void;
  /** Высота терминальной панели, % и drag-хендл */
  terminalHeightPct: number;
  onTerminalResizeStart: () => void;
  /** Поведение генерации: принудительный автоскролл, плавная печать, каретка */
  scrollFollow: boolean;
  streamSmooth: boolean;
  /** Подсветка кода во время стрима (тумблер в «Основном»); выкл — hljs
   *  только после завершения сообщения */
  highlightLive: boolean;
  /** Множитель скорости плавной печати (0.5 / 1 / 2) */
  printSpeed: number;
  /** Раскрывать блок рассуждений автоматически */
  showReasoning: boolean;
  streamCaret: boolean;
  /** Показывать сообщения пользователя (иначе — только ответы модели) */
  showUserMsgs: boolean;
  /** Весь ход агента — одной карточкой (мысли + команды + результаты + текст) */
  groupTurns: boolean;
  /** Призрачный логотип на фоне ленты чата */
  chatMark: boolean;
  /** Обои чата: путь к картинке за лентой ("" — выключено) */
  /** Эффект стекла на карточках ответов ИИ */
  msgGlass: boolean;
  /** Время в шапке ответов модели (кастомизация) */
  showMsgTime: boolean;
  /** Кнопки окна в этой шапке (когда сайдбар не справа) */
  showWindowControls: boolean;
  /** Свёрнутый сайдбар: с какой стороны отступ под плавающую кнопку */
  headerInset: "left" | "right" | null;
  slashCommands: SlashCommand[];
  /** Быстрые настройки (поповер) */
  models: ModelInfo[];
  onModelChange: (id: string) => void;
  /** Усилие размышлений (QuickSettings → вкладка «Модель») */
  effort: "off" | "low" | "high" | "max";
  onEffortChange: (e: "off" | "low" | "high" | "max") => void;
  theme: Theme;
  appearance: Appearance;
  onThemeChange: (t: Theme) => void;
  onAppearanceChange: (a: Appearance) => void;
  glass: boolean;
  onGlassChange: (v: boolean) => void;
}

/** Компактный формат счётчика: 1234 → 1,2k */
// D16: стартовые подсказки на всех четырёх языках — раньше zh/ja
// получали английские чипы (строки не в словарях)

/** A15: пережимает вложение-картинку, чтобы data-URL уложился в лимит
 *  (~1.2 МБ). Пропорции сохраняются: длинная сторона ужимается шагами *0.75,
 *  формат JPEG q=0.85. Ошибка декодирования → вызывающий код кладёт оригинал. */
const ATTACH_DATAURL_LIMIT = 1_200_000;
async function downscaleAttachment(dataUrl: string): Promise<string> {
  if (dataUrl.length <= ATTACH_DATAURL_LIMIT) return dataUrl;
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("image decode failed"));
    img.src = dataUrl;
  });
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  let out = dataUrl;
  const canvas = document.createElement("canvas");
  for (let i = 0; i < 6 && out.length > ATTACH_DATAURL_LIMIT; i++) {
    w = Math.max(1, Math.round(w * 0.75));
    h = Math.max(1, Math.round(h * 0.75));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, w, h);
    out = canvas.toDataURL("image/jpeg", 0.85);
  }
  return out.length < dataUrl.length ? out : dataUrl;
}

export default function ChatArea({
  session,
  typing,
  activity,
  model,
  streamingMsgId,
  visionCapable,
  isLocal,
  agentMode,
  permissionMode,
  onPermissionModeChange,
  disabledTools,
  onToggleDisabledTool,
  pendingConfirm,
  onSend,
  pendingQuote,
  onClearChat,
  queued,
  onQueue,
  onQueuedRemove,
  onCorrect,
  onStop,
  onOpenSettings,
  onOpenCompare,
  onOpenKnowledge,
  sessions,
  onOpenSession,
  onOpenSettingsSection,
  promptPresets,
  customPresets,
  onSetSystemPrompt,
  onApplyPreset,
  onToggleAgent,
  onConfirmDecision,
  pendingAsk,
  onAskAnswer,
  onUndoWrite,
  onReviewChanges,
  onOpenFileExternal,
  onEditMessage,
  subRuns,
  plan,
  userCommands,
  extraSkills,
  terminalOpen,
  onToggleTerminal,
  projectRoot,
  termPalette,
  termBlur = 0,
  termShell,
  hideStarter,
  onToggleStarter,
  terminalHeightPct,
  onTerminalResizeStart,
  scrollFollow,
  streamSmooth,
  highlightLive,
  printSpeed,
  showReasoning,
  streamCaret,
  showUserMsgs,
  groupTurns,
  chatMark,
  msgGlass,
  showMsgTime,
  showWindowControls,
  headerInset,
  slashCommands,
  models,
  onModelChange,
  effort,
  onEffortChange,
  theme,
  appearance,
  onThemeChange,
  onAppearanceChange,
  glass,
  onGlassChange,
}: ChatAreaProps) {
  const { lang, t } = useLang();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  // Стабильные колбэки для memo-карточек: новая стрелка на каждый рендер
  // пробивала мемоизацию
  const reuseAttachment = useCallback(
    (a: Attachment) =>
      setPendingImages((prev) => [...prev, { ...a, id: a.id ?? uid() }]),
    [],
  );
  // onEditMessage из App нестабилен (замыкает handleSend/activeId) —
  // держим в ref, чтобы колбэк для UserCard не менялся никогда.
  // Обновление в эффекте: запись в ref в теле рендера вне модели
  // React Compiler
  const onEditMessageRef = useRef(onEditMessage);
  useEffect(() => {
    onEditMessageRef.current = onEditMessage;
  }, [onEditMessage]);
  const editMessage = useCallback(
    (mid: string, text: string) => void onEditMessageRef.current?.(mid, text),
    [],
  );
  const [sysOpen, setSysOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  // Монитор субагентов: поповер у кнопки-робота в нижней панели
  const [subOpen, setSubOpen] = useState(false);
  // Память: старые ходы рендерим заглушкой, пока не попросили показать всё
  const [showOldTurns, setShowOldTurns] = useState(false);
  const sessionKey = session?.id ?? null;
  useEffect(() => {
    setShowOldTurns(false); // смена задачи — снова сворачиваем историю
    setSessionChangesOpen(false);
  }, [sessionKey]);
  const [sessionChangesOpen, setSessionChangesOpen] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  // Поповер «Инструменты»: список имён из живых схем, тянется один раз при открытии
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolNames, setToolNames] = useState<string[] | null>(null);
  const openTools = () => {
    setToolsOpen((v) => !v);
    if (toolNames === null) {
      void getToolSchemas()
        .then((t) => {
          const arr = t as Array<{ function?: { name?: string } }>;
          setToolNames(
            Array.isArray(arr)
              ? arr
                  .map((x) => x?.function?.name)
                  .filter((n): n is string => n !== undefined)
              : [],
          );
        })
        .catch(() => setToolNames([]));
    }
  };
  const slashActive = draft.startsWith("/");
  /** «&» — палитра скилов (src/skills.ts) */
  const skillActive = draft.startsWith("&");
  // Artifacts: предпросмотр ```html-блоков ответа (панель справа, sandbox-
  // iframe без allow-same-origin — скрипты артефакта изолированы от приложения)
  const [artifactView, setArtifactView] = useState<ArtifactView | null>(null);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const openArtifact = useCallback(
    (html: string) => {
      const title = artifactTitleFromHtml(html) ?? t("artifacts.fallback");
      setArtifactView({ html, title });
      setArtifactOpen(true);
    },
    [t],
  );
  // ---------- Живой артефакт ----------
  // Пока модель стримит ```html-блок, панель Artifacts обновляется живьём:
  // частичный HTML уезжает в тот же sandbox-iframe с дебаунсом 120мс
  // (перелив iframe на каждый чанк давал бы постоянные реflow'ы), поверх —
  // шиммер-вуаль, пока фенс не закрыт. Авто-открытие — один раз на фенс:
  // закрыл руками — не всплывает до следующего блока/прогона
  const [artifactVeil, setArtifactVeil] = useState(false);
  const liveFenceRef = useRef({ start: -1, msgId: "", dismissed: false, timer: 0 });
  const artifactOpenRef = useRef(artifactOpen);
  useEffect(() => {
    artifactOpenRef.current = artifactOpen;
  }, [artifactOpen]);
  // Диктовка: запись микрофона через вебвью (PCM 16 кГц моно) → whisper-cli
  // в отдельном процессе бекенда. Аудио живёт только в буфере записи и во
  // временном wav на время транскрипции — локально by design
  const [recording, setRecording] = useState(false);
  const [dictBusy, setDictBusy] = useState(false);
  const recRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    node: ScriptProcessorNode;
    chunks: Float32Array[];
  } | null>(null);
  /** Идёт инициализация записи (getUserMedia): гасит повторные клики */
  const recStartingRef = useRef(false);

  const startRecording = async () => {
    if (recStartingRef.current || recRef.current) return;
    recStartingRef.current = true;
    // Оптимистичный индикатор: прогрев/инициализация устройства могут
    // занимать секунды — кнопка не должна выглядеть мёртвой
    setRecording(true);
    try {
      // Микрофон, выбранный в «Основном» (ключ дублирует MainSection);
      // пусто — системный по умолчанию. Фолбэк: выбранное устройство могло
      // отключиться — OverconstrainedError не должен ломать запись совсем
      const micId = localStorage.getItem("haloui-mic-device") ?? "";
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(micId ? { deviceId: { exact: micId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      }
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(node);
      // ScriptProcessor требует выхода в граф: через нулевой gain — без эха
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      recRef.current = { ctx, stream, node, chunks };
      // Voice Wake уступает устройство: слушатель suspend'ится по событию
      window.__nocturnMicBusy = true;
      document.dispatchEvent(new CustomEvent("nocturn-voice-busy"));
    } catch {
      setRecording(false);
      window.alert(t("dictation.micDenied"));
    } finally {
      recStartingRef.current = false;
    }
  };

  const stopRecording = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    window.__nocturnMicBusy = false;
    document.dispatchEvent(new CustomEvent("nocturn-voice-busy"));
    setRecording(false);
    rec.node.disconnect();
    rec.stream.getTracks().forEach((tr) => tr.stop());
    void rec.ctx.close();
    const total = rec.chunks.reduce((a, c) => a + c.length, 0);
    if (total === 0) return;
    // Float32 [-1..1] → Int16 LE → base64 (2 байта на сэмпл: 30 с ≈ 1 МБ)
    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of rec.chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i] ?? 0));
        pcm[off++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    }
    setDictBusy(true);
    try {
      const text = (await dictationTranscribe(btoa(bin))).trim();
      if (text) {
        setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
        const ta = textareaRef.current;
        if (ta) {
          autoGrow(ta);
          ta.focus();
        }
      } else {
        window.alert(t("dictation.empty"));
      }
    } catch (e) {
      window.alert(String(e));
    } finally {
      setDictBusy(false);
    }
  };

  // Ресурсы записи — незамкнутые при unmount: HMR/StrictMode-ремаунт или
  // краш ErrorBoundary-поддерева оставляли бы вебвью с живым микрофоном
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (!rec) return;
      recRef.current = null;
      window.__nocturnMicBusy = false;
      document.dispatchEvent(new CustomEvent("nocturn-voice-busy"));
      rec.node.disconnect();
      rec.stream.getTracks().forEach((tr) => tr.stop());
      void rec.ctx.close();
    };
  }, []);
  const [skillIndex, setSkillIndex] = useState(0);
  const allSkills = useMemo<Skill[]>(
    () => [...BUILTIN_SKILLS, ...(extraSkills ?? [])],
    [extraSkills],
  );
  const skillMatches = useMemo(() => {
    if (!skillActive) return [];
    const q = draft.slice(1).trim().toLowerCase();
    const pool = !q
      ? allSkills
      : allSkills.filter(
          (s) =>
            s.id.includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.desc?.ru?.toLowerCase().includes(q),
        );
    return pool.slice(0, 8);
  }, [draft, skillActive, allSkills]);
  const hasSystemPrompt = !!session?.systemPrompt;

  const readFile = (f: File) => {
    // Текстовые документы (RAG-lite): содержимое уходит в контекст модели;
    // потолок — вложения живут в sessions.json, мегабайтные файлы раздували стор
    const isImage = f.type.startsWith("image/");
    const name = f.name || (isImage ? "image.png" : "file.txt");
    if (!isImage) {
      if (f.size > 5 * 1024 * 1024) return; // слишком большой — молча игнорируем
      const reader = new FileReader();
      reader.onload = () => {
        let text = String(reader.result);
        if (text.length > 512 * 1024) {
          text = text.slice(0, 512 * 1024) + "\n...[file truncated]";
        }
        setPendingImages((prev) => [...prev, { id: uid(), name, text }]);
      };
      reader.readAsText(f);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      // A15: большие изображения пережимаются до ~1 МБ data-URL — вложения
      // живут в sessions.json base64'ом, многометровые скриншоты раздували
      // файл до десятков-сотен МБ, и строкификация всего стора на сейве
      // регулярно фризила UI
      downscaleAttachment(dataUrl)
        .then((small) =>
          setPendingImages((prev) => [...prev, { id: uid(), name, dataUrl: small }]),
        )
        .catch(() =>
          setPendingImages((prev) => [...prev, { id: uid(), name, dataUrl }]),
        );
    };
    reader.readAsDataURL(f);
  };

  // Ctrl+V из любого места чата: ловим изображения из буфера (Win+Shift+S)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const images = items.filter((i) => i.type.startsWith("image/"));
      if (images.length === 0) return;
      e.preventDefault();
      images.forEach((i) => {
        const f = i.getAsFile();
        if (f) readFile(f);
      });
      textareaRef.current?.focus();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag&drop файлов в чат: ЛЮБОЙ файл → вложение (картинка — превью,
  // текст/код — RAG-lite). Без preventDefault WebView переходит на файл
  // по умолчанию — перетаскивание .ts/.rs выглядело как «нельзя».
  // dragenter/dragleave считаем по глубине: они срабатывают на каждом
  // потомке, и без счётчика оверлей мигал бы на границах элементов
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      // preventDefault на dragover обязателен: без него drop не придёт
      if (hasFiles(e)) e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      for (const f of Array.from(e.dataTransfer?.files ?? [])) readFile(f);
      textareaRef.current?.focus();
    };
    // Alt+Tab/потеря фокуса посреди перетаскивания: dragleave может не
    // прийти — оверлей зависал тёмной вуалью над рабочим окном
    const resetDrag = () => {
      dragDepthRef.current = 0;
      setDragActive(false);
    };
    const onVis = () => {
      if (document.hidden) resetDrag();
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("blur", resetDrag);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", resetDrag);
      document.removeEventListener("visibilitychange", onVis);
    };
    // readFile замыкает только стабильные сеттеры — как в paste-эффекте выше
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `session?.messages ?? []` — новый массив на каждый рендер: он тянул за
  // собой пересчёт ВСЕХ useMemo/useEffect, зависящих от messages (deps
  // меняли идентичность каждый кадр). Мемоизируем саму нормализацию
  const messages = useMemo(() => session?.messages ?? [], [session]);
  // Пустые ассистентские карточки — placeholders активного стрима;
  // сообщения пользователя можно скрыть тумблером в «Основном».
  // Карточка с ошибкой видима всегда — иначе ответ «исчезает» молча
  const visible = useMemo(
    () =>
      messages.filter(
        (m) =>
          !(m.role === "user" && !showUserMsgs) &&
          !(
            m.role === "assistant" &&
            m.content === "" &&
            !m.thought &&
            !m.toolCalls &&
            !m.error
          ),
      ),
    [messages, showUserMsgs],
  );

  // Изменения файлов за ВСЮ задачу: агрегат по всем fs_write-сообщениям.
  // C7: дорогой пересчёт (JSON.parse содержимого before/after) отсечён от
  // ежекадровых флешей стрима — дешёвый ключ (id fs_write-результатов)
  // меняется только когда реально появился новый результат записи
  // (тот же паттерн, что у modifiedFiles в App.tsx)
  const writeKey = useMemo(() => {
    let key = "";
    for (const m of messages) {
      if (m.role === "tool" && m.toolName === "fs_write") key += `${m.id}|`;
    }
    return key;
  }, [messages]);
  const sessionWrites = useMemo(() => {
    const map = new Map<string, ChangedFile>();
    for (const m of messages) {
      if (m.role !== "tool" || m.toolName !== "fs_write") continue;
      const w = parseWriteResult(m.content);
      if (!w?.path) continue;
      const k = normalizePath(w.path);
      const prev = map.get(k);
      map.set(k, {
        path: w.path,
        created: prev?.created ?? w.created,
        before: prev?.before ?? w.before,
        after: w.after,
      });
    }
    return [...map.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ключ отсекает ежекадровый пересчёт
  }, [writeKey]);

  // ── Производные данные ленты ──
  // IIFE рендера исполняется на каждый рендер; без кэша он пересоздавал
  // merged/results/writes (JSON.parse больших before/after) и ломал memo
  // карточек новыми ссылками. Сообщения иммутабельны — производные хода
  // валидны, пока ссылки его сообщений не изменились.
  interface TurnDerived {
    assistants: Message[];
    toolMsgs: Message[];
    /** Раскладка tool-сообщений по раундам (владелец по toolCallId);
     *  сироты без владельца — к последнему раунду, чтобы не терялись */
    toolMsgsOf: Map<string, Message[]>;
    /** Шаги каждого раунда для аккордеона (Edit/Terminal/Explore/Asked) */
    roundSteps: Map<string, StepRow[]>;
    /** Вызовы по id tool-сообщения (для SubagentCard в RunCard);
     *  в кэше derived — стабильные ссылки для memo */
    callOf: Map<string, ToolCallInfo | undefined>;
    /** Раунды хода для RunCard: фильтр assistants в кэше derived — новый
     *  массив на каждую пересборку feedNodes пробивал memo(RunCard) на
     *  каждый тик стрима (ре-парс markdown всей истории) */
    rounds: Message[];
    results: { id: string; content: string }[];
    resultsOf: Map<string, { id: string; content: string }[]>;
    writesFiles: ChangedFile[];
  }
  const turnCacheRef = useRef(new Map<string, TurnDerived>());
  const ribbon = useMemo(() => {
    const cache = turnCacheRef.current;
    const nextCache = new Map<string, TurnDerived>();
    const turns: { user: Message | null; items: Message[] }[] = [];
    for (const m of messages) {
      if (m.role === "user") turns.push({ user: m, items: [] });
      else if (turns.length === 0) turns.push({ user: null, items: [m] });
      else turns[turns.length - 1]?.items.push(m);
    }
    const callById = new Map<string, ToolCallInfo>();
    for (const m of messages) {
      for (const tc of m.toolCalls ?? []) callById.set(tc.id, tc);
    }
    const sameRefs = (a: Message[], b: Message[]) =>
      a.length === b.length && a.every((m, i) => m === b[i]);
    const out = turns.map((turn, ti) => {
      const key = turn.items[0]?.id ?? `head-${ti}`;
      const assistants = turn.items.filter((m) => m.role === "assistant");
      const toolMsgs = turn.items.filter((m) => m.role === "tool");
      const prev = cache.get(key);
      if (
        prev &&
        sameRefs(prev.assistants, assistants) &&
        sameRefs(prev.toolMsgs, toolMsgs)
      ) {
        nextCache.set(key, prev);
        return { ...turn, derived: prev };
      }
      // Файлы, записанные агентом в этом ходе
      const writes = new Map<string, ChangedFile>();
      for (const m of toolMsgs) {
        const w = parseWriteResult(m.content);
        if (!w?.path) continue;
        const p = writes.get(normalizePath(w.path));
        writes.set(normalizePath(w.path), {
          path: w.path,
          created: p?.created ?? w.created,
          before: p?.before ?? w.before,
          after: w.after,
        });
      }
      // Результаты вызовов: общая лента + раскладка по владельцам
      const results = toolMsgs.map((m) => ({ id: m.id, content: m.content }));
      const resultsOf = new Map<string, { id: string; content: string }[]>();
      const ownerOf = new Map<string, string>();
      for (const a of assistants) {
        for (const tc of a.toolCalls ?? []) ownerOf.set(tc.id, a.id);
      }
      for (const m of toolMsgs) {
        if (!m.toolCallId) continue;
        const owner = ownerOf.get(m.toolCallId);
        if (!owner) continue;
        const arr = resultsOf.get(owner) ?? [];
        arr.push({ id: m.id, content: m.content });
        resultsOf.set(owner, arr);
      }
      // Раскладка tool-сообщений по раундам: каждый раунд (assistant-сообщение)
      // получает СВОИ вызовы и результаты — лента «мысль → вызовы → мысль…»
      const toolMsgsOf = new Map<string, Message[]>();
      const lastAssistantId = assistants[assistants.length - 1]?.id ?? "";
      for (const m of toolMsgs) {
        const owner =
          (m.toolCallId ? ownerOf.get(m.toolCallId) : undefined) ?? lastAssistantId;
        if (!owner) continue;
        const arr = toolMsgsOf.get(owner) ?? [];
        arr.push(m);
        toolMsgsOf.set(owner, arr);
      }
      const roundSteps = new Map<string, StepRow[]>();
      for (const a of assistants) {
        roundSteps.set(a.id, buildStepRows([a], toolMsgsOf.get(a.id) ?? []));
      }
      // Вызовы по id tool-сообщения — для шапок субагентных карточек
      const callOf = new Map<string, ToolCallInfo | undefined>();
      for (const m of toolMsgs) {
        callOf.set(m.id, m.toolCallId ? callById.get(m.toolCallId) : undefined);
      }
      const derived: TurnDerived = {
        assistants,
        toolMsgs,
        toolMsgsOf,
        roundSteps,
        callOf,
        rounds: assistants.filter(
          (a) =>
            a.content ||
            a.thought ||
            (a.toolCalls && a.toolCalls.length > 0) ||
            a.error,
        ),
        results,
        resultsOf,
        writesFiles: [...writes.values()],
      };
      nextCache.set(key, derived);
      return { ...turn, derived };
    });
    turnCacheRef.current = nextCache;
    return { turns: out, callById };
  }, [messages]);

  // ---------- Живой артефакт (эффект живёт ниже объявления messages) ----------
  useEffect(() => {
    const m = streamingMsgId
      ? messages.find((x) => x.id === streamingMsgId)
      : undefined;
    if (!m) {
      // Стрим завершился: finalize сперва дренирует дельты, поэтому финальный
      // контент УЖЕ в messages — коммитим его синхронно (на abort вуаль
      // обязана погаснуть даже посреди фенса)
      const lastId = liveFenceRef.current.msgId;
      const lm = lastId ? messages.find((x) => x.id === lastId) : undefined;
      const match = lm
        ? /```html[^\n]*\n([\s\S]*?)(```|$)/.exec(lm.content)
        : null;
      setArtifactVeil(false);
      if (match) {
        const html = match[1] ?? "";
        setArtifactView((prev) => {
          const title = artifactTitleFromHtml(html) ?? t("artifacts.fallback");
          return prev?.html === html && prev?.title === title
            ? prev
            : { html, title };
        });
      }
      liveFenceRef.current = { start: -1, msgId: "", dismissed: false, timer: 0 };
      return;
    }
    const match = /```html[^\n]*\n([\s\S]*?)(```|$)/.exec(m.content);
    if (!match) return;
    const start = match.index;
    if (liveFenceRef.current.start !== start) {
      // Новый фенс (или новый прогон) — «не всплывать» сбрасывается
      liveFenceRef.current.start = start;
      liveFenceRef.current.msgId = m.id;
      liveFenceRef.current.dismissed = false;
    }
    window.clearTimeout(liveFenceRef.current.timer);
    liveFenceRef.current.timer = window.setTimeout(() => {
      const closed = match[2] === "```";
      const html = match[1] ?? "";
      setArtifactVeil(!closed);
      setArtifactView((prev) => {
        const title = artifactTitleFromHtml(html) ?? t("artifacts.fallback");
        return prev?.html === html && prev?.title === title
          ? prev
          : { html, title };
      });
      if (!closed && !liveFenceRef.current.dismissed && !artifactOpenRef.current) {
        setArtifactOpen(true);
      }
    }, 120);
  }, [messages, streamingMsgId, t]);

  // Контекст окна: prompt последнего ответа ≈ текущее заполнение
  const contextUsed = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = messages[i]?.usage;
      if (usage?.prompt) return usage.prompt;
    }
    return 0;
  }, [messages]);
  // Лимит: реальный от провайдера (/models), иначе эвристика по имени
  const contextLimit = useMemo(
    () => contextLimitFor(model, models.length > 0 ? models : null),
    [model, models],
  );
  // Если реальное использование ещё неизвестно — оцениваем сами (chars/4)
  const contextEstimate = useMemo(() => {
    let msgs = 0;
    for (const m of messages) {
      msgs +=
        Math.ceil(((m.content?.length ?? 0) + (m.thought?.length ?? 0)) / 4) + 8;
      for (const _a of m.attachments ?? []) msgs += 1500; // скриншот ≈ патч изображения
    }
    const prompt = session?.systemPrompt
      ? Math.ceil(session.systemPrompt.length / 4)
      : 0;
    return { msgs, prompt, sysTools: 0, mcpTools: 0 };
  }, [messages, session?.systemPrompt]);
  // Схемы инструментов (агентный режим): RFC — синхронно недоступны, тянем по требованию
  const [toolsTokens, setToolsTokens] = useState<{
    sys: number;
    mcp: number;
  } | null>(null);
  useEffect(() => {
    if (!agentMode) {
      setToolsTokens(null);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const schemas = (await getToolSchemas()) as unknown[];
        if (!Array.isArray(schemas) || dead) return;
        let sys = 0;
        let mcp = 0;
        for (const s of schemas) {
          const name =
            (s as { function?: { name?: string } })?.function?.name ?? "";
          const tokens = Math.ceil(JSON.stringify(s).length / 4);
          if (name.startsWith("mcp__")) mcp += tokens;
          else sys += tokens;
        }
        if (!dead) setToolsTokens({ sys, mcp });
      } catch {
        // превью в браузере или провайдер недоступен — без разбивки инструментов
      }
    })();
    return () => {
      dead = true;
    };
  }, [agentMode, model]);
  const contextRows = useMemo(() => {
    const msgs = contextUsed || contextEstimate.msgs;
    const rows: { label: MsgKey; tokens: number; color: string }[] = [
      {
        label: "ctx.messages",
        tokens: Math.max(msgs - contextEstimate.prompt - (toolsTokens?.sys ?? 0) - (toolsTokens?.mcp ?? 0), 0),
        color: CHART_COLORS[0],
      },
      {
        label: "ctx.sysTools",
        tokens: toolsTokens?.sys ?? 0,
        color: CHART_COLORS[0],
      },
      {
        label: "ctx.mcpTools",
        tokens: toolsTokens?.mcp ?? 0,
        color: CHART_COLORS[0],
      },
      {
        label: "ctx.sysPrompt",
        tokens: contextEstimate.prompt,
        color: CHART_COLORS[0],
      },
    ];
    return rows;
  }, [contextUsed, contextEstimate, toolsTokens]);

  // Суммарный расход токенов по всей задаче (M5.3)
  const totals = useMemo(() => {
    let up = 0;
    let down = 0;
    for (const m of messages) {
      if (m.usage) {
        up += m.usage.prompt;
        down += m.usage.completion;
      }
    }
    return { up, down, all: up + down };
  }, [messages]);

  // Сброс черновика при переключении задачи
  useEffect(() => {
    setDraft("");
  }, [session?.id]);

  // Приветствие по времени суток (обновляется раз в минуту):
  // 05–11:59 утро · 12–17:59 день · 18–22:59 вечер · 23–04:59 ночь.
  // Таймер живёт только пока приветствие реально видно (пустая лента):
  // раз в минуту ре-рендерил весь ChatArea с сотнями карточек впустую
  const [now, setNow] = useState(() => new Date());
  const greetingVisible = visible.length === 0 && !typing;
  useEffect(() => {
    if (!greetingVisible) return;
    const iv = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(iv);
  }, [greetingVisible]);
  const greetingKey = useMemo(() => {
    // UTC/GMT-совместимый расчёт периода (src/time.ts): при системном
    // поясе UTC часы берутся напрямую из GMT
    const p = dayPeriod(now);
    if (p === "morning") return "chat.greetingMorning";
    if (p === "afternoon") return "chat.greetingAfternoon";
    if (p === "evening") return "chat.greetingEvening";
    return "chat.greetingNight";
  }, [now]);
  // Своё приветствие (Настройки → Кастомизация): непустое перекрывает
  // стандартное приветствие по времени суток
  const timeGreeting = t(greetingKey);
  // Имя из локального профиля — только к приветствию по времени (UI,
  // в модель имя уходит лишь при включённом share-тумблере профиля)
  const displayName = getUserDisplayName();
  const greeting =
    appearance.customGreeting && appearance.customGreeting.trim().length > 0
      ? appearance.customGreeting
      : displayName
        ? `${timeGreeting}, ${displayName}`
        : timeGreeting;

  // ---------- Follow-up по выделенному фрагменту (цитата) ----------
  // Всплывающая кнопка у выделения; выбранная цитата живёт до отправки
  const [selBtn, setSelBtn] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [quoteDraft, setQuoteDraft] = useState<string | null>(null);
  const feedWrapRef = useRef<HTMLDivElement>(null);

  // Цитата из Review-панели (клик по строке диффа): заполняет тот же черновик
  // цитаты, что и выделение в ленте. Ref прочитанного nonce: клик по той же
  // строке должен сработать повторно, а собственные обновления state — нет
  const lastQuoteNonceRef = useRef(0);
  useEffect(() => {
    if (!pendingQuote || pendingQuote.nonce === lastQuoteNonceRef.current) return;
    lastQuoteNonceRef.current = pendingQuote.nonce;
    setQuoteDraft(pendingQuote.text);
  }, [pendingQuote]);

  useEffect(() => {
    const wrap = feedWrapRef.current;
    if (!wrap) return;

    const pick = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelBtn(null);
        return;
      }
      // Выделение должно лежать внутри ленты чата
      const anchor = sel.anchorNode;
      if (!anchor || !scrollRef.current?.contains(anchor)) {
        setSelBtn(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2) {
        setSelBtn(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelBtn(null);
        return;
      }
      setSelBtn({
        // по центру выделения, над ним
        x: rect.left + rect.width / 2 - wrapRect.left,
        y: rect.top - wrapRect.top - 6,
        text: text.slice(0, 600),
      });
    };

    const isEl = (t: EventTarget | null): t is Element =>
      t instanceof Element;

    const onMouseUp = (e: MouseEvent) => {
      // Клик по самой кнопке не гасит выделение — кнопка проверяет себя сама
      // (плюс кнопки возврата изображений в композер — та же природа)
      if (
        isEl(e.target) &&
        (e.target.closest("[data-sel-quote-btn]") ||
          e.target.closest("[data-reuse-img-btn]"))
      )
        return;
      window.setTimeout(pick, 0);
    };
    const onScroll = () => setSelBtn(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelBtn(null);
        setQuoteDraft(null);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (
        isEl(e.target) &&
        (e.target.closest("[data-sel-quote-btn]") ||
          e.target.closest("[data-reuse-img-btn]"))
      )
        return;
      setSelBtn(null);
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    // Фиксируем узел на момент монтирования: cleanup с scrollRef.current
    // снимал бы слушатель с УЖЕ ДРУГОГО узла (ref мог смениться)
    const scrollEl = scrollRef.current;
    scrollEl?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
      scrollEl?.removeEventListener("scroll", onScroll);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const takeQuote = () => {
    if (!selBtn) return;
    setQuoteDraft(selBtn.text);
    setSelBtn(null);
    window.getSelection()?.removeAllRanges();
    textareaRef.current?.focus();
  };

  // Реестр + встроенные и пользовательские команды. /имя → шаблон с
  // $ARGUMENTS разворачивается в черновик; пользовательская команда
  // с тем же именем перекрывает встроенную
  const allCommands = useMemo<SlashCommand[]>(() => {
    const templateCmd = (uc: { name: string; description: string; template: string }) => ({
      name: uc.name,
      desc: uc.description || t("cmd.user"),
      argHint: t("cmd.userArgs"),
      run: (arg: string) => setDraft(uc.template.replaceAll("$ARGUMENTS", arg)),
    });
    const byName = new Map<string, SlashCommand>();
    for (const c of slashCommands) byName.set(c.name, c);
    for (const bc of BUILTIN_COMMANDS) {
      if (!byName.has(bc.name)) byName.set(bc.name, templateCmd(bc));
    }
    for (const uc of userCommands ?? []) byName.set(uc.name, templateCmd(uc));
    return [...byName.values()];
  }, [slashCommands, userCommands, t]);

  // Slash-палитра: команда и подсказки аргументов по черновику
  const slash = useMemo(() => {
    if (!slashActive) return null;
    const spaceIdx = draft.indexOf(" ");
    const typed = draft.slice(1, spaceIdx === -1 ? undefined : spaceIdx).toLowerCase();
    const arg = spaceIdx === -1 ? "" : draft.slice(spaceIdx + 1).trimStart();
    const command =
      spaceIdx === -1
        ? undefined
        : allCommands.find((c) => c.name.toLowerCase() === typed);
    const matches = allCommands.filter((c) =>
      c.name.toLowerCase().startsWith(typed),
    );
    if (command?.suggestions && spaceIdx !== -1) {
      const sug = command
        .suggestions()
        .filter((x) => x.toLowerCase().includes(arg.toLowerCase()))
        .slice(0, 8);
      return { command, matches: [], suggestions: sug, arg };
    }
    return { command: undefined, matches: matches.slice(0, 8), suggestions: [], arg: "" };
  }, [draft, slashActive, allCommands]);

  useEffect(() => {
    setSlashIndex(0);
    setSkillIndex(0);
  }, [draft]);

  // Автоскролл к последнему сообщению и индикатору печати.
  // «Принудительный» — всегда за последней строкой; «умный» — замирает,
  // если пользователь отлистал вверх, и возобновляется у нижнего края.
  // D5: «был у низа» фиксируем в onScroll ДО коммита нового контента —
  // прежний расчёт nearBottom в useEffect шёл ПОСЛЕ коммита, и крупный чанк
  // (>150px) скачком отдалял низ, обрывая слежение на длинных ответах
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      nearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrollFollow || nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing, scrollFollow]);

  const autoGrow = (el: HTMLTextAreaElement) => {
    // Быстрый путь (набор текста): контент уже переполняет поле — растим без
    // сброса в auto. Сброс нужен только для обнаружения усадки (удаление):
    // это write→read→write с форсированным reflow на каждый ввод символа
    if (el.scrollHeight > el.clientHeight) {
      el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && pendingImages.length === 0) return;
    const attachments =
      pendingImages.length > 0 ? pendingImages : undefined;
    // Агент работает (typing мигает между шагами — надёжнее streamingMsgId):
    // в агентном режиме текст становится поправкой и уйдёт модели в начале
    // следующего раунда; в обычном чате — в очередь после текущего ответа
    if (typing || (agentMode && !!streamingMsgId)) {
      if (agentMode && onCorrect) {
        onCorrect(text);
      } else {
        // Цитату тоже сохраняем, чтобы она не потерялась при отправке из очереди
        onQueue(text, attachments, quoteDraft?.trim() || undefined);
      }
    } else {
      const quote = quoteDraft?.trim() || undefined;
      onSend(text, attachments, undefined, quote);
    }
    setDraft("");
    setQuoteDraft(null);
    setPendingImages([]);
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Палитра скилов (&): навигация как у slash, Enter вставляет шаблон
    if (skillActive && skillMatches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSkillIndex((i) =>
          e.key === "ArrowDown"
            ? (i + 1) % skillMatches.length
            : (i - 1 + skillMatches.length) % skillMatches.length,
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setDraft(`&${skillMatches[skillIndex]?.id ?? ""} `);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const skill = skillMatches[skillIndex];
        if (skill) setDraft(skill.prompt);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft("");
        return;
      }
    }
    // Slash-палитра перехватывает навигацию, пока открыта
    if (slash && slashActive) {
      const list = slash.suggestions.length > 0 ? slash.suggestions : slash.matches;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.length > 0) {
          setSlashIndex((i) =>
            e.key === "ArrowDown"
              ? (i + 1) % list.length
              : (i - 1 + list.length) % list.length,
          );
        }
        return;
      }
      if (e.key === "Tab" && list[slashIndex]) {
        e.preventDefault();
        const picked = list[slashIndex];
        setDraft(
          slash.suggestions.length > 0
            ? `/${slash.command ? slash.command.name : ""} ${picked}`.replace("/ ", "/")
            : `/${picked} `,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (slash.suggestions.length > 0 && list[slashIndex]) {
          setDraft(`/${slash.command ? slash.command.name : ""} ${list[slashIndex]}`);
          return;
        }
        if (slash.command) {
          slash.command.run(draft.slice(slash.command.name.length + 2).trim());
          setDraft("");
          return;
        }
        if (slash.matches[slashIndex]) {
          setDraft(`/${slash.matches[slashIndex].name} `);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };


  // Сборка ленты: раньше IIFE прямо в JSX — перестраивалась на каждый
  // keystroke черновика. Мемозируем: стабильная ссылка массива даёт
  // bailout reconcile, печать в композере больше не трогает ленту
  const feedNodes = useMemo(
    () => {
              const nodes: ReactNode[] = [];
              // Производные хода (callById/merged/results/writes) считаются
              // в useMemo «ribbon» выше — здесь только раскладка по нодам
              const { turns, callById } = ribbon;
              const isHidden = (m: Message) =>
                (m.role === "user" && !showUserMsgs) ||
                (m.role === "assistant" &&
                  m.content === "" &&
                  !m.thought &&
                  !m.toolCalls &&
                  !m.error &&
                  !m.ask);
              // Живой статус показываем внутри последней объединённой карточки;
              // отдельный бабл — только если карточки хода ещё нет
              let lastTurnMerged = false;

              // Оптимизация памяти: полностью рендерим только последние
              // RENDER_TURN_WINDOW ходов; более старые — заглушка с кнопкой
              const RENDER_TURN_WINDOW = 25;
              const visibleFrom = showOldTurns
                ? 0
                : Math.max(0, turns.length - RENDER_TURN_WINDOW);
              if (sessionWrites.length > 0) {
                if (sessionChangesOpen) {
                  nodes.push(
                    <ChangedFilesCard
                      key="session-changes"
                      files={sessionWrites}
                      onUndo={onUndoWrite}
                      onReview={
                        onReviewChanges
                          ? (fp) => onReviewChanges(sessionWrites, fp)
                          : undefined
                      }
                      onOpenExternal={onOpenFileExternal}
                    />,
                  );
                } else {
                  nodes.push(
                    <button
                      key="session-changes-open"
                      onClick={() => setSessionChangesOpen(true)}
                      className="mx-auto my-1 rounded-full border border-halo-line px-3 py-1 text-[0.6875rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                    >
                      {t("changes.task", { n: sessionWrites.length })}
                    </button>,
                  );
                }
              }

              if (visibleFrom > 0) {
                nodes.push(
                  <button
                    key="show-old-turns"
                    onClick={() => setShowOldTurns(true)}
                    className="mx-auto my-1 rounded-full border border-halo-line px-3 py-1 text-[0.6875rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                  >
                    {t("chat.showOldTurns", { n: visibleFrom })}
                  </button>,
                );
              }

              turns.forEach((turn, ti) => {
                if (ti < visibleFrom) return; // свёрнуто для экономии памяти
                const { derived } = turn;

                // Сообщение пользователя
                const turnUser = turn.user;
                if (turnUser && !isHidden(turnUser)) {
                  nodes.push(
                    <UserCard
                      key={turnUser.id}
                      mid={turnUser.id}
                      content={turnUser.content}
                      attachments={turnUser.attachments}
                      quote={turnUser.quote}
                      correction={turnUser.correction}
                      glassEffect={msgGlass}
                      onEdit={onEditMessage ? editMessage : undefined}
                      onReuseAttachment={reuseAttachment}
                    />,
                  );
                }

                const assistants = derived.assistants;

                if (groupTurns) {
                  // —— Ход ОДНОЙ плоской лентой в стиле ZCode (фидбек 30.09):
                  // шапка с таймером, строки «Размышления · N с» → текст →
                  // шаги хронологически, usage один раз в конце. Без карточек
                  // на каждый раунд — они и дублировали шапки/мысли ——
                  if (assistants.length > 0) {
                    // Из derived-кэша: стабильная ссылка на каждый тик стрима
                    const rounds = derived.rounds;
                    if (rounds.length > 0 && ti === turns.length - 1) {
                      lastTurnMerged = true;
                    }
                    const renderedSubs = new Set<string>();
                    if (rounds.length > 0) {
                      nodes.push(
                        <RunCard
                          key={`run-${turnUser?.id ?? ti}`}
                          runKey={turnUser?.id ?? `run-${ti}`}
                          rounds={rounds}
                          stepsOf={derived.roundSteps}
                          toolMsgsOf={derived.toolMsgsOf}
                          callOf={derived.callOf}
                          subRuns={subRuns}
                          model={
                            rounds[rounds.length - 1]?.model ?? model
                          }
                          hint={
                            ti === turns.length - 1 ? activity : null
                          }
                          isStreaming={rounds.some((a) => a.id === streamingMsgId)}
                          streamingMsgId={streamingMsgId}
                          showMsgTime={showMsgTime}
                          smooth={streamSmooth}
                          printSpeed={printSpeed}
                          highlightLive={highlightLive}
                          showReasoning={showReasoning}
                          caret={streamCaret}
                          onPreviewArtifact={openArtifact}
                        />,
                      );
                      for (const a of rounds) {
                        for (const m of derived.toolMsgsOf.get(a.id) ?? []) {
                          if (m.toolName !== "subagent_run") continue;
                          renderedSubs.add(m.id);
                        }
                      }
                    }
                    // Субагенты-сироты (владелец не найден) — не теряем
                    for (const m of derived.toolMsgs) {
                      if (m.toolName !== "subagent_run" || renderedSubs.has(m.id))
                        continue;
                      nodes.push(
                        <SubagentCard
                          key={`sub-${m.id}`}
                          mid={m.id}
                          call={
                            m.toolCallId ? callById.get(m.toolCallId) : undefined
                          }
                          content={m.content}
                          run={subRuns?.[m.toolCallId ?? ""]}
                        />,
                      );
                    }
                    // Закрытые вопросы ask_user остаются в истории
                    // (живой вопрос показывается панелью над композером)
                    for (const a of assistants) {
                      if (!a.ask || !(a.ask.answer || a.ask.cancelled)) continue;
                      nodes.push(<AskClosedCard key={`ask-${a.id}`} ask={a.ask} />);
                    }
                  }
                } else {
                  // —— Каждый шаг отдельно: результаты при своей карточке ——
                  // resultsOf считается в derived (кэш производных хода)
                  const { resultsOf } = derived;
                  for (const m of turn.items) {
                    if (isHidden(m)) continue;
                    nodes.push(
                      m.role === "tool" ? (
                        m.toolName === "subagent_run" ? (
                          // Субагент: своя карточка вместо серой tool-строки
                          <SubagentCard
                            key={m.id}
                            mid={m.id}
                            call={
                              m.toolCallId ? callById.get(m.toolCallId) : undefined
                            }
                            content={m.content}
                            run={subRuns?.[m.toolCallId ?? ""]}
                          />
                        ) : (
                        // Инструмент без владельца (старые сессии) — standalone
                        <ToolStepCard
                          key={m.id}
                          mid={m.id}
                          call={
                            m.toolCallId ? callById.get(m.toolCallId) : undefined
                          }
                          content={m.content}
                          status={m.status}
                        />
                        )
                        ) : m.role === "assistant" ? (
                        // Сообщение-карточка вопроса (ask_user) без своего
                        // текста — рендерится только AskUserCard ниже
                        m.ask && !m.content && !m.thought && !m.toolCalls && !m.error ? null : (
                          <AssistantCard
                            key={m.id}
                            mid={m.id}
                            message={m}
                            model={m.model ?? model}
                            results={resultsOf.get(m.id)}
                            glassEffect={msgGlass}
                            showMsgTime={showMsgTime}
                            isStreaming={m.id === streamingMsgId}
                            smooth={streamSmooth}
                            highlightLive={highlightLive}
                            printSpeed={printSpeed}
                            showReasoning={showReasoning}
                            caret={streamCaret}
                            onPreviewArtifact={openArtifact}
                          />
                        )
                      ) : null,
                    );
                    if (
                      m.role === "assistant" &&
                      m.ask &&
                      (m.ask.answer || m.ask.cancelled)
                    ) {
                      nodes.push(<AskClosedCard key={`ask-${m.id}`} ask={m.ask} />);
                    }
                  }
                }

                // Сводка изменённых файлов — в конце хода
                if (derived.writesFiles.length > 0) {
                  nodes.push(
                    <ChangedFilesCard
                      key={`changes-${turn.user?.id ?? ti}`}
                      files={derived.writesFiles}
                      onUndo={onUndoWrite}
                      onReview={
                        onReviewChanges
                          ? (fp) => onReviewChanges(derived.writesFiles, fp)
                          : undefined
                      }
                      onOpenExternal={onOpenFileExternal}
                    />,
                  );
                }
              });
              // Живые карточки субагентов: прогон идёт, tool-сообщения ещё нет
              {
                const doneSubs = new Set(
                  messages
                    .filter((m) => m.role === "tool" && m.toolName === "subagent_run")
                    .map((m) => m.toolCallId),
                );
                for (const m of messages) {
                  for (const tc of m.toolCalls ?? []) {
                    if (tc.name !== "subagent_run") continue;
                    if (doneSubs.has(tc.id)) continue;
                    const run = subRuns?.[tc.id];
                    if (!run || run.report !== null) continue;
                    nodes.push(
                      <SubagentCard
                        key={`sub-live-${tc.id}`}
                        mid={tc.id}
                        call={tc}
                        content=""
                        run={run}
                      />,
                    );
                  }
                }
              }
              // Отдельный бабл статуса — пока объединённая карточка хода
              // ещё не появилась (самое начало запроса / не-группированный режим)
              if (
                activity &&
                (!groupTurns || !lastTurnMerged)
              ) {
                nodes.push(<TypingBubble key="typing" label={activity} />);
              }
              return nodes;
    },
    // Сознательно вне списка: derived/turns пересчитываются от messages
    // (они в deps), функции-стабы стабильны по построению.
    // printSpeed/highlightLive/showReasoning ДОЛЖНЫ быть здесь: настройки
    // чтения применяются к карточкам лениво, только когда messages меняется
    // (находка аудита — «тихо не работает»)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activity,
      editMessage,
      groupTurns,
      highlightLive,
      messages,
      model,
      msgGlass,
      onEditMessage,
      onReviewChanges,
      onUndoWrite,
      printSpeed,
      reuseAttachment,
      ribbon,
      sessionChangesOpen,
      sessionWrites,
      showMsgTime,
      showOldTurns,
      showReasoning,
      showUserMsgs,
      streamCaret,
      streamSmooth,
      streamingMsgId,
      subRuns,
      t,
    ],
  );
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col bg-halo-bg">
      {/* Drag&drop: оверлей на время перетаскивания файлов (поверх всего) */}
      {dragActive && (
        <div
          aria-hidden
          className="anim-fade pointer-events-none fixed inset-0 z-[var(--halo-z-modal-top)] flex items-center justify-center bg-black/30"
        >
          <div className="anim-pop rounded-2xl border border-halo-accent/60 bg-halo-surface/95 px-6 py-4 text-sm font-medium text-halo-text shadow-2xl backdrop-blur-sm">
            {t("composer.dropFiles")}
          </div>
        </div>
      )}
      {/* Шапка: название задачи и очистка; вся полоса — drag-регион окна */}
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center border-b border-halo-line transition-[padding] duration-200 ${
          headerInset === "left"
            ? "pl-14 pr-1.5"
            : headerInset === "right"
              ? "pl-6 pr-14"
              : "pl-6 pr-1.5"
        }`}
      >
        <h1
          data-tauri-drag-region
          className="min-w-0 flex-1 truncate text-sm font-medium text-halo-muted"
        >
          {session?.title ?? t("chat.new")}
        </h1>
        {/* Суммарные токены задачи (M5.3); неинтерактивный индикатор —
            тоже drag-регион, иначе в шапке остаётся мёртвая зона */}
        {totals.all > 0 && (
          <span
            data-tauri-drag-region
            title={`${t("tokens.up")}: ${fmtInt(totals.up, lang)} · ${t("tokens.down")}: ${fmtInt(totals.down, lang)} · ${t("tokens.total")}: ${fmtInt(totals.all, lang)}`}
            className="mr-2 shrink-0 text-[0.625rem] text-halo-muted/70"
          >
            <span className="text-halo-muted">↑{fmtK(totals.up, lang)}</span>{" "}
            <span className="text-halo-muted">↓{fmtK(totals.down, lang)}</span>{" "}
            <span className="font-medium text-halo-accent/80">
              Σ{fmtK(totals.all, lang)}
            </span>
          </span>
        )}
        {onOpenCompare && (
          <button
            onClick={onOpenCompare}
            title={t("cmp.open")}
            className="mr-1 rounded-md p-1.5 text-halo-muted transition duration-150 hover:bg-halo-hover hover:text-halo-text"
          >
            <ScalesIcon />
          </button>
        )}
        {onOpenKnowledge && (
          <button
            onClick={onOpenKnowledge}
            title={t("kb.open")}
            className="mr-1 rounded-md p-1.5 text-halo-muted transition duration-150 hover:bg-halo-hover hover:text-halo-text"
          >
            <BookIcon />
          </button>
        )}
        <button
          onClick={() => setSysOpen(true)}
          title={t("sysprompt.title")}
          className={`mr-1 rounded-md p-1.5 transition duration-150 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40 ${
            hasSystemPrompt
              ? "text-halo-accent"
              : "text-halo-muted hover:text-halo-text"
          }`}
        >
          <SystemPromptIcon />
        </button>
        <button
          onClick={onClearChat}
          disabled={visible.length === 0}
          title={t("composer.clearChat")}
          className="mr-1 rounded-md p-1.5 text-halo-muted transition duration-150 hover:bg-halo-hover hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-halo-muted"
        >
          <TrashIcon />
        </button>
        {showWindowControls && <WindowControls />}
      </header>

      {/* Лента сообщений (relative-обёртка держит MessageNav вне скролла) */}
      <div ref={feedWrapRef} className="relative min-h-0 flex-1">
      {/* Кнопка «задать вопрос по теме» у выделенного фрагмента */}
      {selBtn && (
        <button
          data-sel-quote-btn
          onClick={takeQuote}
          className="glass-pane absolute z-30 flex -translate-x-1/2 -translate-y-full items-center gap-1.5 rounded-full border border-halo-accent/50 bg-halo-deep/90 px-3 py-1.5 text-xs text-halo-text shadow-xl transition-transform hover:scale-105"
          style={{ left: Math.max(90, Math.min(selBtn.x, (feedWrapRef.current?.clientWidth ?? 400) - 90)), top: Math.max(8, selBtn.y) }}
        >
          <span className="text-halo-accent"><QuoteIcon /></span>
          {t("chat.askAboutSelection")}
        </button>
      )}
      {/* Призрачный логотип на фоне ленты (за контентом, тумблер в «Темах») */}
      {chatMark && visible.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-0 flex select-none items-center justify-center opacity-[0.04]">
          <NocturnMark size={520} />
        </div>
      )}
      {/* План задач агента (виджет Progress): в relative-обёртке зоны чата,
          вне скролл-контейнера — висит в углу и не уезжает при прокрутке */}
      {plan && plan.length > 0 && <PlanPanel plan={plan} />}
      <div
        ref={scrollRef}
        className="scroll-slim relative z-10 h-full overflow-y-auto"
      >
        {visible.length === 0 && !typing ? (
          <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6 text-center">
            {/* Гигантский призрачный логотип фоном — как в ZCode */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[64%] select-none opacity-[0.05]">
              <NocturnMark size={480} />
            </div>

            <div className="relative z-10 flex w-full max-w-2xl flex-col items-center">
              <span className="text-halo-accent">
                <SparkIcon />
              </span>
              <h2 className="mt-4 text-3xl font-medium tracking-tight text-halo-text">
                {greeting}
              </h2>
              <p className="mb-7 mt-2 max-w-sm text-sm leading-relaxed text-halo-muted">
                {t("chat.greetingSub")}
              </p>

              {/* Динамический дашборд вместо статических подсказок (фидбек
                  29.09): живые статусы MCP/Colibri, незавершённые задачи,
                  код-действия. Роли/промты остались в «Настройках» и «/» */}
              {!hideStarter && (
                <GreetingDashboard
                  sessions={sessions}
                  onOpenSession={onOpenSession}
                  onOpenSettingsSection={onOpenSettingsSection}
                  onQuickPrompt={(text) => {
                    setDraft(text);
                    if (textareaRef.current) {
                      autoGrow(textareaRef.current);
                      textareaRef.current.focus();
                    }
                  }}
                />
              )}

              <button
                onClick={onToggleStarter}
                className="mt-7 rounded-md px-2 py-1 text-[0.6875rem] text-halo-muted/60 transition-colors hover:text-halo-muted"
              >
                {hideStarter ? t("chat.showStarter") : t("chat.hideStarter")}
              </button>
            </div>
          </div>
        ) : (
          <div className="msg-feed mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-8">
            {/* Ход = сообщение пользователя + всё, что агент сделал до следующего.
                groupTurns: весь ход в ОДНОЙ карточке; иначе каждый шаг отдельно.
                В конце хода — сводка изменённых файлов */}
            {/* D3: key по сессии — одна битая карточка больше не кладёт границу
                в error-state навсегда: смена задачи сбрасывает фолбэк */}
            <ErrorBoundary key={session?.id ?? "none"} title={t("err.boundary")} action={t("err.boundaryRetry")}>
            {feedNodes}
            </ErrorBoundary>
            {pendingConfirm && !terminalOpen && (
              <ConfirmCard
                call={pendingConfirm.call}
                onDecision={onConfirmDecision}
              />
            )}
          </div>
        )}
      </div>

      {/* Боковая навигация по сообщениям (чёрточки справа).
          Вне скролл-контейнера: иначе весь блок уезжает при прокрутке */}
      {visible.length > 1 && (
        <MessageNav messages={visible} model={model} scrollRef={scrollRef} />
      )}
      </div>

      {/* Терминальный режим: панель снизу, подтверждения [y/n/a] прямо в ней.
          D7: без key по сессии — раньше смена задачи перемонтировала панель,
          и unmount-эффект убивал PTY: запущенный в консоли сервер/билд умирал
          от клика по другой задаче. Консоль общая, скроллбэк переживает
          переключение */}
      {terminalOpen && (
        <TerminalPanel
          session={session}
          streamingMsgId={streamingMsgId}
          pendingConfirm={pendingConfirm}
          projectRoot={projectRoot}
          termShell={termShell}
          termPalette={termPalette}
          termBlur={termBlur}
          heightPct={terminalHeightPct}
          onResizeStart={onTerminalResizeStart}
          onConfirmDecision={onConfirmDecision}
          onClose={onToggleTerminal}
        />
      )}

      <SystemPromptModal
        open={sysOpen}
        initial={session?.systemPrompt ?? ""}
        onSave={(v) => onSetSystemPrompt(v)}
        onClose={() => setSysOpen(false)}
      />

      {/* Поле ввода с нижней панелью: модель · подсказка · отправка */}
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto w-full max-w-3xl">
          {/* z-30 выше ленты сообщений (z-10): glass-pane создаёт stacking
              context, и палитра slash без этого слоя оказывалась под лентой */}
          <div className="glass-pane relative z-30 rounded-2xl border border-halo-line bg-halo-surface p-2.5 shadow-sm transition duration-200">
            {/* Палитра скилов (&) */}
            {skillActive && skillMatches.length > 0 && (
              <div className="scroll-slim absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                  {t("skills.palette")}
                </p>
                {skillMatches.map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => setDraft(s.prompt)}
                    className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      i === skillIndex
                        ? "bg-halo-accent/15"
                        : "hover:bg-halo-hover"
                    }`}
                  >
                    <span
                      className={`shrink-0 font-mono text-xs font-semibold ${
                        i === skillIndex ? "text-halo-accent" : "text-halo-muted"
                      }`}
                    >
                      &{s.id}
                    </span>
                    <span className="min-w-0 truncate text-xs text-halo-muted">
                      {lang === "ru" ? s.desc?.ru ?? "" : s.desc?.en ?? ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {/* Slash-палитра */}
            {slash && slashActive && (
              <div className="scroll-slim absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                {slash.command && slash.suggestions.length > 0 ? (
                  <div>
                    <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                      /{slash.command.name} · {slash.command.argHint ?? t("cmd.args")}
                    </p>
                    {slash.suggestions.map((sug, i) => (
                      <button
                        key={sug}
                        onClick={() => setDraft(`/${slash.command ? slash.command.name : ""} ${sug}`)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                          i === slashIndex
                            ? "bg-halo-accent/15 text-halo-accent"
                            : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                        }`}
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div>
                    {slash.matches.map((c, i) => (
                      <button
                        key={c.name}
                        onClick={() => setDraft(`/${c.name} `)}
                        className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                          i === slashIndex ? "bg-halo-accent/15" : "hover:bg-halo-hover"
                        }`}
                      >
                        <span
                          className={`shrink-0 font-mono text-xs font-semibold ${
                            i === slashIndex ? "text-halo-accent" : "text-halo-text"
                          }`}
                        >
                          /{c.name}
                        </span>
                        <span className="truncate text-xs text-halo-muted">
                          {c.desc}
                          {c.argHint && (
                            <span className="ml-1 text-halo-muted/50">· {c.argHint}</span>
                          )}
                        </span>
                      </button>
                    ))}
                    {slash.matches.length === 0 && (
                      <p className="px-2 py-2 text-xs text-halo-muted/60">{t("cmd.none")}</p>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Очередь сообщений: уйдут агенту после текущего ответа */}
            {queued.length > 0 && (
              <div className="mb-2 space-y-1.5">
                <p className="px-1 text-[0.6875rem] font-medium uppercase tracking-wider text-halo-muted/70">
                  {t("composer.queued")}
                </p>
                {queued.map((q) => (
                  <div
                    key={q.id}
                    className="anim-fade-up flex items-start gap-2 rounded-xl border border-halo-line bg-halo-hover/40 px-3 py-2"
                  >
                    <span className="mt-0.5 shrink-0 text-halo-muted">
                      <QueueIcon />
                    </span>
                    <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-halo-muted">
                      {q.text}
                    </p>
                    <button
                      onClick={() => onQueuedRemove(q.id)}
                      title={t("composer.queuedRemove")}
                      className="shrink-0 rounded-md p-0.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Цитата (follow-up по выделенному) — над полем ввода */}
            {quoteDraft && (
              <div className="anim-fade-up mb-2 flex items-start gap-2 rounded-xl border border-halo-accent/30 bg-halo-accent/5 px-3 py-2">
                <span className="mt-0.5 shrink-0 text-halo-accent"><QuoteIcon /></span>
                <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-halo-muted">
                  {quoteDraft}
                </p>
                <button
                  onClick={() => setQuoteDraft(null)}
                  title={t("composer.quoteRemove")}
                  className="shrink-0 rounded-md p-0.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                >
                  ✕
                </button>
              </div>
            )}
            {/* Живой вопрос агента: панель над композером, прикреплена к нему */}
            {pendingAsk && !terminalOpen && (
              <AskPanel
                ask={pendingAsk.ask}
                onAnswer={(ans) => onAskAnswer(pendingAsk.msgId, ans)}
              />
            )}
            {/* Вложения — квадратные плитки НАД полем ввода (как у Claude):
                картинка заливает квадрат, документ — квадрат с именем */}
            {pendingImages.length > 0 && (
              <div className="anim-fade-up mb-1 flex flex-wrap gap-2 px-1">
                {pendingImages.map((img, i) => (
                  <div key={img.id ?? `${img.name}-${i}`} className="group relative">
                    {img.dataUrl ? (
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        title={img.name}
                        className="size-20 rounded-xl border border-halo-line object-cover"
                      />
                    ) : (
                      <div
                        title={img.name}
                        className="flex size-20 flex-col items-center justify-center gap-1 rounded-xl border border-halo-line bg-halo-surface/60 p-1.5"
                      >
                        <span className="text-lg text-halo-muted">📄</span>
                        <span className="w-full truncate text-center text-[0.625rem] text-halo-muted">
                          {img.name}
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() =>
                        setPendingImages((prev) =>
                          prev.filter((_, j) => j !== i),
                        )
                      }
                      title={t("chat.removeImage")}
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-halo-line bg-halo-deep text-halo-muted shadow-sm transition-colors hover:text-red-400"
                    >
                      <XSmallIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,text/*,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.sql,.sh,.toml,.ini"
                multiple
                className="hidden"
                onChange={(e) => {
                  Array.from(e.target.files ?? []).forEach(readFile);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                title={t("composer.attach")}
                className="flex size-9 shrink-0 items-center justify-center rounded-xl text-halo-muted transition duration-150 hover:bg-halo-hover hover:text-halo-text"
              >
                <PaperclipIcon />
              </button>
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={handleKeyDown}
                placeholder={t("composer.placeholder")}
                className="composer-field max-h-44 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-halo-text outline-none placeholder:text-halo-muted"
              />
              <button
                onClick={() => {
                  // Пока getUserMedia инициализируется — клики игнорируем,
                  // иначе повторный клик сбил бы оптимистичный флаг
                  if (recStartingRef.current) return;
                  if (recording) void stopRecording();
                  else void startRecording();
                }}
                disabled={dictBusy}
                title={t("dictation.button")}
                className={`flex size-9 shrink-0 items-center justify-center rounded-xl transition duration-150 hover:bg-halo-hover ${
                  recording
                    ? "bg-red-400/15 text-red-400"
                    : dictBusy
                      ? "animate-pulse text-halo-accent"
                      : "text-halo-muted hover:text-halo-text"
                }`}
              >
                <MicIcon />
              </button>
              {/* Поправка агенту на ходу: рядом со Stop, пока есть черновик */}
              {streamingMsgId && agentMode && draft.trim() && (
                <button
                  onClick={submit}
                  title={t("composer.correct")}
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-halo-line text-halo-text transition duration-150 hover:border-halo-accent/60 hover:text-halo-accent active:scale-95"
                >
                  <CorrectIcon />
                </button>
              )}
              {/* Морф отправка ↔ стоп: одна кнопка, обе иконки живут в ней
                  и меняются transform'ом (клодовский «перелив» состояния).
                  transition только по transform/opacity — конвенция дома */}
              <button
                onClick={streamingMsgId ? onStop : submit}
                disabled={!streamingMsgId && !draft.trim() && pendingImages.length === 0}
                title={t(streamingMsgId ? "composer.stop" : "composer.send")}
                aria-label={t(streamingMsgId ? "composer.stop" : "composer.send")}
                className={`relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border shadow-sm transition-[background-color,border-color,color] duration-200 active:scale-95 ${
                  streamingMsgId
                    ? "border-halo-line bg-transparent text-halo-text hover:border-red-400/60 hover:text-red-400"
                    : "border-transparent bg-halo-accent text-halo-on-accent hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
                }`}
              >
                <span
                  className={`absolute flex transition-[transform,opacity] duration-200 ${
                    streamingMsgId
                      ? "scale-0 -rotate-90 opacity-0"
                      : "scale-100 rotate-0 opacity-100"
                  }`}
                >
                  <ArrowUpIcon />
                </span>
                <span
                  className={`absolute flex transition-[transform,opacity] duration-200 ${
                    streamingMsgId
                      ? "scale-100 rotate-0 opacity-100"
                      : "scale-0 rotate-90 opacity-0"
                  }`}
                >
                  <StopIcon />
                </span>
              </button>
            </div>

            {/* Предупреждение: модель не принимает изображения */}
            {pendingImages.some((a) => a.dataUrl) && visionCapable === false && (
              <div className="anim-fade-up mx-2 mb-1 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
                <span className="mt-0.5">⚠</span>
                <span>{t("error.vision")}</span>
              </div>
            )}

            {/* Нижняя панель в духе ZCode: режимы слева, модель и настройки
                справа. Все чипы — единая анатомия COMPOSER_CHIP */}
            <div className="mt-1.5 flex items-center gap-1.5 px-1">
              <button
                onClick={onToggleAgent}
                title={t("agent.toggle")}
                className={`${COMPOSER_CHIP} ${agentMode ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF}`}
              >
                <RobotIcon />
                {t("agent.toggle")}
              </button>
              <button
                onClick={onToggleTerminal}
                title={t("terminal.toggle")}
                className={`${COMPOSER_CHIP} ${terminalOpen ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF}`}
              >
                <TerminalIcon />
                {t("terminal.toggle")}
              </button>
              {/* Режим разрешений агента (plan / ask / edit / full) */}
              <div className="relative">
                <button
                  onClick={() => setPermOpen((v) => !v)}
                  title={t("perms.title")}
                  className={`${COMPOSER_CHIP} ${
                    permissionMode !== "ask" ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF
                  }`}
                >
                  <ShieldIcon />
                  <span className="max-w-32 truncate">
                    {t(`perms.${permissionMode}`)}
                  </span>
                  <ChevronDownIcon />
                </button>
                {permOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setPermOpen(false)}
                    />
                    <div className="anim-pop absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                      <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                        {t("perms.title")}
                      </p>
                      {(
                        [
                          "plan",
                          "ask",
                          "edit",
                          "full",
                        ] as PermissionMode[]
                      ).map((m) => (
                        <button
                          key={m}
                          onClick={() => {
                            onPermissionModeChange(m);
                            setPermOpen(false);
                          }}
                          className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            permissionMode === m
                              ? "bg-halo-accent/15"
                              : "hover:bg-halo-hover"
                          }`}
                        >
                          <span
                            className={`mt-0.5 shrink-0 ${
                              permissionMode === m
                                ? "text-halo-accent"
                                : "text-halo-muted"
                            }`}
                          >
                            <PermModeIcon mode={m} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-halo-text">
                              {t(`perms.${m}`)}
                            </span>
                            <span className="block text-[0.6875rem] leading-snug text-halo-muted">
                              {t(`perms.${m}Desc`)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* Инструменты агента: чёрный список задачи */}
              <div className="relative">
                <button
                  onClick={openTools}
                  title={t("tools.title")}
                  className={`${COMPOSER_CHIP} ${
                    disabledTools.length > 0 ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF
                  }`}
                >
                  <WrenchIcon />
                  {disabledTools.length > 0 && (
                    <span className="tabular-nums">{disabledTools.length}</span>
                  )}
                  <ChevronDownIcon />
                </button>
                {toolsOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setToolsOpen(false)}
                    />
                    <div className="scroll-slim anim-pop absolute bottom-full left-0 z-30 mb-2 max-h-80 w-64 overflow-y-auto rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                      <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                        {t("tools.title")}
                      </p>
                      <p className="px-2 pb-1.5 text-[0.6875rem] leading-snug text-halo-muted">
                        {t("tools.hint")}
                      </p>
                      {toolNames === null ? (
                        <p className="px-2 py-1.5 text-xs text-halo-muted">…</p>
                      ) : toolNames.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-halo-muted">
                          {t("tools.empty")}
                        </p>
                      ) : (
                        toolNames.map((name) => {
                          const off = disabledTools.includes(name);
                          return (
                            <button
                              key={name}
                              onClick={() => onToggleDisabledTool(name)}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                                off
                                  ? "bg-halo-accent/10 text-halo-text"
                                  : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                              }`}
                            >
                              <span
                                className={`flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                                  off
                                    ? "border-halo-accent bg-halo-accent"
                                    : "border-halo-muted/50"
                                }`}
                              >
                                {off && (
                                  <svg
                                    viewBox="0 0 10 10"
                                    className="size-2.5 text-halo-on-accent"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M1.5 5.5l2.5 2.5 4.5-5" />
                                  </svg>
                                )}
                              </span>
                              <span className="truncate font-mono">{name}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
              <span className="flex-1" />
              <span className="flex h-7 items-center">
                <ContextRing
                  used={contextUsed || contextEstimate.msgs + contextEstimate.prompt}
                  limit={contextLimit}
                  rows={contextRows}
                  isEstimate={!contextUsed}
                />
              </span>
              {/* Монитор субагентов: только когда прогоны были/идут */}
              {Object.keys(subRuns ?? {}).length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setSubOpen((v) => !v)}
                    title={t("sub.monitor")}
                    className={`${COMPOSER_CHIP} ${
                      subOpen ||
                      Object.values(subRuns ?? {}).some((r) => r.report === null)
                        ? COMPOSER_CHIP_ON
                        : COMPOSER_CHIP_OFF
                    }`}
                  >
                    <RobotIcon />
                    <span className="tabular-nums">
                      {Object.values(subRuns ?? {}).filter((r) => r.report === null).length ||
                        Object.keys(subRuns ?? {}).length}
                    </span>
                  </button>
                  {subOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-20"
                        onClick={() => setSubOpen(false)}
                      />
                      <div className="anim-pop absolute bottom-full right-0 z-30 mb-2 w-80 rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                        <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                          {t("sub.monitor")}
                        </p>
                        {Object.entries(subRuns ?? {}).map(([id, r]) => (
                          <div
                            key={id}
                            className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                          >
                            <span
                              className={`size-1.5 shrink-0 rounded-full ${
                                r.report === null
                                  ? "animate-pulse bg-halo-accent"
                                  : "bg-emerald-400"
                              }`}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-halo-text">
                                {r.roleName}
                              </p>
                              {r.task && (
                                <p className="truncate text-[0.6875rem] text-halo-muted/70">
                                  {r.task}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* Модель — в правом кластере (ZCode/Claude:Capabilities слева,
                  модель и настройки справа) */}
              <button
                onClick={onOpenSettings}
                title={model ? model : t("chat.modelHint")}
                className={`${COMPOSER_CHIP} ${COMPOSER_CHIP_OFF}`}
              >
                <ProviderIcon modelId={model} size={12} />
                <span className="max-w-32 truncate">
                  {model ? brandName(model) : t("chat.modelNotSet")}
                </span>
                {isLocal && (
                  <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-400">
                    {t("chat.modelLocal")}
                  </span>
                )}
                <ChevronDownIcon />
              </button>
              <div className="relative">
                <button
                  onClick={() => setQuickOpen((v) => !v)}
                  title={t("qs.title")}
                  className={`${COMPOSER_CHIP} ${
                    quickOpen ? COMPOSER_CHIP_ON : COMPOSER_CHIP_OFF
                  }`}
                >
                  <SlidersIcon />
                </button>
                {quickOpen && (
                  <div className="absolute bottom-full right-0">
                    <QuickSettings
                      model={model}
                      models={models}
                      onModel={onModelChange}
                      effort={effort}
                      onEffortChange={onEffortChange}
                      promptPresets={promptPresets}
                      customPresets={customPresets}
                      onApplyPreset={onApplyPreset}
                      theme={theme}
                      appearance={appearance}
                      onThemeChange={onThemeChange}
                      onAppearanceChange={onAppearanceChange}
                      glass={glass}
                      onGlassChange={onGlassChange}
                      onClose={() => setQuickOpen(false)}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <ArtifactsPanel
        open={artifactOpen}
        artifact={artifactView}
        veil={artifactVeil}
        onClose={() => {
          setArtifactOpen(false);
          // Ручное закрытие во время стрима: не всплывать снова до
          // следующего фенса (сбрасывается в live-эффекте)
          liveFenceRef.current.dismissed = true;
        }}
      />
    </section>
  );
}

