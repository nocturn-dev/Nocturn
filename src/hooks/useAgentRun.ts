// Агентный движок Nocturn: стримы с ретраем, инструментальные циклы,
// субагенты, взаимодействия (подтверждения/вопросы), очередь поправок.
// Выделено из App.tsx: здесь живёт всё состояние прогона, App только
// передаёт зависимости и получает обработчики для рендера.
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  abortChat,
  chatStream,
  checkpointSave,
  gitAutocommit,
  getToolSchemas,
  hooksRunEvent,
  kbQuery,
  memoryList,
  permSet,
  projectRulesRead,
  runTool,
  type ApiSettings,
  type ChatMsgParam,
  type ChatUsage,
  type MemoryFact,
} from "../api";
// FIX: trimContextWindow заменяет голый .slice(-30), который разрывал
// пары «assistant tool_calls ↔ tool-результаты» на границе окна (→ 400 от провайдера)
// Чистые фазы prepare (история/память) — в agent/history; лимиты — в limits.ts
import { buildHistory, buildMemoryBlock } from "../agent/history";
import { buildProfileBlock } from "../userProfile";
import { evalHardLimit } from "../limits";
import { filterToolSchemas } from "../agent/toolFilter";
import { runPython, CODE_RUN_SCHEMA } from "../codeRun";
import { StreamDeltaBuffer, applyMainDeltas } from "./streamBuffer";
import { interpolate, parseWorkflow, type WorkflowDef } from "../workflow";
import { notifyTaskDone, type NotifyPrefs } from "../notify";
import { useLang } from "../locales";
import { dayKeyLocal } from "../time";
import {
  SUBAGENT_ROLES,
  mergeRoles,
  runSubagent,
  type SubRunState,
  type SubagentRole,
  type SubagentStep,
  type SubagentsConfig,
} from "../subagents";
import type {
  Attachment,
  Message,
  PlanTask,
  Session,
  ToolCallInfo,
  UsageEvent,
} from "../types";
import type { HardLimits } from "../limits";
import {
  InteractionRegistry,
  type AskUserSpec,
  type Interaction,
  type InteractionResolution,
} from "../interactions";

/** Ошибки провайдера, которые имеет смысл ретраить: перегрузка/лимиты/сеть */
const RETRYABLE_RE =
  /\bHTTP (?:429|500|502|503|504|52\d)\b|failed to fetch|connection|timed?.?out/i;

/** Единый генератор id: раньше дублировался здесь и в App.tsx */
export const uid = () => crypto.randomUUID();

