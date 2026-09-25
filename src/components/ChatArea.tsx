import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AskQuestion, Attachment, ChangedFile, Message, PermissionMode, PlanTask, Session, ToolCallInfo } from "../types";
import type { PromptPreset } from "../presets";
import { normalizePath, parseWriteResult } from "../diff";
import type { SlashCommand } from "../commands";
import QuickSettings from "./QuickSettings";
import NocturnMark from "./NocturnMark";
import type { Appearance } from "../appearance";
import { getToolSchemas, contextLimitFor, type ModelInfo } from "../api";
import type { Theme } from "../types";
import SystemPromptModal from "./SystemPromptModal";
import TerminalPanel from "./TerminalPanel";
import WindowControls from "./WindowControls";
import ProviderIcon, { brandName } from "./ProviderIcon";
import { useLang } from "../locales";
import { dayPeriod } from "../time";
import { BUILTIN_SKILLS, type Skill } from "../skills";
import type { SubRunState } from "../subagents";
import type { UserCommand } from "../api";
import { BUILTIN_COMMANDS } from "../commands";
import { AskClosedCard, AskPanel } from "./cards/AskUserCard";
import { AssistantCard } from "./cards/AssistantCard";
import { ChangedFilesCard } from "./cards/ChangedFilesCard";
import { ConfirmCard } from "./cards/ConfirmCard";
import { ContextRing } from "./cards/ContextRing";
import { MessageNav } from "./cards/MessageNav";
import { PlanPanel } from "./cards/PlanPanel";
import { SubagentCard } from "./cards/SubagentCard";
import { ToolStepCard } from "./cards/ToolStepCard";
import { TypingBubble } from "./cards/TypingBubble";
import { ErrorBoundary } from "./ErrorBoundary";
import { UserCard } from "./cards/UserCard";
import { ArrowUpIcon, ChevronDownIcon, CorrectIcon, PaperclipIcon, PermModeIcon, QueueIcon, QuoteIcon, RobotIcon, ShieldIcon, SlidersIcon, SparkIcon, StopIcon, SystemPromptIcon, TerminalIcon, TrashIcon, WrenchIcon, XSmallIcon } from "./cards/icons";
import { fmtK } from "./cards/util";

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
  /** Ожидающее подтверждение агента */
  pendingConfirm: { requestId: string; call: ToolCallInfo } | null;
  /** Встроенные роли (Код / Инженер / …) */
  promptPresets: PromptPreset[];
  /** Пользовательские роли из библиотеки */
  customPresets: PromptPreset[];
  onSend: (
    text: string,
    attachments?: Attachment[],
    overrideTargetId?: string,
    quote?: string,
  ) => void;
  onClearChat: () => void;
  /** Очередь корректирующих сообщений: отправятся после ответа агента */
  queued: { id: string; text: string }[];
  onQueue: (text: string, attachments?: Attachment[], quote?: string) => void;
  onQueuedRemove: (id: string) => void;
  /** Поправка агенту на ходу: уходит модели в следующем раунде, не прерывая работу */
  onCorrect?: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
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
  /** Стартовые подсказки скрыты (эргономика) */
  hideStarter: boolean;
  onToggleStarter: () => void;
  /** Высота терминальной панели, % и drag-хендл */
  terminalHeightPct: number;
  onTerminalResizeStart: () => void;
  /** Поведение генерации: принудительный автоскролл, плавная печать, каретка */
  scrollFollow: boolean;
  streamSmooth: boolean;
  /** Раскрывать блок рассуждений автоматически */
  showReasoning: boolean;
  streamCaret: boolean;
  /** Показывать сообщения пользователя (иначе — только ответы модели) */
  showUserMsgs: boolean;
  /** Весь ход агента — одной карточкой (мысли + команды + результаты + текст) */
  groupTurns: boolean;
  /** Призрачный логотип на фоне ленты чата */
  chatMark: boolean;
  /** Эффект стекла на карточках ответов ИИ */
  msgGlass: boolean;
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
const SUGGESTIONS = (lang: "ru" | "en" | "zh" | "ja") =>  lang === "ru"
    ? [
        {
          title: "Объясни просто",
          hint: "Объяснит сложную тему простыми словами и с примерами",
          prompt: "Объясни просто: ",
        },
        {
          title: "Придумай идеи",
          hint: "Предложит варианты и идеи под любую твою задачу",
          prompt: "Придумай идеи: ",
        },
        {
          title: "Помощь с кодом",
          hint: "Напишет код, найдёт баг и подскажет, как исправить",
          prompt: "Помощь с кодом: ",
        },
        {
          title: "Наведи порядок",
          hint: "Составит план рефакторинга или разберёт твою задачу по шагам",
          prompt: "Наведи порядок: ",
        },
      ]
    : [
        {
          title: "Explain simply",
          hint: "Explains complex topics in plain words with examples",
          prompt: "Explain simply: ",
        },
        {
          title: "Brainstorm",
          hint: "Offers options and ideas for any task you have",
          prompt: "Brainstorm: ",
        },
        {
          title: "Code help",
          hint: "Writes code, finds bugs and suggests fixes",
          prompt: "Code help: ",
        },
        {
          title: "Clean it up",
          hint: "Drafts a refactoring plan or breaks your task into steps",
          prompt: "Clean it up: ",
        },
      ];

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
  pendingConfirm,
  promptPresets,
  customPresets,
  onSend,
  onClearChat,
  queued,
  onQueue,
  onQueuedRemove,
  onCorrect,
  onStop,
  onOpenSettings,
  onSetSystemPrompt,
  onApplyPreset,
  onToggleAgent,
  onConfirmDecision,
  pendingAsk,
  onAskAnswer,
  onUndoWrite,
  onEditMessage,
  subRuns,
  plan,
  userCommands,
  extraSkills,
  terminalOpen,
  onToggleTerminal,
  projectRoot,
  termShell,
  hideStarter,
  onToggleStarter,
  terminalHeightPct,
  onTerminalResizeStart,
  scrollFollow,
  streamSmooth,
  showReasoning,
  streamCaret,
  showUserMsgs,
  groupTurns,
  chatMark,
  msgGlass,
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
    (a: Attachment) => setPendingImages((prev) => [...prev, a]),
    [],
  );
  // onEditMessage из App нестабилен (замыкает handleSend/activeId) —
  // держим в ref, чтобы колбэк для UserCard не менялся никогда
  const onEditMessageRef = useRef(onEditMessage);
  onEditMessageRef.current = onEditMessage;
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
  }, [sessionKey]);
  const [permOpen, setPermOpen] = useState(false);
  const slashActive = draft.startsWith("/");
  /** «&» — палитра скилов (src/skills.ts) */
  const skillActive = draft.startsWith("&");
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
    const reader = new FileReader();
    reader.onload = () => {
      setPendingImages((prev) => [
        ...prev,
        { name: f.name || "image.png", dataUrl: String(reader.result) },
      ]);
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

  const messages = session?.messages ?? [];
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

  // ── Производные данные ленты ──
  // IIFE рендера исполняется на каждый рендер; без кэша он пересоздавал
  // merged/results/writes (JSON.parse больших before/after) и ломал memo
  // карточек новыми ссылками. Сообщения иммутабельны — производные хода
  // валидны, пока ссылки его сообщений не изменились.
  interface TurnDerived {
    assistants: Message[];
    toolMsgs: Message[];
    merged: Message | null;
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
      else turns[turns.length - 1].items.push(m);
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
      // merged: весь ход одной карточкой (режим groupTurns)
      let merged: Message | null = null;
      if (assistants.length > 0) {
        const first = assistants[0];
        const contents = assistants.map((a) => a.content).filter(Boolean);
        const thoughts = assistants.map((a) => a.thought ?? "").filter(Boolean);
        const calls = assistants.flatMap((a) => a.toolCalls ?? []);
        const lastUsage = [...assistants].reverse().find((a) => a.usage)?.usage;
        const workedMs = assistants.reduce(
          (acc, a) => acc + (a.workedMs ?? 0),
          0,
        );
        merged = {
          id: first.id,
          role: "assistant",
          content: contents.join("\n\n"),
          thought: thoughts.length ? thoughts.join("\n\n") : undefined,
          toolCalls: calls.length ? calls : undefined,
          usage: lastUsage,
          workedMs: workedMs > 0 ? workedMs : undefined,
          model: [...assistants].reverse().find((a) => a.model)?.model,
          error: assistants.find((a) => a.error)?.error,
        };
      }
      const derived: TurnDerived = {
        assistants,
        toolMsgs,
        merged,
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

  // Контекст окна: prompt последнего ответа ≈ текущее заполнение
  const contextUsed = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].usage?.prompt) return messages[i].usage!.prompt;
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
    const rows: { label: string; tokens: number; color: string }[] = [
      {
        label: "ctx.messages",
        tokens: Math.max(msgs - contextEstimate.prompt - (toolsTokens?.sys ?? 0) - (toolsTokens?.mcp ?? 0), 0),
        color: "#4c8dd9",
      },
      {
        label: "ctx.sysTools",
        tokens: toolsTokens?.sys ?? 0,
        color: "#4c8dd9",
      },
      {
        label: "ctx.mcpTools",
        tokens: toolsTokens?.mcp ?? 0,
        color: "#4c8dd9",
      },
      {
        label: "ctx.sysPrompt",
        tokens: contextEstimate.prompt,
        color: "#4c8dd9",
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
  // 05–11:59 утро · 12–17:59 день · 18–22:59 вечер · 23–04:59 ночь
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(iv);
  }, []);
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
  const greeting =
    appearance.customGreeting && appearance.customGreeting.trim().length > 0
      ? appearance.customGreeting
      : t(greetingKey as never);

  // ---------- Follow-up по выделенному фрагменту (цитата) ----------
  // Всплывающая кнопка у выделения; выбранная цитата живёт до отправки
  const [selBtn, setSelBtn] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [quoteDraft, setQuoteDraft] = useState<string | null>(null);
  const feedWrapRef = useRef<HTMLDivElement>(null);

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
    scrollRef.current?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
      scrollRef.current?.removeEventListener("scroll", onScroll);
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
  // если пользователь отлистал вверх, и возобновляется у нижнего края (±150px)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (scrollFollow || nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, typing, scrollFollow]);

  const autoGrow = (el: HTMLTextAreaElement) => {
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
        setDraft(`&${skillMatches[skillIndex].id} `);
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

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col bg-halo-bg">
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
        {/* Суммарные токены задачи (M5.3) */}
        {totals.all > 0 && (
          <span
            title={`${t("tokens.up")}: ${totals.up.toLocaleString("ru-RU")} · ${t("tokens.down")}: ${totals.down.toLocaleString("ru-RU")} · ${t("tokens.total")}: ${totals.all.toLocaleString("ru-RU")}`}
            className="mr-2 shrink-0 text-[10px] text-halo-muted/70"
          >
            <span className="text-halo-muted">↑{fmtK(totals.up)}</span>{" "}
            <span className="text-halo-muted">↓{fmtK(totals.down)}</span>{" "}
            <span className="font-medium text-halo-accent/80">
              Σ{fmtK(totals.all)}
            </span>
          </span>
        )}
        <button
          onClick={() => setSysOpen(true)}
          disabled={!session}
          title={hasSystemPrompt ? t("sysprompt.title") : t("sysprompt.title")}
          className={`mr-1 rounded-md p-1.5 transition-all duration-150 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40 ${
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
          className="mr-1 rounded-md p-1.5 text-halo-muted transition-all duration-150 hover:bg-halo-hover hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-halo-muted"
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

              {/* Быстрые роли: встроенные + пользовательские отдельными группами */}
              {!hideStarter && promptPresets.length > 0 && (
                <div className="w-full">
                  <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-wider text-halo-muted/60">
                    {t("chat.quickRoles")} — {t("chat.quickRolesSub")}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {promptPresets.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onApplyPreset(p.text)}
                        title={p.text}
                        className="rounded-full border border-halo-line bg-halo-surface/60 px-3.5 py-1.5 text-xs text-halo-muted transition-all duration-150 hover:border-halo-accent/50 hover:bg-halo-surface hover:text-halo-text"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-center text-[10px] text-halo-muted/60">
                    {t("chat.quickRolesNote")}
                  </p>
                </div>
              )}
              {!hideStarter && customPresets.length > 0 && (
                <div className="mt-4 w-full">
                  <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-wider text-halo-muted/60">
                    {t("chat.yourPrompts")}
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {customPresets.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onApplyPreset(p.text)}
                        title={p.text}
                        className="rounded-full border border-halo-accent/40 bg-halo-accent/10 px-3.5 py-1.5 text-xs text-halo-accent transition-all duration-150 hover:border-halo-accent hover:bg-halo-accent/20"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Идеи: компактные чипы под ролями (клик — заготовка в поле ввода) */}
              {!hideStarter && (
                <div className="mt-6 flex w-full flex-wrap justify-center gap-2">
                  {SUGGESTIONS(lang).map((s) => (
                    <button
                      key={s.title}
                      onClick={() => {
                        // Вставляем заголовок-заготовку в поле ввода —
                        // пользователь сам дописывает конечный вопрос
                        setDraft(s.prompt);
                        if (textareaRef.current) {
                          autoGrow(textareaRef.current);
                          textareaRef.current.focus();
                        }
                      }}
                      title={s.hint}
                      className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition-all duration-150 hover:border-halo-accent/50 hover:bg-halo-surface hover:text-halo-text"
                    >
                      {s.title}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={onToggleStarter}
                className="mt-7 rounded-md px-2 py-1 text-[11px] text-halo-muted/60 transition-colors hover:text-halo-muted"
              >
                {hideStarter ? t("chat.showStarter") : t("chat.hideStarter")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-8">
            {/* Ход = сообщение пользователя + всё, что агент сделал до следующего.
                groupTurns: весь ход в ОДНОЙ карточке; иначе каждый шаг отдельно.
                В конце хода — сводка изменённых файлов */}
            <ErrorBoundary title={t("err.boundary")} action={t("err.boundaryRetry")}>
            {(() => {
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
              if (visibleFrom > 0) {
                nodes.push(
                  <button
                    key="show-old-turns"
                    onClick={() => setShowOldTurns(true)}
                    className="mx-auto my-1 rounded-full border border-halo-line px-3 py-1 text-[11px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
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
                  // —— Весь ход одной карточкой ——
                  if (assistants.length > 0 && derived.merged) {
                    const merged = derived.merged;
                    const emptyMerged =
                      !merged.content &&
                      !merged.thought &&
                      !merged.toolCalls &&
                      !merged.error;
                    if (!emptyMerged) {
                      if (ti === turns.length - 1) lastTurnMerged = true;
                      nodes.push(
                        <AssistantCard
                          key={`merged-${merged.id}`}
                          mid={merged.id}
                          message={merged}
                          model={merged.model ?? model}
                          results={derived.results}
                          hint={ti === turns.length - 1 ? activity : null}
                          glassEffect={msgGlass}
                          isStreaming={merged.id === streamingMsgId}
                          smooth={streamSmooth}
                          showReasoning={showReasoning}
                          caret={streamCaret}
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
                            isStreaming={m.id === streamingMsgId}
                            smooth={streamSmooth}
                            showReasoning={showReasoning}
                            caret={streamCaret}
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
            })()}
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

      {/* Терминальный режим: панель снизу, подтверждения [y/n/a] прямо в ней */}
      {terminalOpen && (
        <TerminalPanel
          key={session?.id ?? "none"}
          session={session}
          streamingMsgId={streamingMsgId}
          pendingConfirm={pendingConfirm}
          projectRoot={projectRoot}
          termShell={termShell}
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
          <div className="glass-pane relative z-30 rounded-2xl border border-halo-line bg-halo-surface p-2.5 shadow-sm transition-all duration-200 focus-within:border-halo-accent/60 focus-within:shadow-[0_0_0_3px_rgba(217,119,87,0.10)]">
            {/* Палитра скилов (&) */}
            {skillActive && skillMatches.length > 0 && (
              <div className="scroll-slim absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-halo-line bg-halo-deep/95 p-1.5 shadow-xl backdrop-blur">
                <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-halo-muted/60">
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
                    <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-halo-muted/60">
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
                <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-halo-muted/70">
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
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
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
                className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-xl text-halo-muted transition-all duration-150 hover:bg-halo-hover hover:text-halo-text"
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
                className="max-h-44 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-halo-text outline-none placeholder:text-halo-muted"
              />
              {streamingMsgId ? (
                <>
                  {/* Поправка агенту на ходу: рядом со Stop, пока есть черновик */}
                  {agentMode && draft.trim() && (
                    <button
                      onClick={submit}
                      title={t("composer.correct")}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-halo-line text-halo-text transition-all duration-150 hover:border-halo-accent/60 hover:text-halo-accent active:scale-95"
                    >
                      <CorrectIcon />
                    </button>
                  )}
                  <button
                    onClick={onStop}
                    title={t("composer.stop")}
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-halo-line text-halo-text transition-all duration-150 hover:border-red-400/60 hover:text-red-400 active:scale-95"
                  >
                    <StopIcon />
                  </button>
                </>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim() && pendingImages.length === 0}
                  title={t("composer.send")}
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-halo-accent text-halo-on-accent shadow-sm transition-all duration-150 hover:bg-halo-accent-deep active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUpIcon />
                </button>
              )}
            </div>

            {/* Предупреждение: модель не принимает изображения */}
            {pendingImages.length > 0 && visionCapable === false && (
              <div className="anim-fade-up mx-2 mb-1 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
                <span className="mt-0.5">⚠</span>
                <span>{t("error.vision")}</span>
              </div>
            )}

            {/* Превью прикреплённых изображений */}
            {pendingImages.length > 0 && (
              <div className="anim-fade-up flex flex-wrap gap-2 px-2 pt-1.5">
                {pendingImages.map((img, i) => (
                  <div key={`${img.name}-${i}`} className="group relative">
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="h-16 w-16 rounded-lg border border-halo-line object-cover"
                    />
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

            {/* Нижняя панель в духе ZCode: модель слева, подсказка справа */}
            <div className="mt-1 flex items-center gap-2 px-1">
              <button
                onClick={onToggleAgent}
                disabled={!session}
                title={t("agent.toggle")}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  agentMode
                    ? "bg-halo-accent/15 text-halo-accent"
                    : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                }`}
              >
                <WrenchIcon />
                {t("agent.toggle")}
              </button>
              <button
                onClick={onToggleTerminal}
                disabled={!session}
                title={t("terminal.toggle")}
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  terminalOpen
                    ? "bg-halo-accent/15 text-halo-accent"
                    : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                }`}
              >
                <TerminalIcon />
                {t("terminal.toggle")}
              </button>
              {/* Режим разрешений агента (plan / ask / edit / full) */}
              <div className="relative">
                <button
                  onClick={() => setPermOpen((v) => !v)}
                  disabled={!session}
                  title={t("perms.title")}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                    permissionMode !== "ask"
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
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
                      <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-halo-muted/60">
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
                            <span className="block text-[11px] leading-snug text-halo-muted">
                              {t(`perms.${m}Desc`)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={onOpenSettings}
                title={model ? model : t("chat.modelHint")}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-halo-muted transition-all duration-150 hover:bg-halo-hover hover:text-halo-text"
              >
                <ProviderIcon modelId={model} size={13} />
                <span className="max-w-28 truncate font-medium">
                  {model ? brandName(model) : t("chat.modelNotSet")}
                </span>
                {isLocal && (
                  <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                    local
                  </span>
                )}
                <ChevronDownIcon />
              </button>
              <span className="flex-1" />
              <ContextRing
                used={contextUsed || contextEstimate.msgs + contextEstimate.prompt}
                limit={contextLimit}
                rows={contextRows}
                isEstimate={!contextUsed}
              />
              {/* Монитор субагентов: только когда прогоны были/идут */}
              {Object.keys(subRuns ?? {}).length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setSubOpen((v) => !v)}
                    title={t("sub.monitor")}
                    className={`relative flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-all duration-150 ${
                      subOpen ||
                      Object.values(subRuns ?? {}).some((r) => r.report === null)
                        ? "bg-halo-accent/15 text-halo-accent"
                        : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                    }`}
                  >
                    <RobotIcon />
                    <span className="text-[10px] tabular-nums">
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
                        <p className="px-2 pb-1 text-[10px] uppercase tracking-wider text-halo-muted/60">
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
                                <p className="truncate text-[11px] text-halo-muted/70">
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
              <div className="relative">
                <button
                  onClick={() => setQuickOpen((v) => !v)}
                  title={t("qs.title")}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-all duration-150 ${
                    quickOpen
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
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
    </section>
  );
}

