import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type {
  Attachment,
  ChangedFile,
  Message,
  PermissionMode,
  PlanTask,
  Session,
  ToolCallInfo,
} from "../types";
import type { PromptPreset } from "../presets";
import {
  diffLines,
  diffStats,
  normalizePath,
  parseWriteResult,
  summarizeArguments,
  type DiffLine,
} from "../diff";
import type { SlashCommand } from "../commands";
import QuickSettings from "./QuickSettings";
import NocturnMark from "./NocturnMark";
import type { Appearance } from "../appearance";
import { getToolSchemas, contextLimitFor, type ModelInfo } from "../api";
import type { Theme } from "../types";
import SystemPromptModal from "./SystemPromptModal";
import TerminalPanel from "./TerminalPanel";
import WindowControls from "./WindowControls";
import ProviderIcon, { brandName, shortModelName } from "./ProviderIcon";
import { useLang, thinkingPhases } from "../locales";
import { dayPeriod } from "../time";
import { BUILTIN_SKILLS, type Skill } from "../skills";
import type { SubRunState } from "../subagents";
import type { UserCommand } from "../api";
import { BUILTIN_COMMANDS } from "../commands";

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
  /** Стартовые подсказки скрыты (эргономика) */
  hideStarter: boolean;
  onToggleStarter: () => void;
  /** Высота терминальной панели, % и drag-хендл */
  terminalHeightPct: number;
  onTerminalResizeStart: () => void;
  /** Поведение генерации: принудительный автоскролл, плавная печать, каретка */
  scrollFollow: boolean;
  streamSmooth: boolean;
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
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  const v = (n / 1000).toFixed(1).replace(".", ",");
  return `${v.replace(",0", "")}k`;
}

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
  onUndoWrite,
  onEditMessage,
  subRuns,
  plan,
  userCommands,
  extraSkills,
  terminalOpen,
  onToggleTerminal,
  projectRoot,
  hideStarter,
  onToggleStarter,
  terminalHeightPct,
  onTerminalResizeStart,
  scrollFollow,
  streamSmooth,
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
  const visible = messages.filter(
    (m) =>
      !(m.role === "user" && !showUserMsgs) &&
      !(
        m.role === "assistant" &&
        m.content === "" &&
        !m.thought &&
        !m.toolCalls &&
        !m.error
      ),
  );

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
            {(() => {
              const nodes: ReactNode[] = [];
              // Разбивка на ходы
              const turns: { user: Message | null; items: Message[] }[] = [];
              for (const m of messages) {
                if (m.role === "user") turns.push({ user: m, items: [] });
                else if (turns.length === 0)
                  turns.push({ user: null, items: [m] });
                else turns[turns.length - 1].items.push(m);
              }
              const isHidden = (m: Message) =>
                (m.role === "user" && !showUserMsgs) ||
                (m.role === "assistant" &&
                  m.content === "" &&
                  !m.thought &&
                  !m.toolCalls &&
                  !m.error);
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
                // Файлы, записанные агентом в этом ходе
                const writes = new Map<string, ChangedFile>();
                for (const m of turn.items) {
                  if (m.role !== "tool") continue;
                  const w = parseWriteResult(m.content);
                  if (!w?.path) continue;
                  const prev = writes.get(normalizePath(w.path));
                  writes.set(normalizePath(w.path), {
                    path: w.path,
                    created: prev?.created ?? w.created,
                    before: prev?.before ?? w.before,
                    after: w.after,
                  });
                }

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
                      onEdit={
                        onEditMessage
                          ? (text) => onEditMessage(turnUser.id, text)
                          : undefined
                      }
                      onReuseAttachment={(a) =>
                        setPendingImages((prev) => [...prev, a])
                      }
                    />,
                  );
                }

                const assistants = turn.items.filter(
                  (m) => m.role === "assistant",
                );
                const toolMsgs = turn.items.filter((m) => m.role === "tool");

                if (groupTurns) {
                  // —— Весь ход одной карточкой ——
                  if (assistants.length > 0) {
                    const first = assistants[0];
                    const contents = assistants
                      .map((a) => a.content)
                      .filter(Boolean);
                    const thoughts = assistants
                      .map((a) => a.thought ?? "")
                      .filter(Boolean);
                    const calls = assistants.flatMap((a) => a.toolCalls ?? []);
                    const lastUsage = [...assistants]
                      .reverse()
                      .find((a) => a.usage)?.usage;
                    const workedMs = assistants.reduce(
                      (acc, a) => acc + (a.workedMs ?? 0),
                      0,
                    );
                    const merged: Message = {
                      id: first.id,
                      role: "assistant",
                      content: contents.join("\n\n"),
                      thought: thoughts.length
                        ? thoughts.join("\n\n")
                        : undefined,
                      toolCalls: calls.length ? calls : undefined,
                      usage: lastUsage,
                      workedMs: workedMs > 0 ? workedMs : undefined,
                      model:
                        [...assistants].reverse().find((a) => a.model)?.model,
                      error: assistants.find((a) => a.error)?.error,
                    };
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
                          results={toolMsgs.map((m) => ({
                            id: m.id,
                            content: m.content,
                          }))}
                          hint={ti === turns.length - 1 ? activity : null}
                          glassEffect={msgGlass}
                          isStreaming={merged.id === streamingMsgId}
                          smooth={streamSmooth}
                          caret={streamCaret}
                        />,
                      );
                    }
                  }
                } else {
                  // —— Каждый шаг отдельно: результаты при своей карточке ——
                  const ownerOf = new Map<string, string>();
                  for (const a of assistants) {
                    for (const tc of a.toolCalls ?? [])
                      ownerOf.set(tc.id, a.id);
                  }
                  const resultsOf = new Map<
                    string,
                    { id: string; content: string }[]
                  >();
                  for (const m of toolMsgs) {
                    if (!m.toolCallId) continue;
                    const owner = ownerOf.get(m.toolCallId);
                    if (!owner) continue;
                    const arr = resultsOf.get(owner) ?? [];
                    arr.push({ id: m.id, content: m.content });
                    resultsOf.set(owner, arr);
                  }
                  for (const m of turn.items) {
                    if (isHidden(m)) continue;
                    nodes.push(
                      m.role === "tool" ? (
                        m.toolName === "subagent_run" ? (
                          // Субагент: своя карточка вместо серой tool-строки
                          <SubagentCard
                            key={m.id}
                            mid={m.id}
                            call={messages
                              .flatMap((x) => x.toolCalls ?? [])
                              .find((tc) => tc.id === m.toolCallId)}
                            content={m.content}
                            run={subRuns?.[m.toolCallId ?? ""]}
                          />
                        ) : (
                        // Инструмент без владельца (старые сессии) — standalone
                        <ToolStepCard
                          key={m.id}
                          mid={m.id}
                          call={messages
                            .flatMap((x) => x.toolCalls ?? [])
                            .find((tc) => tc.id === m.toolCallId)}
                          content={m.content}
                        />
                        )
                      ) : m.role === "assistant" ? (
                        <AssistantCard
                          key={m.id}
                          mid={m.id}
                          message={m}
                          model={m.model ?? model}
                          results={resultsOf.get(m.id)}
                          glassEffect={msgGlass}
                          isStreaming={m.id === streamingMsgId}
                          smooth={streamSmooth}
                          caret={streamCaret}
                        />
                      ) : null,
                    );
                  }
                }

                // Сводка изменённых файлов — в конце хода
                if (writes.size > 0) {
                  nodes.push(
                    <ChangedFilesCard
                      key={`changes-${turn.user?.id ?? ti}`}
                      files={[...writes.values()]}
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
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-halo-accent text-white shadow-sm transition-all duration-150 hover:bg-halo-accent-deep active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
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

function UserCard({
  mid,
  content,
  attachments,
  quote,
  correction,
  glassEffect,
  onEdit,
  onReuseAttachment,
}: {
  mid: string;
  content: string;
  attachments?: Attachment[];
  quote?: string;
  /** Поправка агенту на ходу: мягкая amber-подсветка слева */
  correction?: boolean;
  glassEffect?: boolean;
  /** Карандаш: сохранить → переспросить с места правки */
  onEdit?: (newText: string) => void;
  /** Вернуть изображение из сообщения в композер (pendingImages) */
  onReuseAttachment: (a: Attachment) => void;
}) {
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const preview =
    content.replace(/\s+/g, " ").slice(0, 70) ||
    (attachments?.length
      ? `${t("card.imageOf")}: ${attachments[0].name}`
      : "");

  if (collapsed) {
    return (
      <button
        data-mid={mid}
        onClick={() => setCollapsed(false)}
        title={t("card.expand")}
        className="anim-fade-up ml-auto flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-halo-line/70 bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition-all duration-150 hover:border-halo-line hover:text-halo-text"
      >
        <PlusIcon />
        <span className="truncate">{preview}</span>
      </button>
    );
  }

  return (
    <div
      data-mid={mid}
      className={`anim-fade-up group relative ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md px-4 py-3 shadow-sm ${
        correction ? "border-l-2 border-amber-400/50 " : ""
      }${glassEffect ? "glass-pane bg-halo-surface/40" : "bg-halo-raised"}`}
    >
      <CollapseButton onClick={() => setCollapsed(true)} />
      {/* Карандаш: редактирование отправленного сообщения */}
      {!editing && onEdit && (
        <button
          onClick={() => {
            setDraft(content);
            setEditing(true);
          }}
          title={t("card.edit")}
          className="absolute -left-7 top-2 rounded-md p-1 text-halo-muted opacity-0 transition-all hover:bg-halo-hover hover:text-halo-text group-hover:opacity-100"
        >
          ✎
        </button>
      )}
      {editing ? (
        <div className="w-72 sm:w-96">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = draft.trim();
                if (!text) return;
                setEditing(false);
                onEdit?.(text);
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            rows={Math.min(10, draft.split("\n").length + 1)}
            className="scroll-slim w-full resize-none rounded-lg border border-halo-accent/50 bg-halo-deep/60 px-2.5 py-2 text-sm leading-relaxed text-halo-text outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-halo-muted/60">
              Enter — {t("card.editSend")} · Esc — {t("card.editCancel")}
            </span>
            <div className="flex gap-1.5">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-halo-line px-2 py-1 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("card.editCancel")}
              </button>
              <button
                onClick={() => {
                  const text = draft.trim();
                  if (!text) return;
                  setEditing(false);
                  onEdit?.(text);
                }}
                className="rounded-md bg-halo-accent px-2.5 py-1 text-[10px] font-medium text-white transition-colors hover:bg-halo-accent-deep"
              >
                {t("card.editSend")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Цитата-реплай: фрагмент, по которому задан вопрос */}
      {quote && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-halo-accent bg-halo-deep/50 px-2.5 py-1.5">
          <span className="mt-0.5 shrink-0 text-halo-accent"><QuoteIcon /></span>
          <p className="line-clamp-3 min-w-0 text-[11px] leading-relaxed text-halo-muted">
            {quote}
          </p>
        </div>
      )}
      {attachments && attachments.length > 0 && (
        <div
          className={`flex flex-wrap gap-2 ${content ? "mb-2" : ""}`}
        >
          {attachments.map((a) => (
            <div key={a.dataUrl} className="group/img relative">
              <img
                src={a.dataUrl}
                alt={a.name}
                className="max-h-44 rounded-lg border border-halo-line/60 object-cover"
              />
              {/* Вернуть изображение в композер: оверлей при наведении,
                  клик не стартует выделение (см. data-reuse-img-btn выше) */}
              <button
                data-reuse-img-btn
                onClick={(e) => {
                  e.stopPropagation();
                  onReuseAttachment(a);
                }}
                title={t("chat.reuseImage")}
                className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md border border-halo-line bg-halo-surface text-halo-muted opacity-0 shadow-sm transition-all hover:text-halo-text group-hover/img:opacity-100"
              >
                <ReuseImgIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {content && (
        <p className="break-words whitespace-pre-wrap text-sm leading-relaxed text-halo-text">
          {content}
        </p>
      )}
        </>
      )}
    </div>
  );
}

function AssistantCard({
  mid,
  message,
  model,
  results,
  hint,
  glassEffect,
  isStreaming,
  smooth,
  caret,
}: {
  mid: string;
  message: Message;
  model: string;
  /** Результаты инструментов этого шага — рендерятся внутри карточки */
  results?: { id: string; content: string }[];
  /** Живой статус стрима этого хода («Размышляет…») — внутри карточки */
  hint?: string | null;
  /** Эффект стекла на карточке (тумблер в «Темах») */
  glassEffect?: boolean;
  isStreaming: boolean;
  smooth: boolean;
  caret: boolean;
}) {
  // Плавная печать: показанный текст отстаёт от реального и догоняет
  // его rAF-циклом с ускорением (чем больше отставание, тем быстрее),
  // поэтому поток выглядит непрерывным, а не рваными пачками
  const [shownLen, setShownLen] = useState(
    isStreaming ? 0 : message.content.length,
  );
  useEffect(() => {
    const target = message.content.length;
    if (!isStreaming || !smooth) {
      setShownLen(target);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) {
        // ~30 кадров в секунду достаточно для плавности
        last = now;
        setShownLen((prev) => {
          const backlog = target - prev;
          if (backlog <= 0) return prev;
          return prev + Math.max(2, Math.ceil(backlog / 6));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, smooth, message.content.length]);

  const displayContent =
    smooth && isStreaming
      ? message.content.slice(0, shownLen)
      : message.content;
  const { lang, t } = useLang();
  const [openThought, setOpenThought] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phases = thinkingPhases(lang);

  // Цикл фаз активности, пока модель стримит
  useEffect(() => {
    if (!isStreaming) return;
    const t = window.setInterval(
      () => setPhaseIdx((p) => (p + 1) % phases.length),
      2500,
    );
    return () => window.clearInterval(t);
  }, [isStreaming, phases.length]);

  const preview =
    message.content.replace(/[#*`>\n]+/g, " ").trim().slice(0, 70) ||
    (message.thought ? t("card.thinking") : t("card.answer"));

  if (collapsed) {
    return (
      <button
        data-mid={mid}
        onClick={() => setCollapsed(false)}
        title={t("card.expand")}
        className="anim-fade-up mr-auto flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-halo-line/70 bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition-all duration-150 hover:border-halo-line hover:text-halo-text"
      >
        <PlusIcon />
        <span className="truncate">{preview}</span>
      </button>
    );
  }

  return (
    <div
      data-mid={mid}
      className={`anim-fade-up group relative mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line/70 px-4 py-3 shadow-sm ${
        glassEffect ? "glass-pane bg-halo-surface/40" : "bg-halo-surface/70"
      }`}
    >
      <CollapseButton onClick={() => setCollapsed(true)} />

      <div className="mb-1 flex items-center gap-2.5 pr-6">
        <span className="flex items-center gap-1.5">
          <ProviderIcon modelId={model} size={16} />
          <span className="max-w-44 truncate text-[11px] font-semibold text-halo-text/90">
            {shortModelName(model)}
          </span>
        </span>
        {message.workedMs != null && (
          <span className="text-[11px] text-halo-muted/70">
            Worked for {(message.workedMs / 1000).toFixed(1).replace(".", ",")}{" "}
            {t("chat.workedUnit")}
          </span>
        )}
        {isStreaming && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-halo-accent/90">
            <span className="typing-dot size-1 rounded-full bg-halo-accent" />
            {phases[phaseIdx]}…
          </span>
        )}
      </div>

      {/* Живой статус хода: агенты думают/исполняют инструменты — показываем внутри */}
      {hint && !isStreaming && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-halo-muted">
          <span className="typing-dot size-1 rounded-full bg-halo-accent" />
          {hint}
        </div>
      )}

      {message.thought && (
        <div className="mb-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpenThought((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-halo-muted transition-colors hover:text-halo-text"
            >
              <ChevronDownIcon
                className={openThought ? "" : "-rotate-90"}
              />
              Thought
            </button>
            {isStreaming && (
              <span className="flex items-center gap-1 text-[10px] text-halo-muted/70">
                <span className="typing-dot size-1 rounded-full bg-halo-muted" />
                {phases[phaseIdx]}
              </span>
            )}
          </div>
          {openThought && (
            <div className="anim-fade-up mt-1.5 whitespace-pre-wrap rounded-lg border border-halo-line/60 bg-halo-raised/40 px-3 py-2 text-xs italic leading-relaxed text-halo-muted">
              {message.thought}
            </div>
          )}
        </div>
      )}

      {message.toolCalls?.map((tc) => (
        <div
          key={tc.id}
          className="mb-1 flex w-fit items-center gap-1.5 rounded-md border border-sky-400/25 bg-sky-400/5 px-2 py-1"
        >
          <span className="text-sky-400">
            {tc.name === "subagent_run" ? <SubagentIcon /> : <ToolIcon />}
          </span>
          <span className="font-mono text-[11px] text-halo-text">
            {tc.name}
          </span>
          <span className="max-w-64 truncate font-mono text-[10px] text-halo-muted">
            {summarizeArguments(tc.name, tc.arguments)}
          </span>
        </div>
      ))}

      {/* Результаты инструментов этого шага — внутри ответа, отдельными
          сворачиваемыми карточками (при клике по заголовку раскрываются) */}
      {results?.map((r) => (
        <ToolStepCard
          key={r.id}
          mid={r.id}
          call={message.toolCalls?.find((tc) => tc.id === r.id)}
          content={r.content}
        />
      ))}

      <div className="markdown text-sm leading-relaxed text-halo-text">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {displayContent}
        </ReactMarkdown>
        {caret && isStreaming && (
          <span className="animate-pulse align-baseline text-halo-accent">▍</span>
        )}
      </div>

      {message.error && (
        <ErrorNote title={message.error.title} raw={message.error.raw} />
      )}

      {message.usage && (
        <div className="mt-2 flex items-center gap-3 border-t border-halo-line/50 pt-2 text-[10px] text-halo-muted/70">
          <span title={t("tokens.up")}>
            ↑ {message.usage.prompt.toLocaleString("ru-RU")}
          </span>
          <span title={t("tokens.down")}>
            ↓ {message.usage.completion.toLocaleString("ru-RU")}
          </span>
          <span title={t("tokens.total")}>
            Σ {message.usage.total.toLocaleString("ru-RU")}
          </span>
        </div>
      )}

      {/* Дисклеймер: ответ сгенерирован моделью */}
      {message.role === "assistant" && message.content.trim() !== "" && (
        <p className="mt-1.5 text-[10px] italic text-halo-muted/50">
          {t("chat.aiDisclaimer")}
        </p>
      )}
    </div>
  );
}

/** Ошибка запроса: короткий человекочитаемый заголовок, сырое тело — по клику */
function ErrorNote({ title, raw }: { title: string; raw: string }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 w-full rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="shrink-0 text-amber-400">⚠</span>
        <span className="flex-1 text-xs leading-relaxed text-halo-text">
          {title}
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 text-[10px] text-halo-muted transition-colors hover:text-halo-text`}
        >
          {t("err.details")}
          <ChevronDownIcon className={open ? "" : "-rotate-90"} />
        </span>
      </button>
      {open && (
        <pre className="scroll-slim mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-red-400/20 pt-2 font-mono text-[10px] leading-relaxed text-halo-muted">
          {raw}
        </pre>
      )}
    </div>
  );
}

/** Виджет Progress: план задач агента в левом верхнем углу чата.
    Наполняется инструментом plan_update (исполнение — на фронтенде в App):
    строки с иконкой статуса и счётчик done/total в заголовке */
function PlanPanel({ plan }: { plan: PlanTask[] }) {
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(false);
  const done = plan.filter((p) => p.status === "done").length;

  return (
    <div className="anim-fade-up absolute left-0 top-0 z-20 m-3 max-w-xs rounded-xl border border-halo-line bg-halo-deep/85 p-3 shadow-lg backdrop-blur">
      {/* Заголовок-строка: сворачивание, «Прогресс», счётчик done/total */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? t("card.expand") : t("card.collapse")}
          className="rounded-md p-0.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <ChevronDownIcon className={collapsed ? "-rotate-90" : ""} />
        </button>
        <span className="text-[12px] font-medium text-halo-text">
          {t("plan.progress")}
        </span>
        <span className="ml-auto rounded-full bg-halo-surface/70 px-1.5 py-0.5 font-mono text-[10px] text-halo-muted">
          {done}/{plan.length}
        </span>
      </div>
      {/* Свёрнуто — только заголовок-строка */}
      {!collapsed && (
        <ul className="scroll-slim mt-2 max-h-[40vh] space-y-1.5 overflow-y-auto">
          {plan.map((task, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {/* Иконка статуса: галочка / пульсирующее кольцо / серый кружок */}
              <span className="mt-[3px] shrink-0">
                {task.status === "done" ? (
                  <span className="block text-halo-accent">
                    <CheckIcon />
                  </span>
                ) : task.status === "in_progress" ? (
                  <span className="block size-2.5 animate-pulse rounded-full border-[1.5px] border-halo-accent" />
                ) : (
                  <span className="block size-2.5 rounded-full border-[1.5px] border-halo-muted/50" />
                )}
              </span>
              <span
                className={`text-[12px] leading-snug ${
                  task.status === "done"
                    ? "text-halo-muted line-through"
                    : "text-halo-text"
                }`}
              >
                {task.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Кнопка «−» в углу карточки: видна при наведении, сворачивает сообщение */
function CollapseButton({ onClick }: { onClick: () => void }) {
  const { t } = useLang();
  return (
    <button
      onClick={onClick}
      title={t("card.collapse")}
      className="absolute -top-2 right-2 flex size-5 items-center justify-center rounded-full border border-halo-line bg-halo-deep text-halo-muted opacity-0 shadow-sm transition-all duration-150 hover:text-halo-text group-hover:opacity-100"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M5 12h14" />
      </svg>
    </button>
  );
}

/** Боковая линейка: чёрточка на каждое сообщение, клик — прыжок к нему */
function MessageNav({
  messages,
  model,
  scrollRef,
}: {
  messages: Message[];
  model: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLang();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Отмечаем «текущее» сообщение при прокрутке
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nodes = el.querySelectorAll<HTMLElement>("[data-mid]");
      if (nodes.length === 0) return;
      const top = el.getBoundingClientRect().top;
      let current: string | null = null;
      nodes.forEach((n) => {
        if (n.getBoundingClientRect().top - top <= 140) {
          current = n.dataset.mid ?? null;
        }
      });
      setActiveId(current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, messages.length]);

  const jump = (id: string) => {
    setActiveId(id);
    const el = scrollRef.current;
    el?.querySelector(`[data-mid="${id}"]`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  // Засечка — на запрос и ОДИН ход агента (каким бы длинным он ни был):
  // tool-шаги и промежуточные ответы не плодят отдельные «-»
  const ticks: { msg: Message; preview: string }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      ticks.push({ msg: m, preview: m.content });
      continue;
    }
    if (m.role !== "assistant") continue;
    const prev = i > 0 ? messages[i - 1] : null;
    if (prev && prev.role !== "user") continue; // не первый шаг хода
    // Превью хода: первый осмысленный текст/мысль от модели
    let preview = "";
    for (let j = i; j < messages.length; j++) {
      const x = messages[j];
      if (x.role === "user") break;
      if (x.role === "assistant" && (x.content || x.thought)) {
        preview = x.content || x.thought || "";
        break;
      }
    }
    ticks.push({ msg: m, preview });
  }
  const visibleTicks = ticks.slice(-60);

  return (
    <div className="no-scrollbar absolute right-3 top-1/2 z-10 flex max-h-[80%] -translate-y-1/2 flex-col items-end gap-2.5">
      {visibleTicks.map(({ msg: m, preview: rawPreview }, i) => {
        const isActive = m.id === activeId;
        const label =
          m.role === "user"
            ? t("card.you")
            : shortModelName(m.model ?? model);
        const preview = rawPreview.replace(/[#*`>\n]+/g, " ").trim().slice(0, 200);
        return (
          <button
            key={m.id}
            onClick={() => jump(m.id)}
            aria-label={label}
            className="nav-tick-in group pointer-events-auto relative flex h-2.5 w-6 shrink-0 items-center justify-end"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {/* Засечка */}
            <span
              className={`h-[3px] rounded-full transition-all duration-200 ${
                isActive
                  ? "w-4 bg-halo-accent"
                  : "w-3 bg-halo-muted/50 group-hover:w-4 group-hover:bg-halo-muted"
              }`}
            />
            {/* Поповер с текстом сообщения — только при наведении */}
            <span
              className="pointer-events-none absolute right-5 top-1/2 w-64 -translate-y-1/2 rounded-xl border border-halo-line bg-halo-deep/95 p-3 text-left shadow-xl opacity-0 translate-x-2 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
            >
              <span className="mb-1 flex items-center gap-1.5">
                {m.role === "user" ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-halo-muted">
                    {label}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-halo-accent/80">
                    {label}
                  </span>
                )}
              </span>
              <span className="line-clamp-4 text-xs leading-relaxed text-halo-text">
                {preview || "…"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ConfirmCard({
  call,
  onDecision,
}: {
  call: ToolCallInfo;
  onDecision: (d: "once" | "always" | "deny") => void;
}) {
  const { t } = useLang();
  return (
    <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
        {t("agent.confirmTitle")}
      </p>
      <p className="mt-1 text-xs text-halo-muted">{t("agent.confirmDesc")}</p>
      <p className="mt-1.5 font-mono text-xs text-halo-text">
        <span className="text-amber-400">{call.name}</span>
        {call.arguments}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => onDecision("once")}
          className="rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-halo-accent-deep"
        >
          {t("agent.allow")}
        </button>
        <button
          onClick={() => onDecision("always")}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
        >
          {t("agent.allowAlways")}
        </button>
        <button
          onClick={() => onDecision("deny")}
          className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-400/50 hover:bg-red-400/10"
        >
          {t("agent.deny")}
        </button>
      </div>
    </div>
  );
}

/**
 * Карточка шага агента (M4.1): свёрнута по умолчанию, в заголовке — инструмент
 * и человекочитаемая сводка. Внутри: diff «до/после» для fs_write,
 * команда + вывод для shell_run, сырой результат — для остальных.
 */
/** Карточка субагента: свёрнута — статус и счётчик шагов; в раскрытии —
    поток мыслей, вызовы инструментов и финальный отчёт */
function SubagentCard({
  mid,
  call,
  content,
  run,
}: {
  mid: string;
  call?: ToolCallInfo;
  content: string;
  run?: SubRunState;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const running = run ? run.report === null : false;
  // Из аргументов достаём бриф (task) для подзаголовка
  let task = "";
  try {
    task = call ? (JSON.parse(call.arguments).task as string ?? "") : "";
  } catch {
    task = "";
  }
  // Отчёт: живой из состояния или из tool-сообщения (после перезапуска приложения)
  const report = run?.report ?? (content ? content.replace(/^\[[^\]]+\]\n/, "") : "");
  const roleName = run?.roleName ?? (content.match(/^\[([^\]]+)\]/)?.[1] ?? "Subagent");
  const steps = (run?.tools.length ?? 0) + (run?.thought ? 1 : 0);

  return (
    <div
      data-mid={mid}
      className="anim-fade-up rounded-xl border border-halo-line bg-halo-surface/50"
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {running ? (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-halo-accent" />
        ) : (
          <span className="shrink-0 text-[11px] text-emerald-400">✓</span>
        )}
        <span className="shrink-0 text-xs font-medium text-halo-text">
          {t("card.subagent")} · {roleName}
        </span>
        {running && (
          <span className="shrink-0 text-[10px] text-halo-muted">
            {steps > 0 ? `${steps} ${t("card.subagentSteps")}` : t("card.subagentStarting")}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-halo-muted/60">
          {task}
        </span>
        <span className={`shrink-0 text-halo-muted transition-transform ${open ? "rotate-90" : ""}`}>
          ›
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-halo-line px-3 py-2.5">
          {run?.thought && (
            <pre className="scroll-slim max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-halo-muted">
              {run.thought.slice(-1200)}
            </pre>
          )}
          {run && run.tools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {run.tools.map((tool, i) => (
                <code
                  key={i}
                  className="max-w-full truncate rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[10px] text-halo-muted"
                >
                  {tool}
                </code>
              ))}
            </div>
          )}
          {report && (
            <pre className="scroll-slim max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-halo-text">
              {report}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({
  mid,
  call,
  content,
}: {
  mid: string;
  /** Вызов, к которому относится результат (старые сообщения — без него) */
  call?: ToolCallInfo;
  content: string;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const name = call?.name ?? "";

  // Статус шага: отказ пользователя, ошибка инструмента, ненулевой exit-код
  const denied = content === t("agent.denied");
  const toolError = content.startsWith("tool error:");
  let exitCode: number | null = null;
  if (name === "shell_run") {
    const m = content.match(/exit code: (-?\d+)/);
    if (m) exitCode = parseInt(m[1], 10);
  }
  const failed = denied || toolError || (exitCode !== null && exitCode !== 0);

  // fs_write: новый формат — JSON с before/after, старый — просто текст
  const write =
    name === "fs_write" && !denied && !toolError
      ? parseWriteResult(content)
      : null;
  const diff = write
    ? diffLines(write.before ?? "", write.after)
    : null;
  const stats = diff ? diffStats(diff) : null;

  const summary = call ? summarizeArguments(name, call.arguments) : "";

  // Цвет статуса: красный — неудача, зелёный — запись файла, серый — прочее
  const statusColor = failed
    ? "text-red-400"
    : write
      ? "text-emerald-400"
      : "text-halo-muted";

  const status = denied
    ? t("agent.denied")
    : toolError
      ? t("agent.errorResult")
      : exitCode !== null
        ? `exit ${exitCode}`
        : write
          ? `${t("agent.diffLinesAdded", { n: stats!.added })} · ${t("agent.diffLinesRemoved", { n: stats!.removed })}`
          : t("agent.result");

  return (
    <div
      data-mid={mid}
      className={`anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border bg-halo-surface/40 px-3 py-2 transition-colors duration-150 ${
        failed
          ? "border-red-400/40"
          : write
            ? "border-emerald-400/40"
            : "border-halo-line/60"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={statusColor}>
          <ToolIcon />
        </span>
        <span className="font-mono text-[11px] font-semibold text-halo-text">
          {name || t("agent.result")}
        </span>
        {summary && (
          <span className="max-w-72 truncate font-mono text-[10px] text-halo-muted">
            {summary}
          </span>
        )}
        <span className={`shrink-0 text-[10px] ${statusColor}`}>{status}</span>
        <ChevronDownIcon className={open ? "" : "-rotate-90"} />
      </button>

      {open && (
        <div className="anim-fade-up mt-2">
          {write && diff ? (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-[10px] text-halo-muted">
                  {write.path}
                </span>
                {write.created && (
                  <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                    {t("agent.diffCreated")}
                  </span>
                )}
                <span className="text-[10px] text-emerald-400">
                  {t("agent.diffLinesAdded", { n: stats!.added })}
                </span>
                <span className="text-[10px] text-red-400">
                  {t("agent.diffLinesRemoved", { n: stats!.removed })}
                </span>
              </div>
              <DiffView lines={diff} hasBefore={write.before !== null} />
            </>
          ) : name === "shell_run" ? (
            <div>
              <pre className="scroll-slim max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-halo-line/60 bg-halo-deep/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-text">
                {content}
              </pre>
            </div>
          ) : (
            <pre className="scroll-slim max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-halo-line/60 bg-halo-deep/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-muted">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Сводка изменённых файлов за ход (как «N files changed» в агентских CLI):
    заголовок с +X −Y, список файлов, клик — дифф, ↩ — откат к «до» */
function ChangedFilesCard({
  files,
  onUndo,
}: {
  files: ChangedFile[];
  onUndo: (f: ChangedFile) => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(new Set());

  const stats = useMemo(
    () =>
      files.map((f) => ({
        added: diffLines(f.before ?? "", f.after).filter((l) => l.type === "add")
          .length,
        removed: diffLines(f.before ?? "", f.after).filter(
          (l) => l.type === "del",
        ).length,
      })),
    [files],
  );
  const total = stats.reduce(
    (acc, s) => ({ added: acc.added + s.added, removed: acc.removed + s.removed }),
    { added: 0, removed: 0 },
  );

  const undo = (f: ChangedFile) => {
    onUndo(f);
    setUndone((prev) => new Set(prev).add(normalizePath(f.path)));
  };

  return (
    <div className="anim-fade-up mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line/70 bg-halo-surface/70 px-4 py-2.5 shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <span className="text-halo-muted">
          <ToolIcon />
        </span>
        <span className="text-xs font-medium text-halo-text">
          {t("agent.filesChanged", { n: files.length })}
        </span>
        <span className="text-[10px] font-medium text-emerald-400">
          +{total.added}
        </span>
        <span className="text-[10px] font-medium text-red-400">
          −{total.removed}
        </span>
        <span className="ml-auto text-halo-muted">
          <ChevronDownIcon className={open ? "" : "-rotate-90"} />
        </span>
      </button>
      {open && (
        <div className="anim-fade-up mt-2 border-t border-halo-line/50 pt-2">
          {files.map((f, i) => {
            const isUndone = undone.has(normalizePath(f.path));
            // Усечённый before нельзя безопасно восстановить — undo недоступен
            const canUndo = !isUndone && !f.before?.startsWith("[TRUNCATED");
            const expanded = openFile === normalizePath(f.path);
            const dir = f.path.replace(/[\\/][^\\/]+$/, "");
            const base = f.path.slice(dir ? dir.length + 1 : 0);
            return (
              <div key={f.path} className="mb-1 last:mb-0">
                <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-halo-hover">
                  <button
                    onClick={() =>
                      setOpenFile(expanded ? null : normalizePath(f.path))
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="text-halo-muted">
                      <ChevronDownIcon className={expanded ? "" : "-rotate-90"} />
                    </span>
                    <span
                      className={`truncate font-mono text-[11px] ${
                        isUndone
                          ? "text-halo-muted/60 line-through"
                          : "text-halo-text"
                      }`}
                      title={f.path}
                    >
                      {base}
                      <span className="text-halo-muted/60"> {dir}</span>
                    </span>
                    {f.created && !isUndone && (
                      <span className="shrink-0 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                        {t("agent.diffCreated")}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-emerald-400">
                      +{stats[i].added}
                    </span>
                    <span className="shrink-0 text-[10px] text-red-400">
                      −{stats[i].removed}
                    </span>
                  </button>
                  {isUndone ? (
                    <span className="shrink-0 text-[10px] text-halo-muted/70">
                      ↩ {t("agent.undone")}
                    </span>
                  ) : (
                    canUndo && (
                      <button
                        onClick={() => undo(f)}
                        title={t("agent.undo")}
                        className="shrink-0 rounded-md p-1 text-[11px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                      >
                        ↩
                      </button>
                    )
                  )}
                </div>
                {expanded && (
                  <div className="mt-1">
                    <DiffView
                      lines={diffLines(f.before ?? "", f.after)}
                      hasBefore={f.before !== null}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Дифф-подсветка: удалённые строки красным, добавленные зелёным, контекст серым */
function DiffView({ lines, hasBefore }: { lines: DiffLine[]; hasBefore: boolean }) {
  const { t } = useLang();
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 300;
  const shown = showAll ? lines : lines.slice(0, LIMIT);

  return (
    <div className="scroll-slim max-h-96 overflow-auto rounded-lg border border-halo-line/60 bg-halo-deep/60">
      {hasBefore ? (
        lines.some((l) => l.type !== "ctx") ? (
          shown.map((l, i) => (
            <div
              key={i}
              className={`flex gap-2 px-2 font-mono text-[11px] leading-[1.6] ${
                l.type === "del"
                  ? "bg-red-400/10 text-red-300"
                  : l.type === "add"
                    ? "bg-emerald-400/10 text-emerald-300"
                    : "text-halo-muted"
              }`}
            >
              <span className="w-8 shrink-0 select-none text-right text-halo-muted/50">
                {l.oldNo ?? ""}
              </span>
              <span className="w-4 shrink-0 select-none text-right">
                {l.type === "del" ? "−" : l.type === "add" ? "+" : ""}
              </span>
              <span className="whitespace-pre-wrap break-all">{l.text}</span>
            </div>
          ))
        ) : (
          <div className="px-3 py-2 text-[11px] text-halo-muted">
            {t("agent.diffEmpty")}
          </div>
        )
      ) : (
        // Нового файла не было — показываем только «после»
        <pre className="scroll-slim max-h-96 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-halo-text">
          {lines.map((l) => l.text).join("\n")}
        </pre>
      )}
      {!showAll && lines.length > LIMIT && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full border-t border-halo-line/60 py-1.5 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("card.expand")} · {lines.length - LIMIT}
        </button>
      )}
    </div>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** Иконка режима разрешений: лампа (план), ладонь (спросить), карандаш (правки), щит (полный) */
function PermModeIcon({ mode }: { mode: PermissionMode }) {
  if (mode === "plan") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
      </svg>
    );
  }
  if (mode === "ask") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </svg>
    );
  }
  if (mode === "edit") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L3.5 16.5 2 22l5.5-1.5Z" />
      </svg>
    );
  }
  return <ShieldIconBig />;
}

function ShieldIconBig() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Кольцо заполнения контекстного окна модели со всплывающей сводкой */
function ContextRing({
  used,
  limit,
  rows,
  isEstimate,
}: {
  used: number;
  limit: number;
  rows: { label: string; tokens: number; color: string }[];
  isEstimate: boolean;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  const color = pct >= 0.85 ? "#d14b4b" : pct >= 0.6 ? "#d4aa50" : "#5fbe82";
  const R = 7;
  const C = 2 * Math.PI * R;
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        title={t("ctx.title")}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-halo-hover"
      >
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r={R} fill="none" stroke="var(--halo-line)" strokeWidth={2.5} />
          <circle
            cx="10"
            cy="10"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${C * pct} ${C}`}
            transform="rotate(-90 10 10)"
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
          <text x="10" y="13" textAnchor="middle" fill="var(--halo-muted)" fontSize={7}>
            {Math.round(pct * 100)}
          </text>
        </svg>
      </button>
      {open && (
        <div className="glass-pane absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl border border-halo-line bg-halo-deep/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-medium text-halo-text">{t("ctx.title")}</span>
            <span className="text-halo-muted">
              {fmt(used)} / {fmt(limit)} · {Math.round(pct * 100)}%
            </span>
          </div>
          <div className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-halo-line">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct * 100}%`, background: color }}
            />
          </div>
          {/* Разбивка заполнения: кто сколько окна съедает */}
          <div className="mb-2 flex flex-col gap-1.5">
            {rows.map((r) => {
              const rowPct = limit > 0 ? (r.tokens / limit) * 100 : 0;
              return (
                <p
                  key={r.label}
                  className="flex items-center gap-2"
                  title={`${r.tokens.toLocaleString("ru-RU")} ~tokens`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      background: rowPct > 0 ? r.color : "var(--halo-muted)",
                      opacity: rowPct > 0 ? 1 : 0.4,
                    }}
                  />
                  <span className="flex-1 text-halo-muted">{t(r.label as never)}</span>
                  <span className="text-halo-text/80">
                    {rowPct > 0 ? `${rowPct.toFixed(1)}%` : "0%"}
                  </span>
                </p>
              );
            })}
          </div>
          <p className="mb-1 flex justify-between text-halo-muted">
            <span>{t("ctx.used")}</span>
            <span>{used.toLocaleString("ru-RU")}</span>
          </p>
          <p className="mb-2 flex justify-between text-halo-muted">
            <span>{t("ctx.limit")}</span>
            <span>
              {limit.toLocaleString("ru-RU")}{" "}
              <span className="text-halo-muted/50">
                ({isEstimate ? t("ctx.estimate") : t("ctx.fromProvider")})
              </span>
            </span>
          </p>
          <p className="text-[10px] text-halo-muted/60">{t("ctx.hint")}</p>
        </div>
      )}
    </div>
  );
}

function SlidersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

/** Бабл живого статуса: что модель делает прямо сейчас (реальные события стрима) */
function TypingBubble({ label }: { label: string }) {
  return (
    <div className="anim-fade-up mr-auto w-fit rounded-xl border border-halo-line/70 bg-halo-surface/70 px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="typing-dot size-1.5 rounded-full bg-halo-muted"
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
        <span className="text-xs text-halo-muted">{label}</span>
      </div>
    </div>
  );
}

function SparkIcon() {
  return <NocturnMark size={34} />;
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${className ?? ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SystemPromptIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16M4 12h10M4 18h7" />
      <circle cx="18" cy="16.5" r="3" />
      <path d="m20.5 19-2-2" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** Галочка: выполненная задача в виджете Progress (PlanPanel) */
function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}



function SubagentIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M15.5 14.6c2.6.3 4.4 2 5 4.9" />
    </svg>
  );
}


function RobotIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="9" width="14" height="10" rx="2.5" />
      <path d="M12 9V5" />
      <circle cx="12" cy="3.5" r="1" />
      <path d="M9.5 13.5h.01 M14.5 13.5h.01" />
      <path d="M3 12.5v3 M21 12.5v3" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 7H6.5A2.5 2.5 0 0 0 4 9.5v3A2.5 2.5 0 0 0 6.5 15H8a4 4 0 0 1-3 3v2c3.9-.6 6-3 6-7V8a1 1 0 0 0-1-1zm9 0h-3.5A2.5 2.5 0 0 0 13 9.5v3a2.5 2.5 0 0 0 2.5 2.5H17a4 4 0 0 1-3 3v2c3.9-.6 6-3 6-7V8a1 1 0 0 0-1-1z" />
    </svg>
  );
}

/** Стрелка в скобках: вернуть изображение из сообщения в композер */
function ReuseImgIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M20 12H10" />
      <path d="m14 8-4 4 4 4" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function XSmallIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

function CorrectIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Стрелка-повтор: поправка уйдёт агенту в следующем раунде */}
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