// Автопродолжение вопроса: без ответа пользователя N минут модель продолжит сама
const ASK_AUTO_CONTINUE_MS = 5 * 60_000;
/** HTTP-код из строки ошибки Rust-стрима ("HTTP 503: …") */
function parseHttpCode(raw: string): number | null {
  const m = raw.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** Хэндл активного прогона: обёртка handleSend по нему гарантированно
 *  доводит прогон до finalize / освобождения движка при ЛЮБОМ исключении */
interface RunHandle {
  requestId: string;
  finalize: (() => void) | null;
}

/** Ключ разрешения «всегда для задачи»: имя инструмента + аргументы. Раньше
 *  хранились одни аргументы — разрешение на один инструмент с `{}` покрывало
 *  любой другой мутирующий инструмент с теми же аргументами. Имя функции не
 *  содержит пробелов, поэтому первый пробел однозначно делит ключ */
const allowKey = (call: ToolCallInfo) => `${call.name} ${call.arguments}`;

export interface AgentRunDeps {
  // FIX [dead-prop]: sessions передавался, но внутри хука не читался
  // ни разу (везде используется sessionsRef) — лишний аргумент на каждый
  // рендер App
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  sessionsRef: { current: Session[] };
  activeId: string | null;
  apiSettings: ApiSettings;
  effortRef: { current: "off" | "low" | "high" | "max" };
  subConfigRef: { current: SubagentsConfig };
  notifyPrefsRef: { current: NotifyPrefs };
  projectRootRef: { current: string | null };
  browserAutoPanelRef: { current: boolean };
  activeSessionRef: { current: Session | null };
  setBrowserPanelOpen: (v: boolean) => void;
  addToast: (text: string) => void;
  setUsageLog: React.Dispatch<React.SetStateAction<UsageEvent[]>>;
  chainRunning: boolean;
  /** Автопродолжение ask_user без ответа (5 минут) */
  askAutoContinue: boolean;
  notifyMeta: (s: Session | null) => string;
  activeProjectId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  limitsRef: { current: HardLimits };
  memoryEnabled: boolean;
}

export function useAgentRun(deps: AgentRunDeps) {
  const {
    sessionsRef,
    activeId,
    apiSettings,
    effortRef,
    subConfigRef,
    notifyPrefsRef,
    projectRootRef,
    browserAutoPanelRef,
    activeSessionRef,
    setBrowserPanelOpen,
    addToast,
    setUsageLog,
    chainRunning,
    askAutoContinue,
    notifyMeta,
    activeProjectId,
    setActiveId,
    limitsRef,
    memoryEnabled,
  } = deps;
  const { setSessions } = deps;
  const { t } = useLang();

  const [typing, setTyping] = useState(false);
  // Очередь корректирующих сообщений: набираются, пока агент отвечает,
  // отправляются автоматически после завершения прогона (finalize)
  const [queuedMsgs, setQueuedMsgs] = useState<
    { id: string; text: string; attachments?: Attachment[]; quote?: string }[]
  >([]);
  const queuedMsgsRef = useRef(queuedMsgs);
  useEffect(() => {
    queuedMsgsRef.current = queuedMsgs;
  }, [queuedMsgs]);
  // Корректирующие запросы агента: текст, отправленный пользователем ВО ВРЕМЯ
  // работы агента (не прерывая её) — requestId → список поправок. Реф-зеркало
  // нужно, чтобы агентный цикл читал поправки синхронно между шагами
  const [pendingCorrections, setPendingCorrections] = useState<
    Record<string, string[]>
  >({});
  const pendingCorrectionsRef = useRef(pendingCorrections);
  useEffect(() => {
    pendingCorrectionsRef.current = pendingCorrections;
  }, [pendingCorrections]);
  // Живой статус модели для TypingBubble: размышляет / вызывает инструмент / исполняет
  const [activity, setActivity] = useState<string | null>(null);

  // Стрим с авто-ретраем: мгновенные 429/5xx/сетевые сбои до первого токена
  // повторяем дважды с растущей паузой; частичный ответ не трогаем.
  // Волна 5: ретраи кончились, сервер всё ещё отвечает 429/5xx — второй
  // прогон на fallback-модели (если задана и отличается от основной)
  const chatWithRetry = useCallback(
    async (
      opts: Parameters<typeof chatStream>[0] & {
        fallbackModel?: string;
        onFallback?: (model: string) => void;
      },
    ) => {
      let received = false;
      const wrapped = {
        ...opts,
        onDelta: (d: string, seq?: number) => {
          received = true;
          opts.onDelta(d, seq);
        },
        onThought: (th: string, seq?: number) => {
          received = true;
          opts.onThought(th, seq);
        },
        // FIX: usage означает «провайдер уже насчитал токены за попытку» —
        // ретрай после него двойно считал токены в Hard-Limit и журнале
        onUsage: (u: ChatUsage, barrier?: boolean, seq?: number) => {
          received = true;
          opts.onUsage(u, barrier, seq);
        },
        // FIX: tool_calls тоже часть частично-оплаченного ответа — не ретраим
        onToolCalls: (c: ToolCallInfo[], barrier?: boolean, seq?: number) => {
          received = true;
          opts.onToolCalls?.(c, barrier, seq);
        },
      };
      // Stop/Hard Limit могли сработать ещё до старта стрима (пока собирался
      // контекст: хуки, память, KB) — не стартуем запрос впустую
      if (abortedRef.current.has(opts.requestId)) return;
      for (let attempt = 0; ; attempt++) {
        try {
          await chatStream(wrapped);
          return;
        } catch (e) {
          const msg = String(e);
          if (
            !received &&
            attempt < 2 &&
            RETRYABLE_RE.test(msg) &&
            !abortedRef.current.has(opts.requestId)
          ) {
            setActivity(t("activity.retry", { n: attempt + 1 }));
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            // Stop нажат во время паузы — новый запрос не стартуем
            if (abortedRef.current.has(opts.requestId)) return;
            continue;
          }
          // Fallback-модель: только на 429/5xx (сетевые сбои моделью не лечатся),
          // до первого токена и пока прогон не отменён
          const fb = opts.fallbackModel?.trim();
          const code = parseHttpCode(msg);
          if (
            !received &&
            fb &&
            fb !== opts.model &&
            (code === 429 || (code !== null && code >= 500)) &&
            !abortedRef.current.has(opts.requestId)
          ) {
            setActivity(t("activity.fallback", { model: fb }));
            try {
              await chatStream({ ...wrapped, model: fb });
              opts.onFallback?.(fb);
              return;
            } catch {
              // Ошибка фолбэка не информативнее исходной — показываем исходную
            }
          }
          // Прогон остановлен пользователем/лимитом: обрыв — не ошибка,
          // карточку ошибки не рисуем (маркер «остановлено» ставит finalize)
          if (abortedRef.current.has(opts.requestId)) return;
          throw e;
        }
      }
    },
    [t],
  );

  // Откат записи агента: изменённый файл восстанавливаем из before,

  // Ошибка запроса → человекочитаемый заголовок на карточке, сырое тело — по клику.
  // titleOverride — для особых случаев (пустой ответ провайдера)
  const setMsgError = useCallback(
    (assistantId: string, raw: string, titleOverride?: string) => {
      const code = parseHttpCode(raw);
      const title =
        titleOverride ??
        (code === 401 || code === 403
          ? t("err.auth", { code })
          : code === 404
            ? t("err.notFound", { code })
            : code === 429
              ? t("err.rate", { code })
              : code !== null && code >= 500
                ? t("err.server", { code })
                : t("err.generic"));
      setSessions((prev) => {
        // FIX: ищем сессию-владельца один раз и клонируем только её,
        // вместо глубокой копии ВСЕХ сессий и всех их сообщений
        const owner = prev.find((s) => s.messages.some((m) => m.id === assistantId));
        if (!owner) return prev;
        return prev.map((s) =>
          s.id === owner.id
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, error: { title, raw } } : m,
                ),
              }
            : s,
        );
      });
    },
    // setSessions — сеттер useState, идентичность стабильна
    [t, setSessions],
  );

  const [streamingId, setStreamingId] = useState<string | null>(null);
  // id ассистентского сообщения активного стрима — СОСТОЯНИЕ, а не чтение
  // ref в рендере: streamingRef заполняется вне setState-цикла, и рендер
  // мог видеть рассинхрон (карточка стрима без индикатора на первый кадр)
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  // FIX [re-entrancy]: реф активного прогона (requestId). state streamingId
  // обновляется асинхронно — автоматизации и очередь нуждаются в синхронном
  // «занят ли движок прямо сейчас», иначе второй прогон перезаписывает
  // streamingId первого и finalize/Stop калечат чужой прогон.
  const activeRunRef = useRef<string | null>(null);
  // Флаг «последний handleSend реально стартовал»: runChain различает
  // «шаг выполнился» и «handleSend bail-ил по guard'у» (движок занят)
  const runStartedRef = useRef(false);
  // id сессии активного прогона: удаление/очистка задачи в UI проверяют,
  // что прерывают именно прогон этой задачи
  const streamingTargetRef = useRef<string | null>(null);
  // Ожидающие взаимодействия агента (подтверждение инструмента, вопрос ask_user)
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const interactionsRef = useRef(new InteractionRegistry());
  // Зеркало interactions для cancelInteractions: колбэки стабильны
  // (useCallback без deps), а свежий список читается из ref — иначе
  // захваченный на старте прогона пустой state пропускал бы все
  // взаимодействия, открытые позже
  const interactionsLatest = useRef<Interaction[]>([]);
  const openInteraction = useCallback((i: Interaction, resolve: (r: InteractionResolution) => void) => {
    interactionsRef.current.open(i, resolve);
    interactionsLatest.current = [...interactionsLatest.current, i];
    setInteractions((prev) => [...prev, i]);
  }, []);
  const resolveInteraction = useCallback((id: string, r: InteractionResolution) => {
    if (interactionsRef.current.resolve(id, r)) {
      interactionsLatest.current = interactionsLatest.current.filter((x) => x.id !== id);
      setInteractions((prev) => prev.filter((x) => x.id !== id));
    }
  }, []);
  const cancelInteractions = useCallback((requestId?: string) => {
    // Без requestId — все (полный сброс). С requestId — только взаимодействия
    // этого прогона: finalize старого прогона не должен гасить confirm/ask-
    // карточки уже стартовавшего нового (гонка Stop → автоматизация)
    if (requestId == null) {
      interactionsRef.current.cancelAll();
      setInteractions([]);
      interactionsLatest.current = [];
      return;
    }
    const ids = new Set(
      interactionsLatest.current
        .filter((i) => i.requestId === requestId)
        .map((i) => i.id),
    );
    for (const id of ids) interactionsRef.current.resolve(id, { kind: "cancel" });
    setInteractions((prev) => {
      const next = prev.filter((x) => !ids.has(x.id));
      interactionsLatest.current = next;
      return next;
    });
  }, []);

  // requestId → id ассистентского сообщения в активном стриме
  const streamingRef = useRef<Map<string, string>>(new Map());
  const abortedRef = useRef<Set<string>>(new Set());
  // Прогоны, остановленные пользователем: requestId → id ассистентской
  // карточки. finalize ставит маркер «остановлено» после дренажа дельт
  const stoppedRef = useRef<Map<string, string>>(new Map());
  // Флаг отмены цепочки задач (ChainMonitor): читается в runChain, ставится в handleStop
  const chainAbortRef = useRef(false);
  // Hard Limit: одноразовый триггер на задачу — сбрасывается в начале handleSend
  const limitHitRef = useRef(false);
  // Активный таймер ask-автопродолжения: отменяется в finalize — раньше
  // копился по одному на каждый вопрос и доживал 5 минут впустую
  const askTimerRef = useRef<number | null>(null);

  // Чекпоинт за прогон агента: снимок делаем один раз перед первой правкой
  const runCheckpointRef = useRef(false);
  // Метаданные последнего снимка: root + id — источник диффа для Review
  const lastCheckpointRef = useRef<{ root: string; id: string } | null>(null);

  // Живые прогоны субагентов (M2): ключ — tool call id
  const [subRuns, setSubRuns] = useState<Record<string, SubRunState>>({});
  /** id таймеров очистки монитора субагентов: гасятся в cleanup хука,
   *  иначе тикают зря после размонтирования */
  const subRunTimersRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const timers = subRunTimersRef.current;
    return () => {
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    };
  }, []);
  const patchSubRun = (id: string, fn: (r: SubRunState) => SubRunState) =>
    setSubRuns((prev) => (prev[id] ? { ...prev, [id]: fn(prev[id]) } : prev));

  // ── Фоновые субагенты (ZCode-стиль): background=true возвращает сразу,
  // отчёт дописывается в сессию по завершении; статус — subagent_status ──
  interface BgSubTask {
    id: string;
    roleId: string;
    roleName: string;
    task: string;
    sessionId: string;
    startedAt: number;
    status: "running" | "done" | "failed" | "cancelled";
    report: string | null;
    /** requestId прогона-родителя: Stop/лимит гасят только его фоновые задачи */
    runId: string;
    /** Собственный флаг отмены: abortedRef чистится finalize'ом родителя,
     *  а фоновый субагент по замыслу переживает основной прогон */
    cancelled: boolean;
  }
  const bgRegistryRef = useRef(new Map<string, BgSubTask>());
  const bgCounterRef = useRef(0);
  /** Отмена фоновых субагентов по прогону и/или задаче (Stop, Hard Limit).
   *  Без фильтров не вызывать — погасит вообще все */
  const cancelBgSubagents = useCallback(
    (filter: { runId?: string; sessionId?: string }) => {
      for (const b of bgRegistryRef.current.values()) {
        if (b.status !== "running" || b.cancelled) continue;
        if (filter.runId !== undefined && b.runId !== filter.runId) continue;
        if (filter.sessionId !== undefined && b.sessionId !== filter.sessionId)
          continue;
        b.cancelled = true;
        // Убить исполняющийся инструмент/стрим под id прогона (best-effort)
        void abortChat(b.runId).catch(() => {});
      }
    },
    [],
  );
  const stopBackgroundSubagents = useCallback(
    (sessionId?: string) => {
      if (sessionId) cancelBgSubagents({ sessionId });
    },
    [cancelBgSubagents],
  );

  // План задач агента: живёт в сессии, перезаписывается только plan_update.
  // setSessions — сеттер useState, идентичность стабильна
  const applyPlan = useCallback(
    (targetId: string, tasks: PlanTask[]) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === targetId ? { ...s, plan: tasks } : s)),
      );
    },
    [setSessions],
  );

  // Движок автоматизаций: раз в 30 сек проверяем сроки. За тик запускаем
  // максимум одну задачу (стрим один), остальные дождутся следующих тиков.
  const handleSendRef = useRef<typeof handleSend | null>(null);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  // Сообщение в OpenAI-формат (toApiContent/toApiMessage) и сборка истории —
  // чистые функции в agent/history.ts, покрыты тестами

  // Тело прогона. Движок к этому моменту уже захвачен обёрткой handleSend
  // (см. ниже), которая при любом необработанном исключении доводит прогон
  // до finalize — activeRunRef больше не может «клинить» навечно
  const sendImpl = async (
    run: RunHandle,
    raw: string,
    attachments: Attachment[] | undefined,
    overrideTargetId: string | undefined,
    quote: string | undefined,
    editMsgId: string | undefined,
    budgetCarry: { prompt: number; completion: number } | undefined,
  ) => {
    const text = raw.trim();
    const images = attachments ?? [];
    const requestId = run.requestId;
    // Освобождение движка на путях отказа ниже (валидация, блокировка хуком)
    const releaseRun = () => {
      if (activeRunRef.current === requestId) activeRunRef.current = null;
    };

    // Первое сообщение создаёт задачу, если активной ещё нет
    let targetId = overrideTargetId ?? activeId;
    let sessionJustCreated = false;
    if (!targetId) {
      if (editMsgId) {
        releaseRun();
        return;
      }
      const session: Session = {
        id: uid(),
        title: (text || images[0]?.name || t("chat.imageTitle")).slice(0, 48),
        createdAt: Date.now(),
        messages: [],
        projectId: activeProjectId ?? undefined,
      };
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      targetId = session.id;
      sessionJustCreated = true;
    }

    // Синхронизация серверного слоя прав: бэкенд должен знать режим и корень
    // проекта до первого инструмента (fire-and-forget: ошибка не валит отправку)
    const permSession = sessionsRef.current.find((s) => s.id === targetId);
    void permSet(
      permSession?.permissionMode ?? "ask",
      projectRootRef.current ? [projectRootRef.current] : [],
    ).catch(() => {});

    // Редактирование с ветвлением: оригинальная сессия остаётся нетронутой,
    // правленый диалог уезжает в новую сессию-ветку (edit-and-resend: форк
    // от хода, оригинал восстанавливается кликом в списке). Раньше хвост
    // после правленого сообщения срезался навсегда
    let currentOverride: Session | undefined;
    let editAttachments: Attachment[] | undefined;
    if (editMsgId) {
      const src = sessionsRef.current.find((s) => s.id === targetId);
      const orig = src?.messages.find((m) => m.id === editMsgId);
      if (!src || !orig || orig.role !== "user") {
        releaseRun();
        return;
      }
      const kept = src.messages.slice(0, src.messages.indexOf(orig));
      const branch: Session = {
        id: uid(),
        title: src.title,
        createdAt: Date.now(),
        messages: kept,
        projectId: src.projectId,
        systemPrompt: src.systemPrompt,
        agentMode: src.agentMode,
        allowedCommands: src.allowedCommands,
        permissionMode: src.permissionMode,
        disabledTools: src.disabledTools,
        profileId: src.profileId,
        // Привязанная база знаний — без неё RAG в ветке молча выключался
        kbId: src.kbId,
        branchedFrom: { sessionId: src.id, messageId: editMsgId },
      };
      setSessions((prev) => [branch, ...prev]);
      setActiveId(branch.id);
      targetId = branch.id;
      currentOverride = branch;
      editAttachments = orig.attachments;
      addToast(t("branch.created"));
    }

    const userMsg: Message =
      editMsgId ? {
        id: uid(),
        role: "user",
        content: text,
        attachments: images.length > 0 ? images : editAttachments,
        quote: quote?.trim() || undefined,
      } : {
        id: uid(),
        role: "user",
        content: text,
        attachments: images.length > 0 ? images : undefined,
        quote: quote?.trim() || undefined,
      };
    // targetId финализирован — фиксируем сессию активного прогона
    streamingTargetRef.current = targetId;

    // API не настроен — вместо запроса показываем подсказку
    if (
      apiSettings.api_key.trim() === "" ||
      apiSettings.model.trim() === ""
    ) {
      const hint: Message = {
        id: uid(),
        role: "assistant",
        content: t("error.apiNotConfigured"),
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? {
                ...s,
                title:
                  s.messages.length === 0
                    ? (text || images[0]?.name || t("chat.imageTitle")).slice(0, 48)
                    : s.title,
                messages: [...s.messages, userMsg, hint],
              }
            : s,
        ),
      );
      releaseRun();
      return;
    }

    // Хук SessionStart: событие объявлено в UI/бэкенде, но раньше фронтом
    // никогда не вызывалось — мёртвая поверхность конфигурации. Fire-and-forget
    // на первое сообщение задачи; additionalContext дописывается к промту
    let sessionStartCtx = "";
    {
      const isFirstSend =
        sessionJustCreated ||
        sessionsRef.current.find((s) => s.id === targetId)?.messages.length === 0;
      if (isFirstSend) {
        try {
          const outs = await hooksRunEvent("SessionStart", { event: "SessionStart" });
          sessionStartCtx = outs
            .map((o) => o.additionalContext)
            .filter((c) => c.trim() !== "")
            .join("\n");
        } catch {
          // хуки не должны ломать отправку
        }
      }
    }

    // Хук UserPromptSubmit: может заблокировать отправку или дополнить промт
    {
      let effective = text;
      try {
        const outs = await hooksRunEvent("UserPromptSubmit", { event: "UserPromptSubmit", prompt: text });
        const blocked = outs.find((o) => o.blocked);
        if (blocked) {
          const msg: Message = {
            id: uid(),
            role: "assistant",
            content: `⛔ ${t("hook.blockedSend")}\n\n${blocked.reason}`.trim(),
          };
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetId ? { ...s, messages: [...s.messages, userMsg, msg] } : s,
          ),
        );
        releaseRun();
        return;
      }
        const extra = [...outs.map((o) => o.additionalContext), sessionStartCtx]
          .filter((c) => c.trim() !== "")
          .join("\n");
        if (extra) effective = `${text}\n\n[hook context]\n${extra}`;
      } catch {
        // хуки не должны ломать отправку
      }
      if (effective !== text) {
        userMsg.content = effective;
      }
    }

    // requestId захвачен выше (C1, сразу после guard'а) — здесь только UI-стейт
    // requestId → id ассистентского сообщения выставляется при его создании
    // (в агентном режиме — на каждый шаг цикла)
    setStreamingId(requestId);
    setTyping(true);
    setActivity(t("activity.thinking"));
    const startedAt = Date.now();
    // Накопитель расхода: для звена цепочки очереди стартует с расхода
    // предыдущих звеньев (budgetCarry) — корректировки одной задачи делят
    // один бюджет Hard Limit, а не получают его заново на каждое сообщение
    const usageAcc = {
      prompt: budgetCarry?.prompt ?? 0,
      completion: budgetCarry?.completion ?? 0,
    };
    // Уже записанное в журнал использования (расход предыдущих звеньев
    // записан их finalize): пишем только дельту, без двойного учёта
    let loggedPrompt = usageAcc.prompt;
    let loggedCompletion = usageAcc.completion;
    const logUsageDelta = (workedMs: number) => {
      const prompt = usageAcc.prompt - loggedPrompt;
      const completion = usageAcc.completion - loggedCompletion;
      if (prompt + completion <= 0) return;
      loggedPrompt = usageAcc.prompt;
      loggedCompletion = usageAcc.completion;
      setUsageLog((prev) => [
        ...prev.slice(-4999),
        {
          day: dayKeyLocal(new Date()),
          prompt,
          completion,
          model: apiSettings.model,
          workedMs,
        },
      ]);
    };
    // Прогон завершён (finalize): фоновые субагенты ещё могут считать токены
    let runFinished = false;
    let bgLimitHit = false;
    // Hard Limit: новая отправка пользователя — с чистого листа
    limitHitRef.current = false;
    // Hard Limit: проверка после каждого usage-события; при превышении — abort задачи.
    // Чистая оценка лимита — evalHardLimit (limits.ts), здесь только побочные эффекты
    const checkHardLimit = () => {
      if (runFinished) {
        // Прогон уже завершён, а фоновые субагенты ещё считают токены. Общее
        // состояние движка (limitHitRef/abortedRef) теперь принадлежит другому
        // прогону — не трогаем его (раньше requestId навечно оседал в
        // abortedRef, а limitHitRef глушил лимит уже нового прогона)
        if (bgLimitHit) return;
        const lateKey = evalHardLimit(limitsRef.current, usageAcc);
        if (lateKey) {
          bgLimitHit = true;
          cancelBgSubagents({ runId: requestId });
          addToast(t(lateKey));
        }
        return;
      }
      if (limitHitRef.current) return;
      const hitKey = evalHardLimit(limitsRef.current, usageAcc);
      if (hitKey) {
        limitHitRef.current = true;
        // Полноценный abort: помечаем задачу прерванной (цикл и субагенты
        // проверяют abortedRef на каждом шаге) + рвём текущий стрим
        abortedRef.current.add(requestId);
        void abortChat(requestId).catch(() => {});
        // Фоновые субагенты переживают прогон — гасим их отдельным флагом
        cancelBgSubagents({ runId: requestId });
        addToast(t(hitKey));
      }
    };

    // ── Батчинг дельт стрима ──
    // Каждая дельта — отдельное Tauri-событие: setSessions на каждую дельту
    // ре-рендерил всё дерево до ~100 раз/сек (React между событиями не батчит).
    // Дельты копятся и сбрасываются одним обновлением раз на кадр.
    const deltaBuf = new StreamDeltaBuffer();
    let deltaRaf = 0;
    const flushDeltas = () => {
      if (deltaRaf) {
        cancelAnimationFrame(deltaRaf);
        // Фолбэк-таймер (см. scheduleFlush): cancelAnimationFrame на
        // setTimeout-id — no-op, гасим оба
        window.clearTimeout(deltaRaf);
        deltaRaf = 0;
      }
      if (deltaBuf.isEmpty) return;
      const { main, subThoughts } = deltaBuf.drain();
      if (main.length > 0) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetId
              ? { ...s, messages: applyMainDeltas(s.messages, main) }
              : s,
          ),
        );
      }
      if (subThoughts.length > 0) {
        setSubRuns((prev) => {
          let next = prev;
          for (const [callId, thought] of subThoughts) {
            const run = next[callId];
            if (!run) continue;
            next = { ...next, [callId]: { ...run, thought } };
          }
          return next;
        });
      }
    };
    const scheduleFlush = () => {
      if (deltaRaf) return;
      if (typeof requestAnimationFrame === "function" && !document.hidden) {
        deltaRaf = requestAnimationFrame(flushDeltas);
      } else if (typeof setTimeout === "function") {
        // C17: WebView2 не тикает rAF в свёрнутом/перекрытом окне — дельты
        // копились без сброса, чат «замерзал» на часы фоновых прогонов
        deltaRaf = window.setTimeout(flushDeltas, 250);
      }
    };
    // Окно ушло в hidden ПОСЛЕ планирования rAF: rAF не тикает до возврата
    // видимости, буфер копит весь ответ, стор не обновляется. По hidden
    // сливаем сразу — слушатель живёт до finalize (все пути выхода зовут его)
    const onVisibility = () => {
      if (document.hidden) flushDeltas();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let finalized = false;
    const finalize = () => {
      // Идемпотентно: вызывается и путями цикла, и обёрткой handleSend
      // при исключении — второй вызов не должен ни дренировать очередь, ни
      // дважды писать журнал
      if (finalized) return;
      finalized = true;
      runFinished = true;
      // Прогон остановлен: Stop пользователя или срабатывание Hard Limit
      // (оба ставят requestId в abortedRef). Читаем ДО чистки ниже
      const wasAborted = abortedRef.current.has(requestId);
      document.removeEventListener("visibilitychange", onVisibility);
      // Отменить ask-таймер: вопрос разрешён (или прогон умер) — таймер не нужен
      if (askTimerRef.current !== null) {
        window.clearTimeout(askTimerRef.current);
        askTimerRef.current = null;
      }
      // Независимо от пути завершения — дельты обязаны попасть в стор
      flushDeltas();
      // Маркер «остановлено пользователем» — ПОСЛЕ дренажа буфера дельт:
      // раньше маркер ставился в handleStop, а финальные дельты доливались
      // после него, и маркер оказывался в середине текста
      const stoppedMsgId = stoppedRef.current.get(requestId);
      if (stoppedMsgId !== undefined) {
        stoppedRef.current.delete(requestId);
        const stopped = t("card.stoppedByUser");
        setSessions((prev) =>
          prev.map((s) =>
            s.messages.some((m) => m.id === stoppedMsgId)
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === stoppedMsgId
                      ? { ...m, content: m.content + `\n\n*${stopped}*` }
                      : m,
                  ),
                }
              : s,
          ),
        );
      }
      setTyping(false);
      setActivity(null);
      // Сброс общей движковой state — только если прогон всё ещё владеет
      // ею: за время долгого ожидания владелец мог смениться
      setStreamingId((cur) => (cur === requestId ? null : cur));
      if (activeRunRef.current === requestId) {
        activeRunRef.current = null; // FIX [re-entrancy]: движок свободен
      }
      // Чужой (более новый) ассистентский id не трогаем — сравнение по значению
      setStreamingAssistantId((cur) =>
        cur != null && streamingRef.current.get(requestId) === cur ? null : cur,
      );
      streamingRef.current.delete(requestId);
      abortedRef.current.delete(requestId);
      if (streamingTargetRef.current === targetId) streamingTargetRef.current = null;
      // Прогон завершён — метка последней активности (для авто-архива)
      setSessions((prev) =>
        prev.map((s) => (s.id === targetId ? { ...s, updatedAt: Date.now() } : s)),
      );
      // Взаимодействия не должны пережить прогон (страховка: цикл обязан
      // был закрыть их сам, но Stop/finalize по исключению — гасим разом).
      // Только СВОИ: finalize старого прогона раньше гасил карточки нового
      cancelInteractions(requestId);
      // Хук Stop: уведомления и т.п. (fire-and-forget, не блокирует UI)
      hooksRunEvent("Stop", { event: "Stop" }).catch(() => {});
      // Поправки, пришедшие во время ПОСЛЕДНЕГО шага: стрим уже завершён,
      // инжектировать их в историю некуда — не теряем, переводим в очередь
      // сообщений (станут новой отправкой сразу после этой задачи)
      const leftover = pendingCorrectionsRef.current[requestId];
      if (leftover?.length) {
        delete pendingCorrectionsRef.current[requestId];
        setPendingCorrections((prev) => {
          if (!(requestId in prev)) return prev;
          const { [requestId]: _drop, ...rest } = prev;
          return rest;
        });
        // В реф добавляем синхронно: дренирование очереди ниже сразу
        // заберёт первую поправку, остальные — финалайзы следующих прогонов
        const moved = leftover.map((txt) => ({ id: uid(), text: txt }));
        queuedMsgsRef.current = [...queuedMsgsRef.current, ...moved];
        setQueuedMsgs(queuedMsgsRef.current);
      }
      // Очередь корректирующих сообщений: первое уходит агенту сразу,
      // его собственный finalize заберёт следующее
      // После Stop или срабатывания лимита очередь НЕ дренируем: иначе
      // поправка стартовала бы сразу после остановки (и с чистым бюджетом).
      // Сообщения остаются в очереди — пользователь видит их и решает сам
      const next = wasAborted ? undefined : queuedMsgsRef.current[0];
      if (next) {
        setQueuedMsgs((prev) => prev.slice(1));
        // Через handleSendRef: замыкание finalize могло устареть
        // (apiSettings с прошлого сообщения), нужна свежая версия;
        // next.quote — цитата из очереди не должна потеряться;
        // budgetCarry — звено цепочки делит бюджет Hard Limit с предыдущим
        void handleSendRef.current?.(
          next.text,
          next.attachments,
          targetId,
          next.quote,
          undefined,
          { prompt: usageAcc.prompt, completion: usageAcc.completion },
        );
        // C3: handleSend захватывает движок синхронно (до первого await) —
        // если после вызова движок свободен, отправка отказала (guard/валидация),
        // и поправка уже снята с очереди: возвращаем её, не теряем
        if (activeRunRef.current === null) {
          setQueuedMsgs((prev) => [next, ...prev]);
        }
      }
      // Тост + звук: пользователь мог уйти в другое приложение
      void notifyTaskDone(
        notifyPrefsRef.current,
        t("notify.doneTitle"),
        notifyMeta(activeSessionRef.current),
        activeSessionRef.current?.title ?? "",
      );
      logUsageDelta(Date.now() - startedAt);
    };
    // Обёртка handleSend вызовет finalize при исключении в теле прогона
    run.finalize = finalize;

    const markWorked = (assistantId: string, fromMs: number = startedAt) => {
      const worked = Date.now() - fromMs;
      // FIX: сужаем обновление по целевой сессии — остальные сессии
      // переиспользуются по ссылке, а не клонируются целиком
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId
                    ? { ...m, workedMs: m.workedMs ?? worked }
                    : m,
                ),
              }
            : s,
        ),
      );
    };

    const appendTo = (assistantId: string, delta: string, thought: string) => {
      if (abortedRef.current.has(requestId)) return;
      setTyping(false);
      // Текст уже печатается в карточке — статус-бабл скрываем;
      // идёт поток размышлений — показываем «Размышляет…»
      setActivity(thought ? t("activity.thinking") : null);
      // Батчинг: дельта копится в буфере, сброс на rAF — setSessions
      // раз на кадр вместо раз на токен (см. flushDeltas выше)
      deltaBuf.append(assistantId, delta, thought);
      scheduleFlush();
    };

    const pushMessage = (msg: Message) => {
      // FIX: штамп времени создания — статистика привязывает токены к дню
      // сообщения, а не ко дню создания сессии (многодневные задачи врали)
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? { ...s, messages: [...s.messages, { ...msg, ts: msg.ts ?? Date.now() }] }
            : s,
        ),
      );
    };

    // Сообщение пользователя попадает в историю сессии: без этого в чате
    // видны только ответы модели, а само сообщение существует лишь в запросе
    pushMessage(userMsg);

    // Задача тронута — двигаем метку последней активности (для авто-архива)
    setSessions((prev) =>
      prev.map((s) => (s.id === targetId ? { ...s, updatedAt: Date.now() } : s)),
    );

    // Контекст: системный промт + окно истории (30) + новое сообщение.
    // Чистая сборка (фильтры, пары tool_calls↔tool, обрезка) — agent/history
    const current =
      currentOverride ?? sessionsRef.current.find((s) => s.id === targetId);
    // Сборка истории читает данные сессии с диска: повреждённая запись
    // раньше кидала TypeError ВНЕ какого-либо try — releaseRun не вызывался,
    // activeRunRef клинился навечно и все последующие отправки молча
    // отсекались guard'ом. Гасим в карточку ошибки и освобождаем движок
    let history: ChatMsgParam[];
    try {
      history = buildHistory(current, userMsg);
    } catch {
      const msg: Message = {
        id: uid(),
        role: "assistant",
        content: t("error.corruptSession"),
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId ? { ...s, messages: [...s.messages, msg] } : s,
        ),
      );
      releaseRun();
      return;
    }

    const isAgent = current?.agentMode ?? false;

    // Заголовок по первому сообщению: `current` — снимок сессии до pushMessage,
    // поэтому сравнение идёт с изначальным числом сообщений
    if ((current?.messages ?? []).length === 0) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? {
                ...s,
                title: (text || images[0]?.name || t("chat.imageTitle")).slice(0, 48),
              }
            : s,
        ),
      );
    }
    // Новый прогон — чекпоинт ещё не снят
    runCheckpointRef.current = false;
    const tools = isAgent
      ? await getToolSchemas()
          .then((t) =>
            filterToolSchemas(
              // code_run исполняется в вебвью (Pyodide-песочница), мимо
              // бекенда — схему добавляем в общий список ДО фильтра, чтобы
              // пользовательский disabled-список работал и для него
              [...(Array.isArray(t) ? t : []), CODE_RUN_SCHEMA],
              {
                // Субагенты выключены — схема subagent_run не отдаётся модели
                removeSubagent: !subConfigRef.current.enabled,
                // Память выключена — memory_* не отдаются
                removeMemory: !memoryEnabled,
                // Инструменты, скрытые пользователем из этой задачи
                disabled: current?.disabledTools,
              },
            ),
          )
          .catch(() => undefined)
      : undefined;

    // Режим плана: модель предупреждена сразу, а не после первой попытки
    if (isAgent && (current?.permissionMode ?? "ask") === "plan") {
      history.push({ role: "system", content: t("agent.planNotice") });
    }

    // Правила проекта (паттерн CLAUDE.md/.cursor/rules): AGENTS.md или
    // CLAUDE.md из корня проекта — в контекст каждой отправки
    const rulesRoot = projectRootRef.current;
    if (rulesRoot) {
      const rules = await projectRulesRead(rulesRoot).catch(() => null);
      if (rules && rules.trim() !== "") {
        history.push({
          role: "system",
          content: `${t("agent.rulesBlock")}\n\n${rules}`,
        });
      }
    }

    // Профиль пользователя: только поля с включённым share-тумблером
    // (по умолчанию выключены — принцип анонимности), см. src/userProfile.ts
    const profileBlock = buildProfileBlock();
    if (profileBlock) {
      history.push({ role: "system", content: profileBlock });
    }

    // Память проектов: краткий контекст предыдущих задач этого проекта
    // (название + первый запрос) — долгосрочное знание без лишних запросов.
    // Факты долговременной памяти — глобальны, вне зависимости от проекта
    if (memoryEnabled) {
      if (current?.projectId) {
        const mem = buildMemoryBlock(sessionsRef.current, targetId, current.projectId);
        if (mem) {
          history.push({
            role: "system",
            content: `${t("memory.systemBlock")}\n${mem}`,
          });
        }
      }
      // Бюджет инъекции (40 фактов / ~4 КБ): память не должна раздувать
      // каждый запрос; остальное модель найдёт через memory_recall
      const facts = await memoryList().catch(() => [] as MemoryFact[]);
      const lines: string[] = [];
      let budget = 4096;
      for (const f of facts) {
        const line = `- ${f.text}`;
        if (lines.length >= 40 || line.length > budget) break;
        budget -= line.length;
        lines.push(line);
      }
      if (lines.length > 0) {
        history.push({
          role: "system",
          content: `${t("memory.factsBlock")}\n${lines.join("\n")}`,
        });
      }
      if (isAgent) {
        history.push({ role: "system", content: t("memory.hintAgent") });
      }
    }

    // База знаний (RAG): база привязана к задаче — локальный FTS-поиск по
    // документам (kb.rs, SQLite в appdata) подмешивает релевантные фрагменты
    // в контекст. Файлы никуда не уходят — модели едет только выжимка
    if (current?.kbId && text.trim() !== "") {
      const hits = await kbQuery(current.kbId, text, 6).catch(() => []);
      if (hits.length > 0) {
        const block = hits
          .map((h, i) => `[${i + 1}] ${h.docTitle}\n${h.text}`)
          .join("\n\n");
        history.push({
          role: "system",
          content: `${t("kb.contextBlock")}\n\n${block}`,
        });
      }
    }

    // План задач: подсказка модели в агентном режиме — инструмент plan_update
    // доступен, виджет Progress в чате отражает статусы задач
    if (isAgent) {
      history.push({
        role: "system",
        content: [
          "План задач: инструмент plan_update показывает пользователю список задач с прогрессом.",
          "При многошаговой задаче сразу вызови plan_update со всем списком задач (status: pending).",
          "Начав задачу — поставь ей status in_progress, завершив — done; меняй статусы после каждого шага.",
          "Задач максимум 12, формулировки короткие и конкретные (глагол + объект).",
          "Полный список передавай каждый раз: вызов plan_update целиком заменяет предыдущий план.",
          "Пользователь может отправлять корректирующие сообщения во время работы — они появляются как user-сообщения между твоими раундами. Учитывай их и корректируй курс.",
          "Инструмент ask_user задаёт пользователю блокирующий вопрос с вариантами ответа. Используй его ТОЛЬКО когда решение действительно за пользователем (объём работы, выбор подхода, компромиссы) и ответ меняет твои дальнейшие действия; не спрашивай о том, что можно узнать самому, о тривиальных вещах с очевидным дефолтом и о разрешении продолжать. Максимум один-два вопроса за задачу.",
        ].join(" "),
      });
    }

    // Stop/Hard Limit могли сработать, пока собирался контекст (хуки, память,
    // KB — всё это await): не стартуем стрим впустую
    if (abortedRef.current.has(requestId)) return finalize();

    // ---------- Одиночный режим: один стрим, без инструментов ----------
    if (!isAgent) {
      const assistantId = uid();
      streamingRef.current.set(requestId, assistantId);
      setStreamingAssistantId(assistantId);
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      // Флаг «провайдер отдал хоть что-то»: пустой 200-ответ (image-модель
      // в текстовом чате и т.п.) больше не исчезает молча — на карточке
      // появляется внятная ошибка с диагностированной моделью
      let gotAny = false;
      try {
        await chatWithRetry({
          requestId,
          baseUrl: apiSettings.base_url,
          apiKey: apiSettings.api_key,
          model: apiSettings.model,
          fallbackModel: apiSettings.fallback_model || undefined,
          onFallback: (fb) => {
            // Бейдж «переключено на X»: на карточке — фактическая модель
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId
                          ? { ...m, model: fb, switchedTo: fb }
                          : m,
                      ),
                    }
                  : s,
              ),
            );
          },
          reasoningEffort: effortRef.current,
          messages: history,
          onDelta: (delta) => {
            gotAny = true;
            appendTo(assistantId, delta, "");
          },
          onThought: (thought) => {
            gotAny = true;
            appendTo(assistantId, "", thought);
          },
          onUsage: (usage) => {
            // Барьер: usage — финал сообщения; pending-дельты дренируем
            // до обработки, чтобы usage не обогнал финальный текст
            flushDeltas();
            usageAcc.prompt += usage.prompt;
            usageAcc.completion += usage.completion;
            checkHardLimit();
            // FIX: клонируем только целевую сессию, а не все сессии стора
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId ? { ...m, usage } : m,
                      ),
                    }
                  : s,
              ),
            );
          },
        });
      } catch (e) {
        setMsgError(assistantId, String(e));
      }
      if (!gotAny && !abortedRef.current.has(requestId)) {
        setMsgError(
          assistantId,
          `model: ${apiSettings.model} · base: ${apiSettings.base_url}`,
          t("err.emptyResponse"),
        );
      }
      markWorked(assistantId);
      finalize();
      return;
    }

    // ---------- Агентный цикл: модель → инструменты → модель → … ----------
    const MAX_STEPS = 25;

    // Корректирующий запрос: пользовательские поправки уходят модели
    // в начале следующего раунда — с префиксом (agent.correctionPrefix) в
    // истории для модели и отдельной карточкой (correction: true) в чате
    const injectCorrections = () => {
      const corrections = pendingCorrectionsRef.current[requestId];
      if (!corrections?.length) return;
      delete pendingCorrectionsRef.current[requestId];
      setPendingCorrections((prev) => {
        if (!(requestId in prev)) return prev;
        const { [requestId]: _drop, ...rest } = prev;
        return rest;
      });
      for (const c of corrections) {
        history.push({ role: "user", content: t("agent.correctionPrefix") + c });
        pushMessage({ id: uid(), role: "user", content: c, correction: true });
      }
    };

    const askConfirm = (call: ToolCallInfo) =>
      new Promise<"once" | "always" | "deny">((resolve) => {
        openInteraction(
          { id: uid(), kind: "confirm", requestId, call },
          (r) => resolve(r.kind === "confirm" ? r.decision : "deny"),
        );
        // Пользователь может быть в другом приложении — уведомить о запросе
        void notifyTaskDone(
          notifyPrefsRef.current,
          t("notify.confirmTitle"),
          notifyMeta(activeSessionRef.current),
          activeSessionRef.current?.title ?? "",
        );
      });

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (abortedRef.current.has(requestId)) return finalize();
      // Поправки, накопившиеся за прошлый шаг, попадают модели до нового запроса
      injectCorrections();

      const assistantId = uid();
      // Своя точка отсчёта на шаг: workedMs от старта ПРОГОНА суммировался
      // в groupTurns-карточке квадратично (11 шагов ~84с показывали 646с)
      const stepStartedAt = Date.now();
      streamingRef.current.set(requestId, assistantId);
      setStreamingAssistantId(assistantId);
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      setTyping(true);
      setActivity(t("activity.thinking"));

      const toolCallsHolder: { calls: ToolCallInfo[] | null } = { calls: null };
      // Текст, отстрименный до вызова инструментов, — попадёт в историю
      // вместе с tool_calls, иначе модель «забывает» то, что уже написала
      let streamedText = "";
      // Флаг «провайдер отдал хоть что-то»: пустой 200-ответ не исчезает
      // молча — на карточке появляется ошибка с диагностированной моделью
      let gotAny = false;
      // Thinking-блок Anthropic (текст+подпись+redacted): нужен и в истории
      // цикла, и на карточке сообщения. Holder-объект: TS не видит
      // присваивание в колбэке и сужает let до never (как calls выше)
      const thinkingHolder: {
        block: { thinking: string; signature: string; redacted: string[] } | null;
      } = { block: null };
      let failed = false;
      try {
        await chatWithRetry({
          requestId,
          baseUrl: apiSettings.base_url,
          apiKey: apiSettings.api_key,
          model: apiSettings.model,
          fallbackModel: apiSettings.fallback_model || undefined,
          onFallback: (fb) => {
            // Бейдж «переключено на X»: на карточке — фактическая модель
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId
                          ? { ...m, model: fb, switchedTo: fb }
                          : m,
                      ),
                    }
                  : s,
              ),
            );
          },
          reasoningEffort: effortRef.current,
          provider: apiSettings.provider,
          messages: history,
          tools,
          onDelta: (delta) => {
            gotAny = true;
            streamedText += delta;
            appendTo(assistantId, delta, "");
          },
          onThought: (thought) => {
            gotAny = true;
            appendTo(assistantId, "", thought);
          },
          onThinkingBlock: (block) => {
            // Барьер: дельты мысли обязаны попасть в стор до закрытого блока
            flushDeltas();
            thinkingHolder.block = block;
            // Подпись/redacted thinking-блока Anthropic: без них блок
            // нельзя вернуть в историю на следующем шаге цикла
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId
                          ? {
                              ...m,
                              thoughtSignature: block.signature || undefined,
                              thoughtRedacted: block.redacted.length ? block.redacted : undefined,
                            }
                          : m,
                      ),
                    }
                  : s,
              ),
            );
          },
          onUsage: (usage) => {
            // Барьер: usage закрывает раунд — дельты дренируем до обработки,
            // иначе финальный текст раунда догоняет после usage
            flushDeltas();
            usageAcc.prompt += usage.prompt;
            usageAcc.completion += usage.completion;
            checkHardLimit();
            // FIX: клонируем только целевую сессию, а не все сессии стора
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId ? { ...m, usage } : m,
                      ),
                    }
                  : s,
              ),
            );
          },
          onToolCalls: (calls) => {
            // Кривой провайдер может прислать пустой массив с
            // finish_reason:"tool_calls" — трактуем как «вызовов нет»,
            // иначе calls[0].name кидает TypeError внутри слушателя события
            if (calls.length === 0) return;
            // Сначала сброс буфера, чтобы tool-calls не обогнали текст
            flushDeltas();
            toolCallsHolder.calls = calls;
            setActivity(
              t("activity.toolCall", {
                name:
                  calls.length === 1
                    ? (calls[0]?.name ?? "?")
                    : `${calls[0]?.name ?? "?"} +${calls.length - 1}`,
              }),
            );
            // FIX: клонируем только целевую сессию, а не все сессии стора
            setSessions((prev) =>
              prev.map((s) =>
                s.id === targetId
                  ? {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === assistantId ? { ...m, toolCalls: calls } : m,
                      ),
                    }
                  : s,
              ),
            );
          },
        });
      } catch (e) {
        failed = true;
        setMsgError(assistantId, String(e));
      }
      setTyping(false);
      markWorked(assistantId, stepStartedAt);

      // Пустой 200-ответ (image-модель в текстовом чате и т.п.) — внятная
      // ошибка вместо молча исчезнувшей карточки
      if (
        !failed &&
        !gotAny &&
        !abortedRef.current.has(requestId) &&
        !limitHitRef.current
      ) {
        setMsgError(
          assistantId,
          `model: ${apiSettings.model} · base: ${apiSettings.base_url}`,
          t("err.emptyResponse"),
        );
      }

      // Нет вызовов инструментов — обычный ответ, цикл завершён
      const toolCalls = toolCallsHolder.calls;
      if (failed || !toolCalls || toolCalls.length === 0) return finalize();
      if (abortedRef.current.has(requestId)) return finalize();

      // Вызовы инструментов в истории как assistant.tool_calls;
      // отстрименный до вызова текст не теряется. Thinking-блок Anthropic —
      // первым: Messages API требует его для хода с tool_use
      history.push({
        role: "assistant",
        content: streamedText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
        ...(thinkingHolder.block &&
        (thinkingHolder.block.signature || thinkingHolder.block.redacted.length)
          ? {
              thinking: {
                thinking: thinkingHolder.block.thinking,
                signature: thinkingHolder.block.signature,
                redacted: thinkingHolder.block.redacted,
              },
            }
          : {}),
      });

      // Исполнение инструментов: режим разрешений задачи определяет,
      // что исполняется сразу, что требует подтверждения, а что блокировано
      const permMode =
        sessionsRef.current.find((s) => s.id === targetId)?.permissionMode ??
        "ask";

      const execTool = (name: string, args: string) => {
        setActivity(t("activity.toolRun", { name }));
        // code_run: локальная Pyodide-песочница (Worker без доступа к IPC и
        // диску) — мимо бекенда и perm-слоя. Не мутирующий: код не трогает
        // ФС/процессы, disabled-гардал применён выше фильтром схем
        if (name === "code_run") {
          let code = "";
          try {
            code = (JSON.parse(args) as { code?: string }).code ?? "";
          } catch {
            code = args; // модель прислала не-JSON — исполняем как есть
          }
          return runPython(code).then((r) =>
            JSON.stringify({
              ok: r.ok,
              stdout: r.stdout,
              stderr: r.stderr,
              ...(r.error ? { error: r.error } : {}),
              ...(r.result ? { result: r.result } : {}),
            }),
          );
        }
        // Первый browser_*-инструмент прогона — открыть панель просмотра
        if (
          name.startsWith("browser_") &&
          name !== "browser_close" &&
          browserAutoPanelRef.current
        ) {
          setBrowserPanelOpen(true);
        }
        // requestId связывает вызов с прогоном: Stop убьёт процесс немедленно;
        // чёрный список задачи — сервер отклонит скрытый инструмент (субагенты
        // наследуют список, не расширяя набор)
        const disabledTools = sessionsRef.current.find(
          (s) => s.id === targetId,
        )?.disabledTools;
        return runTool(name, args, requestId, disabledTools);
      };

      // Чекпоинт проекта перед первой правкой прогона: снимок файлов,
      // подпись — последний запрос пользователя
      const ensureCheckpoint = async () => {
        if (runCheckpointRef.current) return;
        runCheckpointRef.current = true;
        const root = projectRootRef.current;
        if (!root) return;
        const sess = sessionsRef.current.find((s) => s.id === targetId);
        const lastUser = [...(sess?.messages ?? [])]
          .reverse()
          .find((m) => m.role === "user");
        const label = (lastUser?.content ?? "").replace(/\s+/g, " ").trim();
        // Чекпоинт — страховка, а не условие работы: сбой (диск, права, битый
        // root) раньше вылетал из handleSend, finalize не вызывался, и движок
        // клинился навечно. Теперь — тост и работа продолжается
        let cp: Awaited<ReturnType<typeof checkpointSave>> | null = null;
        try {
          // Opt-in git-журнал (блок 12 шаг 4): преф в поповере чекпоинтов
          cp = await checkpointSave(
            root,
            label,
            localStorage.getItem("haloui-checkpoints-git") === "1",
          );
        } catch (e) {
          addToast(`checkpoint failed: ${e}`);
        }
        if (cp) {
          // Запоминаем снимок прогона: источник живого диффа для Review
          // (покрывает и правки мимо fs_write — shell и т.п.)
          lastCheckpointRef.current = { root, id: cp.id };
          // Плавающее уведомление вместо строки в чате
          addToast(t("cp.created"));
        }
        // Git-автокоммит (Aider-паттерн, opt-in): состояние репо откатываемо
        // через git независимо от файловых чекпоинтов; best-effort — не репо,
        // нет git или identity — бекенд тихо пропускает
        if (localStorage.getItem("haloui-git-autocommit") === "1") {
          void gitAutocommit(
            root,
            `nocturn: auto-checkpoint — ${label || "agent run"}`,
          ).catch(() => {});
        }
      };

      // Субагенты: батч из ответа модели запускается параллельно
      // (лимит maxParallel), переполнение — очередью
      const subCalls = toolCalls.filter((c) => c.name === "subagent_run");

      // План задач: plan_update исполняется на фронтенде (не filesystem/proc
      // операция) — парсим tasks, валидируем и обновляем виджет Progress
      // в чате; в runTool такие вызовы не уходят. Обрабатываем первыми,
      // чтобы панель отразила план до запуска остальных инструментов.
      const planCalls = toolCalls.filter((c) => c.name === "plan_update");
      for (const call of planCalls) {
        if (abortedRef.current.has(requestId)) return finalize();
        setActivity(t("activity.toolRun", { name: call.name }));
        let planContent: string;
        try {
          const parsed = JSON.parse(call.arguments) as { tasks?: unknown };
          const raw = parsed.tasks;
          // Валидация: массив объектов; элемент пропускается, если title
          // не непустая строка или status вне enum
          const tasks: PlanTask[] = Array.isArray(raw)
            ? raw
                .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
                .map((t) => ({
                  title: typeof t.title === "string" ? t.title.trim() : "",
                  status: t.status as PlanTask["status"],
                }))
                .filter(
                  (t) =>
                    t.title.length > 0 &&
                    (t.status === "pending" ||
                      t.status === "in_progress" ||
                      t.status === "done"),
                )
            : [];
          if (!Array.isArray(raw)) {
            planContent =
              "error: invalid plan_update arguments — tasks array required";
          } else {
            applyPlan(targetId, tasks);
            planContent = JSON.stringify({ ok: true, tasks: tasks.length });
          }
        } catch (e) {
          planContent = `plan error: ${e}`;
        }
        pushMessage({
          id: uid(),
          role: "tool",
          content: planContent,
          toolCallId: call.id,
          toolName: call.name,
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: planContent,
        });
      }

      // Вопросы пользователю (ask_user): карточка в чате, цикл блокируется
      // до ответа; результат возвращается модели tool result'ом
      const askCalls = toolCalls.filter((c) => c.name === "ask_user");
      for (const call of askCalls) {
        if (abortedRef.current.has(requestId)) return finalize();
        setActivity(t("activity.toolRun", { name: call.name }));

        const finishAsk = (content: string) => {
          pushMessage({
            id: uid(),
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
          });
          history.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content,
          });
        };

        // Валидация: вопрос + 2–4 опции с label, иначе — ошибка модели
        let parsedSpec: AskUserSpec | null = null;
        try {
          const parsed = JSON.parse(call.arguments) as Partial<AskUserSpec>;
          const options = Array.isArray(parsed.options)
            ? parsed.options
                .filter(
                  (o): o is AskUserSpec["options"][number] =>
                    !!o && typeof o.label === "string" && o.label.trim() !== "",
                )
                .slice(0, 4)
            : [];
          if (
            typeof parsed.question === "string" &&
            parsed.question.trim() !== "" &&
            options.length >= 2
          ) {
            parsedSpec = {
              question: parsed.question,
              header:
                typeof parsed.header === "string" && parsed.header.trim()
                  ? parsed.header.slice(0, 24)
                  : undefined,
              options,
              multiSelect: parsed.multiSelect === true,
            };
          }
        } catch {
          parsedSpec = null;
        }
        if (!parsedSpec) {
          finishAsk(
            "error: ask_user requires question (non-empty string) and options (2-4 items, each with a label)",
          );
          continue;
        }
        const spec: AskUserSpec = parsedSpec;

        // Первый вопрос шага живёт на сообщении шага (assistantId),
        // дополнительные (редкий батч) — на отдельных сообщениях-карточках
        const askMsgId = call === askCalls[0] ? assistantId : uid();
        if (call === askCalls[0]) {
          // C6: клонируем только целевую сессию — {...s} на ВСЕ сессии и их
          // массивы сообщений обнуляло reference-равенство всего стора
          // (ломало memo карточек/сайдбара и помечало всё грязным для сейва)
          setSessions((prev) =>
            prev.map((s) =>
              s.id === targetId
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === assistantId
                        ? { ...m, ask: { ...spec, answer: null } }
                        : m,
                    ),
                  }
                : s,
            ),
          );
        } else {
          pushMessage({
            id: askMsgId,
            role: "assistant",
            content: "",
            ask: { ...spec, answer: null },
          });
        }
        const answer = await new Promise<
          { answers: string[]; custom?: string } | "timeout" | null
        >((resolve) => {
          const interactionId = uid();
          openInteraction(
            { id: interactionId, kind: "ask", requestId, msgId: askMsgId, spec },
            (r) =>
              resolve(
                r.kind === "ask"
                  ? r.answer
                  : r.kind === "ask-timeout"
                    ? "timeout"
                    : null,
              ),
          );
          // Автопродолжение: вопрос без ответа N минут — продолжаем сами.
          // Таймер отменяется в finalize: ответили раньше — он больше не нужен
          if (askAutoContinue) {
            if (askTimerRef.current !== null) window.clearTimeout(askTimerRef.current);
            askTimerRef.current = window.setTimeout(() => {
              askTimerRef.current = null;
              if (interactionsRef.current.has(interactionId)) {
                resolveInteraction(interactionId, { kind: "ask-timeout" });
              }
            }, ASK_AUTO_CONTINUE_MS);
          }
          // Пользователь мог уйти в другое приложение — уведомить
          void notifyTaskDone(
            notifyPrefsRef.current,
            t("ask.notifyTitle"),
            notifyMeta(activeSessionRef.current),
            activeSessionRef.current?.title ?? "",
          );
        });
        setActivity(null);

        if (answer === 'timeout') {
          // Автопродолжение: карточка закрывается, модель получает указание
          // продолжить самостоятельно. C6: клонируем только целевую сессию
          setSessions((prev) =>
            prev.map((s) =>
              s.id === targetId
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === askMsgId && m.ask
                        ? { ...m, ask: { ...m.ask, cancelled: true } }
                        : m,
                    ),
                  }
                : s,
            ),
          );
          finishAsk(
            `no answer within ${ASK_AUTO_CONTINUE_MS / 60_000} minutes — continue autonomously using your best judgment`,
          );
          continue;
        }

        if (!answer || abortedRef.current.has(requestId)) {
          // Закрыто без ответа (Stop): карточка помечается, модель получает отказ.
          // C6: клонируем только целевую сессию
          setSessions((prev) =>
            prev.map((s) =>
              s.id === targetId
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === askMsgId && m.ask
                        ? { ...m, ask: { ...m.ask, cancelled: true } }
                        : m,
                    ),
                  }
                : s,
            ),
          );
          finishAsk("user did not answer (question cancelled)");
          if (abortedRef.current.has(requestId)) return finalize();
          continue;
        }
        finishAsk(JSON.stringify({ ok: true, ...answer }));
      }
      // Статус фоновых субагентов: реестр на фронте, full report по id
      const statusCalls = toolCalls.filter((c) => c.name === "subagent_status");
      for (const call of statusCalls) {
        if (abortedRef.current.has(requestId)) return finalize();
        let content: string;
        let parsedId = "";
        try {
          const parsed = JSON.parse(call.arguments) as { id?: string };
          parsedId = (parsed.id ?? "").trim();
        } catch {
          parsedId = "";
        }
        // Только субагенты ЭТОЙ задачи: реестр общий на все сессии, и модель
        // раньше видела (и читала отчёты) чужих фоновых задач
        const reg = new Map<string, BgSubTask>(
          [...bgRegistryRef.current].filter(([, b]) => b.sessionId === targetId),
        );
        if (parsedId) {
          const t = reg.get(parsedId);
          if (!t) {
            content = `no background subagent "${parsedId}"`;
          } else if (t.status === "running") {
            const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
            content = `${parsedId} (${t.roleName}) still running — ${elapsed}s elapsed.\nTask: ${t.task.slice(0, 300)}`;
          } else {
            content = `${parsedId} [${t.status}]\n${t.report ?? "(no report)"}`;
          }
        } else if (reg.size === 0) {
          content = "no background subagents";
        } else {
          content = [...reg.values()]
            .map((t) => {
              const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
              return `${t.id} [${t.status}] ${t.roleName} (${elapsed}s): ${t.task.slice(0, 150)}`;
            })
            .join("\n");
        }
        pushMessage({
          id: uid(),
          role: "tool",
          content,
          toolCallId: call.id,
          toolName: call.name,
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content,
        });
      }

      const runOneSubagent = async (call: ToolCallInfo): Promise<void> => {
        let subContent: string;
        // FIX: машиный статус tool-результата (см. Message.status) — рендер
        // больше не распознаёт отказ сравнением с локализованной строкой
        let subStatus: Message["status"];
        try {
          const parsed = JSON.parse(call.arguments) as {
            role?: string;
            task?: string;
            background?: boolean;
          };
          const role: SubagentRole =
            mergeRoles(subConfigRef.current.roles).find(
              (r) => r.id === parsed.role,
            ) ?? SUBAGENT_ROLES[0]
            // SUBAGENT_ROLES непустой по построению; строгие индексы требуют
            // явности — последний фолбэк даёт валидную безопасную роль
            ?? { id: "researcher", name: "Researcher", tools: null, maxSteps: 8, systemPrompt: "" };
          const task = (parsed.task ?? "").trim();
          if (!task) {
            subContent = "error: empty task";
          } else if (permMode === "plan") {
            // FIX [SECURITY]: субагент исполнялся до permission-цикла — в
            // plan-режиме его fs/shell/mcp-инструменты работали мимо прав
            // задачи. План не трогает систему: запуск субагента блокируется
            // целиком, как mutating-вызов в основном цикле.
            subContent = t("agent.planBlocked");
            subStatus = "denied";
            setSubRuns((prev) => ({
              ...prev,
              [call.id]: {
                roleId: role.id,
                roleName: role.name,
                task: task.split("\n")[0],
                thought: "",
                tools: [],
                report: subContent,
              },
            }));
          } else if (
            // FIX [SECURITY]: подтверждение запуска привязано и к режиму прав
            // задачи, а не только к тумблеру autonomous: в ask/edit запуск
            // субагента — mutating-действие (его инструменты исполняются без
            // поинструментных подтверждений фронтенда).
            (permMode !== "full" || !subConfigRef.current.autonomous) &&
            (await askConfirm(call)) === "deny"
          ) {
            // Автономность выключена: запуск субагента требует подтверждения
            // как mutating-инструмент; отказ пишется в отчёт прогона.
            // Машинный статус обязателен — иначе карточка рендерится как
            // успешная, вопреки контракту "denied" (см. status: subStatus)
            subContent = "user denied subagent run";
            subStatus = "denied";
            setSubRuns((prev) => ({
              ...prev,
              [call.id]: {
                roleId: role.id,
                roleName: role.name,
                task: task.split("\n")[0],
                thought: "",
                tools: [],
                report: subContent,
              },
            }));
          } else {
            setActivity(t("activity.subagent", { role: role.name }));
            setSubRuns((prev) => ({
              ...prev,
              [call.id]: {
                roleId: role.id,
                roleName: role.name,
                task: task.split("\n")[0],
                thought: "",
                tools: [],
                report: null,
              },
            }));
            // ── Фоновый запуск: вызов возвращается сразу, цикл главного
            // агента продолжается; отчёт дописывается в сессию по завершении ──
            if (parsed.background === true) {
              bgCounterRef.current += 1;
              const bgId = `bg-${bgCounterRef.current}`;
              bgRegistryRef.current.set(bgId, {
                id: bgId,
                roleId: role.id,
                roleName: role.name,
                task,
                sessionId: targetId,
                startedAt: Date.now(),
                status: "running",
                report: null,
                runId: requestId,
                cancelled: false,
              });
              // Реестр не растёт бесконечно: храним последние 50 записей,
              // вытесняя самые старые завершённые
              if (bgRegistryRef.current.size > 50) {
                for (const [k, v] of bgRegistryRef.current) {
                  if (bgRegistryRef.current.size <= 50) break;
                  if (v.status !== "running") bgRegistryRef.current.delete(k);
                }
              }
              const toolMsgId = uid();
              subContent = `Subagent ${role.name} started in background (id: ${bgId}). Continue your work — the report will be appended to this conversation when it finishes; check progress with subagent_status {"id": "${bgId}"}.`;
              pushMessage({
                id: toolMsgId,
                role: "tool",
                content: subContent,
                toolCallId: call.id,
                toolName: call.name,
              });
              history.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.name,
                content: subContent,
              });
              // Отсоединённый прогон: живые дельты — в ту же карточку, что
              // у форграунда; завершение патчит tool-сообщение в сессии
              void (async () => {
                const onStep = (st: SubagentStep) => {
                  if (st.type === "thought") {
                    deltaBuf.appendSubThought(call.id, st.text);
                    scheduleFlush();
                    return;
                  }
                  flushDeltas();
                  patchSubRun(call.id, (r) => {
                    if (st.type === "tool")
                      return { ...r, tools: [...r.tools, st.text], thought: "" };
                    return { ...r, report: st.text };
                  });
                };
                const entry = bgRegistryRef.current.get(bgId);
                try {
                  const report = await runSubagent({
                    role,
                    task,
                    baseUrl: apiSettings.base_url,
                    apiKey: apiSettings.api_key,
                    model: role.model || apiSettings.model,
                    onStep,
                    onUsage: (u) => {
                      usageAcc.prompt += u.prompt;
                      usageAcc.completion += u.completion;
                      checkHardLimit();
                    },
                    effort: effortRef.current,
                    // abortedRef чистится finalize'ом родителя, а фоновый
                    // субагент его переживает — поэтому свой флаг entry.cancelled
                    aborted: () =>
                      abortedRef.current.has(requestId) || !!entry?.cancelled,
                    runRequestId: requestId,
                    disabledTools: sessionsRef.current
                      .find((s) => s.id === targetId)
                      ?.disabledTools,
                  });
                  const wasCancelled = !!entry?.cancelled;
                  if (entry) {
                    entry.status = wasCancelled ? "cancelled" : "done";
                    entry.report = report;
                  }
                  const content = `[${role.name} • background ${bgId} — ${wasCancelled ? "cancelled" : "completed"}]\n${report}`;
                  if (!wasCancelled) addToast(t("sub.bgDone", { s: role.name }));
                  // Хвостовые дельты перед патчем сообщения
                  flushDeltas();
                  setSessions((prev) =>
                    prev.map((s) =>
                      s.id === targetId
                        ? {
                            ...s,
                            messages: s.messages.map((m) =>
                              m.id === toolMsgId ? { ...m, content } : m,
                            ),
                          }
                        : s,
                    ),
                  );
                } catch (e) {
                  if (entry) {
                    entry.status = entry.cancelled ? "cancelled" : "failed";
                    entry.report = `error: ${e}`;
                  }
                  setSessions((prev) =>
                    prev.map((s) =>
                      s.id === targetId
                        ? {
                            ...s,
                            messages: s.messages.map((m) =>
                              m.id === toolMsgId
                                ? { ...m, content: `background ${bgId} failed: ${e}` }
                                : m,
                            ),
                          }
                        : s,
                    ),
                  );
                }
                // Локальная история текущего хода: обновить запись, если ход
                // ещё жив (после finalize массив мёртв — обновление no-op)
                // Расход, накопленный ПОСЛЕ finalize родителя (его finalize
                // уже записал журнал), иначе он нигде не учитывался
                if (runFinished) logUsageDelta(0);
                const hEntry = history.find((h) => h.tool_call_id === call.id);
                if (hEntry && entry?.report) {
                  hEntry.content = `[${role.name} • background ${bgId} — ${entry.status === "done" ? "completed" : entry.status}]\n${entry.report}`;
                }
                const subTimerId = window.setTimeout(() => {
                  subRunTimersRef.current.delete(subTimerId);
                  setSubRuns((prev) => {
                    if (!(call.id in prev)) return prev;
                    const { [call.id]: _done, ...rest } = prev;
                    return rest;
                  });
                }, 30_000);
                subRunTimersRef.current.add(subTimerId);
              })();
              return;
            }
            const onStep = (st: SubagentStep) => {
              // Thought-дельты субагента батчим так же, как основной стрим.
              // Текст/инструмент — после принудительного сброса, иначе
              // отложенный flush вернёт стёртый инструментальным шагом thought
              if (st.type === "thought") {
                deltaBuf.appendSubThought(call.id, st.text);
                scheduleFlush();
                return;
              }
              flushDeltas();
              patchSubRun(call.id, (r) => {
                if (st.type === "tool")
                  return { ...r, tools: [...r.tools, st.text], thought: "" };
                return { ...r, report: st.text };
              });
            };
            const report = await runSubagent({
              role,
              task,
              baseUrl: apiSettings.base_url,
              apiKey: apiSettings.api_key,
              model: role.model || apiSettings.model,
              onStep,
              // Расход субагента — в общую копилку Hard Limit задачи
              onUsage: (u) => {
                usageAcc.prompt += u.prompt;
                usageAcc.completion += u.completion;
                checkHardLimit();
              },
              effort: effortRef.current,
              aborted: () => abortedRef.current.has(requestId),
              // C11: requestId прогона — Stop прерывает и стрим субагента
              // (chat_abort по его sub-* id), и его исполняющиеся инструменты
              runRequestId: requestId,
              // Чёрный список задачи наследуется субагентом
              disabledTools: sessionsRef.current.find((s) => s.id === targetId)
                ?.disabledTools,
            });
            subContent = `[${role.name}]
${report}`;
          }
        } catch (e) {
          subContent = `subagent error: ${e}`;
        }
        // Завершённый прогон: убрать из монитора через 30с. id сохраняется
        // и гасится в cleanup хука (ниже)
        const subTimerId = window.setTimeout(() => {
          subRunTimersRef.current.delete(subTimerId);
          setSubRuns((prev) => {
            if (!(call.id in prev)) return prev;
            const { [call.id]: _done, ...rest } = prev;
            return rest;
          });
        }, 30_000);
        subRunTimersRef.current.add(subTimerId);
        pushMessage({
          id: uid(),
          role: "tool",
          content: subContent,
          toolCallId: call.id,
          toolName: call.name,
          status: subStatus, // FIX: "denied" доезжает до рендера машинно
        });
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: subContent,
        });
      };
      // Workflow-оркестратор v1 (блок 12 шаг 6): последовательные шаги-
      // субагенты, выход шага — переменная {{id}} для последующих промтов.
      // Роли — из mergeRoles (свои роли пользователя тоже доступны)
      const runOneWorkflow = async (call: ToolCallInfo): Promise<void> => {
        const done = (content: string) => {
          flushDeltas();
          pushMessage({
            id: uid(),
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
          });
          history.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content,
          });
        };
        let def: WorkflowDef;
        try {
          const parsed = JSON.parse(call.arguments) as { workflow?: unknown };
          const roles = mergeRoles(subConfigRef.current.roles);
          const wf = parseWorkflow(parsed.workflow, new Set(roles.map((r) => r.id)));
          if (!wf.ok) {
            done(`workflow error: ${wf.error}`);
            return;
          }
          def = wf.def;
        } catch (e) {
          done(`workflow error: bad JSON arguments: ${e}`);
          return;
        }
        if (permMode === "plan") {
          // Как у субагентов (FIX [SECURITY]): шаги исполняют инструменты —
          // в plan-режиме сценарий блокируется целиком
          done(t("agent.planBlocked"));
          return;
        }
        if (abortedRef.current.has(requestId)) {
          done("workflow aborted before start");
          return;
        }
        const roles = mergeRoles(subConfigRef.current.roles);
        const vars: Record<string, string> = {};
        const journal: string[] = [
          `workflow "${def.name}" — ${def.steps.length} step(s)`,
        ];
        for (let i = 0; i < def.steps.length; i++) {
          if (abortedRef.current.has(requestId)) {
            journal.push(`— aborted by user at step ${i + 1}/${def.steps.length}`);
            break;
          }
          const step = def.steps[i]!;
          setActivity(
            t("activity.toolCall", {
              name: `workflow:${step.id} ${i + 1}/${def.steps.length}`,
            }),
          );
          const role: SubagentRole =
            roles.find((r) => r.id === step.role) ??
            roles.find((r) => r.id === "coder") ??
            roles[0] ??
            // SUBAGENT_ROLES непустой по построению; строгие индексы требуют
            // явности — фолбэк даёт валидную безопасную роль
            SUBAGENT_ROLES[0] ??
            { id: "researcher", name: "Researcher", tools: null, maxSteps: 8, systemPrompt: "" };
          const task = interpolate(step.prompt, vars);
          try {
            const report = await runSubagent({
              role,
              task,
              baseUrl: apiSettings.base_url,
              apiKey: apiSettings.api_key,
              model: role.model || apiSettings.model,
              // Расход шагов — в общую копилку Hard Limit задачи
              onUsage: (u) => {
                usageAcc.prompt += u.prompt;
                usageAcc.completion += u.completion;
                checkHardLimit();
              },
              effort: effortRef.current,
              aborted: () => abortedRef.current.has(requestId),
              runRequestId: requestId,
              disabledTools: sessionsRef.current.find((s) => s.id === targetId)
                ?.disabledTools,
            });
            vars[step.id] = report;
            // Журнал не тащит полные отчёты в контекст модели: кап на шаг
            const short = report.length > 1500 ? report.slice(0, 1499) + "…" : report;
            journal.push(
              `— [${i + 1}/${def.steps.length}] ${step.id} (${role.name}): ok\n${short}`,
            );
          } catch (e) {
            const errText = `error: ${e}`;
            if (step.continueOnError) {
              vars[step.id] = errText;
              journal.push(
                `— [${i + 1}/${def.steps.length}] ${step.id}: ${errText} (continue)`,
              );
              continue;
            }
            journal.push(
              `— [${i + 1}/${def.steps.length}] ${step.id}: ${errText} — scenario stopped`,
            );
            done(journal.join("\n"));
            return;
          }
        }
        done(journal.join("\n"));
      };
      if (subCalls.length > 0) {
        const limit = Math.max(1, subConfigRef.current.maxParallel);
        if (subConfigRef.current.autonomous) {
          await Promise.all(subCalls.slice(0, limit).map(runOneSubagent));
          for (const call of subCalls.slice(limit)) await runOneSubagent(call);
        } else {
          // Без автономности подтверждение показывает один запрос за раз
          // (pendingConfirm завязан на один resolver) — батч превращается
          // в очередь с подтверждением каждого запуска
          for (const call of subCalls) await runOneSubagent(call);
        }
      }
      const wfCalls = toolCalls.filter((c) => c.name === "workflow_run");
      for (const call of wfCalls) {
        // Тот же FIX [SECURITY], что у subagent_run выше: шаги сценария
        // исполняют инструменты без поинструментных подтверждений фронтенда,
        // поэтому сам запуск сценария в ask/edit — mutating-действие.
        // Раньше сценарий шёл молча, пока каждый обычный тул спрашивал
        if (
          (permMode !== "full" || !subConfigRef.current.autonomous) &&
          (await askConfirm(call)) === "deny"
        ) {
          pushMessage({
            id: uid(),
            role: "tool",
            content: "user denied workflow run",
            toolCallId: call.id,
            toolName: call.name,
            status: "denied",
          });
          history.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: "user denied workflow run",
          });
          continue;
        }
        await runOneWorkflow(call);
      }

      // Скриншоты шага копим и отдаём модели ПОСЛЕ всех tool-результатов:
      // user-сообщение между tool-сообщениями рвёт их последовательность,
      // и OpenAI-совместимые API отвечают 400
      const shots: string[] = [];
      for (const call of toolCalls) {
        if (abortedRef.current.has(requestId)) return finalize();
        if (call.name === "subagent_run") continue; // уже исполнены выше
        if (call.name === "subagent_status") continue; // уже исполнены выше
        if (call.name === "workflow_run") continue; // уже исполнены выше (фронтенд)
        if (call.name === "plan_update") continue; // уже исполнены выше (фронтенд)
        if (call.name === "ask_user") continue; // уже исполнены выше (фронтенд)

        // Разрешения внутри прогона ограничены allowlist роли — главный
        // агент уже принял решение о запуске

        // MCP-инструменты тоже трогают внешние системы — подтверждаем по умолчанию.
        // Browser/Computer: чтение и скриншоты безопасны, действия — подтверждаются.
        // image_generate — mutating: расход API-кредита + запись файлов,
        // раньше исполнялся в Plan-режиме без всякого спроса
        const mutating =
          call.name === "shell_run" ||
          call.name === "fs_write" ||
          call.name === "fs_delete" ||
          call.name === "vault_write" ||
          call.name === "memory_save" ||
          call.name === "image_generate" ||
          call.name.startsWith("mcp__") ||
          (call.name.startsWith("browser_") &&
            call.name !== "browser_read" &&
            call.name !== "browser_screenshot") ||
          (call.name.startsWith("computer_") &&
            call.name !== "computer_screenshot");
        const session = sessionsRef.current.find((s) => s.id === targetId);
        const grantKey = allowKey(call);
        const allowed =
          mutating && (session?.allowedCommands?.includes(grantKey) ?? false);

        let result: string;
        // FIX: машиный статус результата — раньше "denied" распознавался на
        // рендере сравнением контента с локализованной строкой t("agent.denied"),
        // и смена языка перекрашивала историю инструментов
        let toolStatus: Message["status"];
        if (permMode === "plan" && mutating) {
          // Режим плана: запись и команды блокируются, модель должна
          // предъявить план, не трогая систему
          result = t("agent.planBlocked");
          toolStatus = "denied";
        } else if (
          permMode === "full" ||
          (permMode === "edit" && call.name === "fs_write") ||
          (mutating && allowed)
        ) {
          await ensureCheckpoint();
          result = await execTool(call.name, call.arguments).catch(
            (e) => `tool error: ${e}`,
          );
        } else if (mutating) {
          const decision = await askConfirm(call);
          if (decision === "deny") {
            result = t("agent.denied");
            toolStatus = "denied";
          } else {
            if (decision === "always") {
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === targetId
                    ? {
                        ...s,
                        allowedCommands: [
                          ...new Set([...(s.allowedCommands ?? []), grantKey]),
                        ],
                      }
                    : s,
                ),
              );
            }
            await ensureCheckpoint();
            result = await execTool(call.name, call.arguments).catch(
              (e) => `tool error: ${e}`,
            );
          }
        } else {
          // fs_read / fs_list — безопасны, исполняются всегда
          result = await execTool(call.name, call.arguments).catch(
            (e) => `tool error: ${e}`,
          );
        }

        // Скриншот браузера: в карточку — краткая сводка (не base64!),
        // в контекст модели — изображение user-сообщением (vision)
        let toolContent = result;
        let screenshot: { dataUrl: string; viewport: string } | null = null;
        if (
          call.name === "browser_screenshot" ||
          call.name === "computer_screenshot"
        ) {
          try {
            const parsed = JSON.parse(result) as {
              ok?: boolean;
              viewport?: string;
              width?: number;
              height?: number;
              dataUrl?: string;
            };
            if (parsed.ok && parsed.dataUrl) {
              const size =
                parsed.viewport ??
                (parsed.width && parsed.height
                  ? `${parsed.width}x${parsed.height}`
                  : "");
              screenshot = { dataUrl: parsed.dataUrl, viewport: size };
              toolContent = `Screenshot captured (${screenshot.viewport})`;
            }
          } catch {
            // не JSON — отдаем как есть
          }
        }

        const toolMsg: Message = {
          id: uid(),
          role: "tool",
          content: toolContent,
          toolCallId: call.id,
          toolName: call.name,
          status: toolStatus, // FIX: "denied" доезжает до рендера машинно
        };
        pushMessage(toolMsg);
        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: toolContent,
        });
        if (screenshot) shots.push(screenshot.dataUrl);
      }
      if (shots.length > 0) {
        history.push({
          role: "user",
          content: shots.flatMap((dataUrl) => [
            {
              type: "text" as const,
              text: "Browser screenshot (click coordinates are taken from this image):",
            },
            { type: "image_url" as const, image_url: { url: dataUrl } },
          ]),
        });
      }
    }

    // Лимит шагов
    pushMessage({ id: uid(), role: "assistant", content: t("agent.maxSteps") });
    finalize();
  };

  const handleSend = async (
    raw: string,
    attachments?: Attachment[],
    overrideTargetId?: string,
    quote?: string,
    /** Редактирование отправленного: контент заменяется, ответы после — срезаются */
    editMsgId?: string,
    /** Расход предыдущих звеньев цепочки очереди (общий бюджет Hard Limit) */
    budgetCarry?: { prompt: number; completion: number },
  ) => {
    if (!raw.trim() && (attachments ?? []).length === 0) return;

    // Guard от параллельных прогонов: движок однопоточный, второй вызов
    // (цепочка заметок, таймер автоматизаций, edit-message) перезаписывал
    // activeRunRef, и finalize первого прогона гасил индикаторы живого
    // второго. UI-пути (ChatArea) уже маршрутизируют в очередь/поправку —
    // это защита для остальных точек входа
    if (activeRunRef.current !== null) {
      return;
    }

    // C1: захват движка СРАЗУ (синхронно, до первого await): между guard'ом
    // и прежним захватом стояли await хуков SessionStart/UserPromptSubmit —
    // окно гонки, через которое второй send проходил guard и получал два
    // параллельных прогона
    const requestId = uid();
    activeRunRef.current = requestId;
    runStartedRef.current = true;
    const run: RunHandle = { requestId, finalize: null };

    try {
      await sendImpl(
        run,
        raw,
        attachments,
        overrideTargetId,
        quote,
        editMsgId,
        budgetCarry,
      );
    } catch (e) {
      // Необработанное исключение в теле прогона (диск, битые данные,
      // сбой хука/провайдера вне try): раньше finalize не вызывался,
      // activeRunRef клинился навечно и все следующие отправки молча
      // отсекались guard'ом. Показываем ошибку и доводим прогон до конца
      console.error("agent run crashed:", e);
      const assistantId = streamingRef.current.get(requestId);
      if (assistantId) setMsgError(assistantId, String(e));
      else addToast(`${t("err.generic")}: ${e}`);
      try {
        run.finalize?.();
      } catch (e2) {
        console.error("finalize failed:", e2);
      }
    } finally {
      // Страховочная сеть: finalize не был достигнут (исключение до его
      // создания) либо упал на полпути. Освобождаем движок и чистим то,
      // чем прогон владел; чужой (уже стартовавший) прогон не трогаем
      if (activeRunRef.current === requestId) {
        activeRunRef.current = null;
        setTyping(false);
        setActivity(null);
        setStreamingId((cur) => (cur === requestId ? null : cur));
        setStreamingAssistantId((cur) =>
          cur != null && streamingRef.current.get(requestId) === cur ? null : cur,
        );
        streamingRef.current.delete(requestId);
        abortedRef.current.delete(requestId);
        stoppedRef.current.delete(requestId);
        streamingTargetRef.current = null;
        cancelInteractions(requestId);
      }
    }
  };

  const handleStop = () => {
    if (!streamingId) {
      // Основной прогон уже завершён, но фоновые субагенты ещё работают —
      // Stop гасит и их (раньше остановить их было нечем)
      const sid = activeSessionRef.current?.id;
      if (sid) cancelBgSubagents({ sessionId: sid });
      return;
    }
    if (chainRunning) chainAbortRef.current = true;
    abortedRef.current.add(streamingId);
    // Реальная отмена: Rust поднимает флаг и гасит поток (и исполняющийся
    // инструмент — run_tool регистрирует флаг на время тулл-кола)
    void abortChat(streamingId).catch(() => {});
    // Фоновые субагенты этого прогона: их abort-флаг — собственный, а
    // abortedRef чистится finalize'ом родителя (гонка с поллингом)
    cancelBgSubagents({ runId: streamingId });
    // Если агент ждал подтверждения/ответа — закрываем, цикл завершится
    // (только взаимодействия этого прогона)
    cancelInteractions(streamingId);
    // Маркер «остановлено» ставит finalize ПОСЛЕ дренажа дельт — иначе
    // он попадал в середину текста; здесь только запоминаем карточку
    const msgId = streamingRef.current.get(streamingId);
    if (msgId) stoppedRef.current.set(streamingId, msgId);
    streamingRef.current.delete(streamingId);
    setStreamingId(null);
    setStreamingAssistantId(null);
    setTyping(false);
    // activeRunRef НЕ обнуляем: движок освободит finalize уходящего прогона.
    // Синхронное обнуление открывало окно, в котором автоматизация/очередь
    // стартовали новый прогон, а поздний finalize старого гасил его
    // взаимодействия и чей-то индикатор стрима
  };

  // Быстрая роль: применяется к активной задаче, если её нет — создаём
  const handleConfirmDecision = (d: "once" | "always" | "deny") => {
    // Карточка [y/n/a] показывает первое confirm-взаимодействие — его и решаем
    const pending = interactions.find((i) => i.kind === "confirm");
    if (pending) resolveInteraction(pending.id, { kind: "confirm", decision: d });
  };

  /** Ответ на вопрос агента (ask_user): пометить карточку и разбудить цикл */
  const handleAskAnswer = (
    mid: string,
    answer: { answers: string[]; custom?: string },
  ) => {
    // C6: клонируем только сессию, содержащую карточку вопроса — раньше
    // клонировались ВСЕ сессии стора на каждый ответ
    setSessions((prev) =>
      prev.map((s) =>
        s.messages.some((m) => m.id === mid)
          ? {
              ...s,
              messages: s.messages.map((m) =>
                m.id === mid && m.ask ? { ...m, ask: { ...m.ask, answer } } : m,
              ),
            }
          : s,
      ),
    );
    const pending = interactions.find((i) => i.kind === "ask" && i.msgId === mid);
    if (pending && pending.kind === "ask") {
      resolveInteraction(pending.id, { kind: "ask", answer });
    }
  };

  // streamingAssistantId — состояние (см. объявление рядом с streamingId):
  // чтение streamingRef прямо в рендере было гонкой «запись вне setState»

  return {
    handleSend,
    handleStop,
    handleSendRef,
    setStreamingId,
    setTyping,
    typing,
    activity,
    streamingId,
    streamingAssistantId,
    activeRunRef, // FIX [re-entrancy]: наружу для guard'а автоматизаций
    runStartedRef, // наружу для runChain: шаг реально стартовал?
    streamingTargetRef, // наружу: удаление/очистка задачи прерывают её прогон
    subRuns,
    queuedMsgs,
    setQueuedMsgs,
    setPendingCorrections,
    pendingCorrectionsRef,
    interactions,
    handleConfirmDecision,
    handleAskAnswer,
    chainAbortRef,
    lastCheckpointRef, // наружу: Review читает снимок прогона для живого диффа
    stopBackgroundSubagents, // наружу: остановка фоновых субагентов задачи (монитор)
  };
}
