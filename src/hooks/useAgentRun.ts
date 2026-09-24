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
  getToolSchemas,
  hooksRunEvent,
  permSet,
  runTool,
  type ApiSettings,
  type ChatMsgParam,
  type ChatUsage,
} from "../api";
// FIX: trimContextWindow заменяет голый .slice(-30), который разрывал
// пары «assistant tool_calls ↔ tool-результаты» на границе окна (→ 400 от провайдера)
import { trimContextWindow } from "../agent/history";
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

const uid = () => crypto.randomUUID();

// Автопродолжение вопроса: без ответа пользователя N минут модель продолжит сама
const ASK_AUTO_CONTINUE_MS = 5 * 60_000;
/** HTTP-код из строки ошибки Rust-стрима ("HTTP 503: …") */
function parseHttpCode(raw: string): number | null {
  const m = raw.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

export interface AgentRunDeps {
  sessions: Session[];
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
  // повторяем дважды с растущей паузой; частичный ответ не трогаем
  const chatWithRetry = useCallback(
    async (opts: Parameters<typeof chatStream>[0]) => {
      let received = false;
      const wrapped = {
        ...opts,
        onDelta: (d: string) => {
          received = true;
          opts.onDelta(d);
        },
        onThought: (th: string) => {
          received = true;
          opts.onThought(th);
        },
        // FIX: usage означает «провайдер уже насчитал токены за попытку» —
        // ретрай после него двойно считал токены в Hard-Limit и журнале
        onUsage: (u: ChatUsage) => {
          received = true;
          opts.onUsage(u);
        },
        // FIX: tool_calls тоже часть частично-оплаченного ответа — не ретраим
        onToolCalls: (c: ToolCallInfo[]) => {
          received = true;
          opts.onToolCalls?.(c);
        },
      };
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
            continue;
          }
          throw e;
        }
      }
    },
    [t],
  );

  // Откат записи агента: изменённый файл восстанавливаем из before,

  // Ошибка запроса → человекочитаемый заголовок на карточке, сырое тело — по клику
  const setMsgError = useCallback(
    (assistantId: string, raw: string) => {
      const code = parseHttpCode(raw);
      const title =
        code === 401 || code === 403
          ? t("err.auth", { code })
          : code === 404
            ? t("err.notFound", { code })
            : code === 429
              ? t("err.rate", { code })
              : code !== null && code >= 500
                ? t("err.server", { code })
                : t("err.generic");
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
    [t],
  );

  const [streamingId, setStreamingId] = useState<string | null>(null);
  // FIX [re-entrancy]: реф активного прогона (requestId). state streamingId
  // обновляется асинхронно — автоматизации и очередь нуждаются в синхронном
  // «занят ли движок прямо сейчас», иначе второй прогон перезаписывает
  // streamingId первого и finalize/Stop калечат чужой прогон.
  const activeRunRef = useRef<string | null>(null);
  // Ожидающие взаимодействия агента (подтверждение инструмента, вопрос ask_user)
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const interactionsRef = useRef(new InteractionRegistry());
  const openInteraction = useCallback((i: Interaction, resolve: (r: InteractionResolution) => void) => {
    interactionsRef.current.open(i, resolve);
    setInteractions((prev) => [...prev, i]);
  }, []);
  const resolveInteraction = useCallback((id: string, r: InteractionResolution) => {
    if (interactionsRef.current.resolve(id, r)) {
      setInteractions((prev) => prev.filter((x) => x.id !== id));
    }
  }, []);
  const cancelInteractions = useCallback(() => {
    interactionsRef.current.cancelAll();
    setInteractions([]);
  }, []);

  // requestId → id ассистентского сообщения в активном стриме
  const streamingRef = useRef<Map<string, string>>(new Map());
  const abortedRef = useRef<Set<string>>(new Set());
  // Флаг отмены цепочки задач (ChainMonitor): читается в runChain, ставится в handleStop
  const chainAbortRef = useRef(false);
  // Hard Limit: одноразовый триггер на задачу — сбрасывается в начале handleSend
  const limitHitRef = useRef(false);

  // Чекпоинт за прогон агента: снимок делаем один раз перед первой правкой
  const runCheckpointRef = useRef(false);

  // Живые прогоны субагентов (M2): ключ — tool call id
  const [subRuns, setSubRuns] = useState<Record<string, SubRunState>>({});
  const patchSubRun = (id: string, fn: (r: SubRunState) => SubRunState) =>
    setSubRuns((prev) => (prev[id] ? { ...prev, [id]: fn(prev[id]) } : prev));

  // План задач агента: живёт в сессии, перезаписывается только plan_update
  const applyPlan = useCallback((targetId: string, tasks: PlanTask[]) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === targetId ? { ...s, plan: tasks } : s)),
    );
  }, []);

  // Движок автоматизаций: раз в 30 сек проверяем сроки. За тик запускаем
  // максимум одну задачу (стрим один), остальные дождутся следующих тиков.
  const handleSendRef = useRef<typeof handleSend | null>(null);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  // Сообщение в OpenAI-формат: текст + картинки (vision) + tool_calls (агент)
  const toApiContent = (m: Message): unknown => {
    // Цитата (follow-up по выделенному фрагменту) идёт в контекст модели
    const text = m.quote
      ? `[Quote from earlier in this conversation]: «${m.quote}»\n\n${m.content}`
      : m.content;
    if (m.attachments?.length) {
      return [
        { type: "text", text },
        ...m.attachments.map((a) => ({
          type: "image_url",
          image_url: { url: a.dataUrl },
        })),
      ];
    }
    return text;
  };

  const toApiMessage = (m: Message): ChatMsgParam => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    return { role: m.role, content: toApiContent(m) };
  };

  const handleSend = async (
    raw: string,
    attachments?: Attachment[],
    overrideTargetId?: string,
    quote?: string,
    /** Редактирование отправленного: контент заменяется, ответы после — срезаются */
    editMsgId?: string,
  ) => {
    const text = raw.trim();
    const images = attachments ?? [];
    if (!text && images.length === 0) return;

    // Первое сообщение создаёт задачу, если активной ещё нет
    let targetId = overrideTargetId ?? activeId;
    if (!targetId) {
      if (editMsgId) return;
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
    }

    // Синхронизация серверного слоя прав: бэкенд должен знать режим и корень
    // проекта до первого инструмента (fire-and-forget: ошибка не валит отправку)
    const permSession = sessionsRef.current.find((s) => s.id === targetId);
    void permSet(
      permSession?.permissionMode ?? "ask",
      projectRootRef.current ? [projectRootRef.current] : [],
    ).catch(() => {});

    // Редактирование: сообщения после правленого срезаются, сессия
    // подменяется в currentOverride (sessionsRef ещё протухший)
    let currentOverride: Session | undefined;
    if (editMsgId) {
      const src = sessionsRef.current.find((s) => s.id === targetId);
      const orig = src?.messages.find((m) => m.id === editMsgId);
      if (!src || !orig || orig.role !== "user") return;
      const kept = src.messages.slice(0, src.messages.indexOf(orig));
      currentOverride = { ...src, messages: kept };
      setSessions((prev) =>
        prev.map((s) => (s.id === src.id ? { ...s, messages: kept } : s)),
      );
    }

    const userMsg: Message =
      editMsgId && currentOverride
        ? {
            // id сохраняем — DOM-узел и привязки остаются теми же
            ...(sessionsRef.current
              .find((s) => s.id === targetId)
              ?.messages.find((m) => m.id === editMsgId) ?? { id: editMsgId }),
            role: "user",
            content: text,
          }
        : {
            id: uid(),
            role: "user",
            content: text,
            attachments: images.length > 0 ? images : undefined,
            quote: quote?.trim() || undefined,
          };

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
      return;
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
          return;
        }
        const extra = outs
          .map((o) => o.additionalContext)
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

    const requestId = uid();
    // requestId → id ассистентского сообщения выставляется при его создании
    // (в агентном режиме — на каждый шаг цикла)
    setStreamingId(requestId);
    activeRunRef.current = requestId; // FIX [re-entrancy]: движок занят
    setTyping(true);
    setActivity(t("activity.thinking"));
    const startedAt = Date.now();
    // Накопитель расхода этой отправки — попадёт в журнал использования
    const usageAcc = { prompt: 0, completion: 0 };
    // Hard Limit: на новую задачу — с чистого листа
    limitHitRef.current = false;
    // Hard Limit: проверка после каждого usage-события; при превышении — abort задачи
    const checkHardLimit = () => {
      if (limitHitRef.current) return;
      const lim = limitsRef.current;
      const total = usageAcc.prompt + usageAcc.completion;
      let hitKey: string | null = null;
      if (lim.maxTokens != null && lim.maxTokens > 0 && total > lim.maxTokens) hitKey = "limits.hitTokens";
      else if (lim.maxUsd != null && lim.maxUsd > 0 && lim.usdPer1M != null && lim.usdPer1M > 0) {
        const usd = (total / 1_000_000) * lim.usdPer1M;
        if (usd > lim.maxUsd) hitKey = "limits.hitUsd";
      }
      if (hitKey) {
        limitHitRef.current = true;
        // Полноценный abort: помечаем задачу прерванной (цикл и субагенты
        // проверяют abortedRef на каждом шаге) + рвём текущий стрим
        abortedRef.current.add(requestId);
        void abortChat(requestId).catch(() => {});
        addToast(t(hitKey as never));
      }
    };

    const finalize = () => {
      setTyping(false);
      setActivity(null);
      setStreamingId(null);
      activeRunRef.current = null; // FIX [re-entrancy]: движок свободен
      streamingRef.current.delete(requestId);
      abortedRef.current.delete(requestId);
      // Прогон завершён — метка последней активности (для авто-архива)
      setSessions((prev) =>
        prev.map((s) => (s.id === targetId ? { ...s, updatedAt: Date.now() } : s)),
      );
      // Взаимодействия не должны пережить прогон (страховка: цикл обязан
      // был закрыть их сам, но Stop/finalize по исключению — гасим разом)
      cancelInteractions();
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
      const next = queuedMsgsRef.current[0];
      if (next) {
        setQueuedMsgs((prev) => prev.slice(1));
        // Через handleSendRef: замыкание finalize могло устареть
        // (apiSettings с прошлого сообщения), нужна свежая версия;
        // next.quote — цитата из очереди не должна потеряться
        void handleSendRef.current?.(next.text, next.attachments, targetId, next.quote);
      }
      // Тост + звук: пользователь мог уйти в другое приложение
      void notifyTaskDone(
        notifyPrefsRef.current,
        t("notify.doneTitle"),
        notifyMeta(activeSessionRef.current),
        activeSessionRef.current?.title ?? "",
      );
      if (usageAcc.prompt + usageAcc.completion > 0) {
        setUsageLog((prev) => [
          ...prev.slice(-4999),
          {
            day: dayKeyLocal(new Date()),
            prompt: usageAcc.prompt,
            completion: usageAcc.completion,
            model: apiSettings.model,
            workedMs: Date.now() - startedAt,
          },
        ]);
      }
    };

    const markWorked = (assistantId: string) => {
      const worked = Date.now() - startedAt;
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
      // FIX [CRITICAL]: раньше map шёл по ВСЕМ сессиям и клонировал каждый
      // объект и каждый массив сообщений на каждую дельту стрима. Теперь
      // маппится только целевая сессия: O(сообщения одной сессии) на дельту
      // вместо O(все сессии × все сообщения), ревансиляция — одной сессии.
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: m.content + delta,
                        thought: thought
                          ? (m.thought ?? "") + thought
                          : m.thought,
                      }
                    : m,
                ),
              }
            : s,
        ),
      );
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

    // Контекст: системный промт + последние 30 сообщений + новое.
    // FIX: обрезка через trimContextWindow — голый .slice(-30) мог отрезать
    // assistant с tool_calls от его tool-ответов → постоянные 400 у провайдера
    const current =
      currentOverride ?? sessionsRef.current.find((s) => s.id === targetId);
    const history: ChatMsgParam[] = [
      ...(current?.systemPrompt
        ? [{ role: "system", content: current.systemPrompt }]
        : []),
      ...trimContextWindow(
        (current?.messages ?? [])
          .filter(
            (m) =>
              (m.content !== "" || m.thought || m.attachments?.length || m.toolCalls) &&
              // Служебные уведомления (смена модели) в запрос не попадают
              !m.content.startsWith("[i]"),
          )
          .map(toApiMessage),
        30,
      ),
      { role: "user", content: toApiContent(userMsg) },
    ];

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
          .then((t) => {
            // Субагенты выключены — схема subagent_run не отдаётся модели
            if (subConfigRef.current.enabled) return t;
            const arr = t as Array<{ function?: { name?: string } }>;
            return Array.isArray(arr)
              ? arr.filter((x) => x.function?.name !== "subagent_run")
              : t;
          })
          .catch(() => undefined)
      : undefined;

    // Режим плана: модель предупреждена сразу, а не после первой попытки
    if (isAgent && (current?.permissionMode ?? "ask") === "plan") {
      history.push({ role: "system", content: t("agent.planNotice") });
    }

    // Память проектов: краткий контекст предыдущих задач этого проекта
    // (название + первый запрос) — долгосрочное знание без лишних запросов
    if (memoryEnabled && current?.projectId) {
      const mem = sessionsRef.current
        .filter(
          (s) =>
            s.id !== targetId &&
            s.projectId === current.projectId &&
            s.messages.length > 0,
        )
        .slice(-10)
        .map((s) => {
          const first = s.messages.find((m) => m.role === "user");
          const ask = (first?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
          return `- ${s.title}${ask ? `: ${ask}` : ""}`;
        })
        .join("\n");
      if (mem) {
        history.push({
          role: "system",
          content: `${t("memory.systemBlock")}\n${mem}`,
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

    // ---------- Одиночный режим: один стрим, без инструментов ----------
    if (!isAgent) {
      const assistantId = uid();
      streamingRef.current.set(requestId, assistantId);
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      try {
        await chatWithRetry({
          requestId,
          baseUrl: apiSettings.base_url,
          apiKey: apiSettings.api_key,
          model: apiSettings.model,
          reasoningEffort: effortRef.current,
          messages: history,
          onDelta: (delta) => appendTo(assistantId, delta, ""),
          onThought: (thought) => appendTo(assistantId, "", thought),
          onUsage: (usage) => {
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
      streamingRef.current.set(requestId, assistantId);
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      setTyping(true);
      setActivity(t("activity.thinking"));

      const toolCallsHolder: { calls: ToolCallInfo[] | null } = { calls: null };
      // Текст, отстрименный до вызова инструментов, — попадёт в историю
      // вместе с tool_calls, иначе модель «забывает» то, что уже написала
      let streamedText = "";
      let failed = false;
      try {
        await chatWithRetry({
          requestId,
          baseUrl: apiSettings.base_url,
          apiKey: apiSettings.api_key,
          model: apiSettings.model,
          reasoningEffort: effortRef.current,
          messages: history,
          tools,
          onDelta: (delta) => {
            streamedText += delta;
            appendTo(assistantId, delta, "");
          },
          onThought: (thought) => appendTo(assistantId, "", thought),
          onUsage: (usage) => {
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
            toolCallsHolder.calls = calls;
            setActivity(
              t("activity.toolCall", {
                name:
                  calls.length === 1
                    ? calls[0].name
                    : `${calls[0].name} +${calls.length - 1}`,
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
      markWorked(assistantId);

      // Нет вызовов инструментов — обычный ответ, цикл завершён
      const toolCalls = toolCallsHolder.calls;
      if (failed || !toolCalls || toolCalls.length === 0) return finalize();
      if (abortedRef.current.has(requestId)) return finalize();

      // Вызовы инструментов в истории как assistant.tool_calls;
      // отстрименный до вызова текст не теряется
      history.push({
        role: "assistant",
        content: streamedText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // Исполнение инструментов: режим разрешений задачи определяет,
      // что исполняется сразу, что требует подтверждения, а что блокировано
      const permMode =
        sessionsRef.current.find((s) => s.id === targetId)?.permissionMode ??
        "ask";

      const execTool = (name: string, args: string) => {
        setActivity(t("activity.toolRun", { name }));
        // Первый browser_*-инструмент прогона — открыть панель просмотра
        if (
          name.startsWith("browser_") &&
          name !== "browser_close" &&
          browserAutoPanelRef.current
        ) {
          setBrowserPanelOpen(true);
        }
        return runTool(name, args);
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
        const cp = await checkpointSave(root, label);
        if (cp) {
          // Плавающее уведомление вместо строки в чате
          addToast(t("cp.created"));
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
          setSessions((prev) =>
            prev.map((s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, ask: { ...spec, answer: null } }
                  : m,
              ),
            })),
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
          // Автопродолжение: вопрос без ответа N минут — продолжаем сами
          if (askAutoContinue) {
            window.setTimeout(() => {
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

        if (answer === "timeout") {
          // Автопродолжение: карточка закрывается, модель получает указание
          // продолжить самостоятельно
          setSessions((prev) =>
            prev.map((s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === askMsgId && m.ask
                  ? { ...m, ask: { ...m.ask, cancelled: true } }
                  : m,
              ),
            })),
          );
          finishAsk(
            `no answer within ${ASK_AUTO_CONTINUE_MS / 60_000} minutes — continue autonomously using your best judgment`,
          );
          continue;
        }

        if (!answer || abortedRef.current.has(requestId)) {
          // Закрыто без ответа (Stop): карточка помечается, модель получает отказ
          setSessions((prev) =>
            prev.map((s) => ({
              ...s,
              messages: s.messages.map((m) =>
                m.id === askMsgId && m.ask
                  ? { ...m, ask: { ...m.ask, cancelled: true } }
                  : m,
              ),
            })),
          );
          finishAsk("user did not answer (question cancelled)");
          if (abortedRef.current.has(requestId)) return finalize();
          continue;
        }
        finishAsk(JSON.stringify({ ok: true, ...answer }));
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
          };
          const role: SubagentRole =
            mergeRoles(subConfigRef.current.roles).find(
              (r) => r.id === parsed.role,
            ) ?? SUBAGENT_ROLES[0];
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
            // как mutating-инструмент; отказ пишется в отчёт прогона
            subContent = "user denied subagent run";
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
            const onStep = (st: SubagentStep) =>
              patchSubRun(call.id, (r) => {
                if (st.type === "thought")
                  return { ...r, thought: r.thought + st.text };
                if (st.type === "tool")
                  return { ...r, tools: [...r.tools, st.text], thought: "" };
                return { ...r, report: st.text };
              });
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
            });
            subContent = `[${role.name}]
${report}`;
          }
        } catch (e) {
          subContent = `subagent error: ${e}`;
        }
        // Завершённый прогон: убрать из монитора через 30с
        window.setTimeout(
          () =>
            setSubRuns((prev) => {
              if (!(call.id in prev)) return prev;
              const { [call.id]: _done, ...rest } = prev;
              return rest;
            }),
          30_000,
        );
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

      for (const call of toolCalls) {
        if (abortedRef.current.has(requestId)) return finalize();
        if (call.name === "subagent_run") continue; // уже исполнены выше
        if (call.name === "plan_update") continue; // уже исполнены выше (фронтенд)
        if (call.name === "ask_user") continue; // уже исполнены выше (фронтенд)

        // Разрешения внутри прогона ограничены allowlist роли — главный
        // агент уже принял решение о запуске

        // MCP-инструменты тоже трогают внешние системы — подтверждаем по умолчанию.
        // Browser/Computer: чтение и скриншоты безопасны, действия — подтверждаются
        const mutating =
          call.name === "shell_run" ||
          call.name === "fs_write" ||
          call.name === "fs_delete" ||
          call.name === "vault_write" ||
          call.name.startsWith("mcp__") ||          (call.name.startsWith("browser_") &&
            call.name !== "browser_read" &&
            call.name !== "browser_screenshot") ||
          (call.name.startsWith("computer_") &&
            call.name !== "computer_screenshot");
        const session = sessionsRef.current.find((s) => s.id === targetId);
        const allowed =
          mutating &&
          (session?.allowedCommands?.includes(call.arguments) ?? false);

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
                          ...(s.allowedCommands ?? []),
                          call.arguments,
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
        if (screenshot) {
          history.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Browser screenshot (click coordinates are taken from this image):",
              },
              { type: "image_url", image_url: { url: screenshot.dataUrl } },
            ],
          });
        }
      }
    }

    // Лимит шагов
    pushMessage({ id: uid(), role: "assistant", content: t("agent.maxSteps") });
    finalize();
  };

  const handleStop = () => {
    if (!streamingId) return;
    if (chainRunning) chainAbortRef.current = true;
    abortedRef.current.add(streamingId);
    // Реальная отмена: Rust поднимает флаг и гасит поток
    void abortChat(streamingId).catch(() => {});
    // Если агент ждал подтверждения/ответа — закрываем, цикл завершится
    cancelInteractions();
    const msgId = streamingRef.current.get(streamingId);
    if (msgId) {
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === msgId
              ? { ...m, content: m.content + `\n\n*${t("card.stoppedByUser")}*` }
              : m,
          ),
        })),
      );
    }
    streamingRef.current.delete(streamingId);
    setStreamingId(null);
    activeRunRef.current = null; // FIX [re-entrancy]: движок свободен
    setTyping(false);
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
    setSessions((prev) =>
      prev.map((s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === mid && m.ask ? { ...m, ask: { ...m.ask, answer } } : m,
        ),
      })),
    );
    const pending = interactions.find((i) => i.kind === "ask" && i.msgId === mid);
    if (pending && pending.kind === "ask") {
      resolveInteraction(pending.id, { kind: "ask", answer });
    }
  };

  // id ассистентского сообщения активного стрима: карточки сравнивают
  // себя с ним (isStreaming), тогда как streamingId — это requestId
  // (отмена/корректировки/поправки ключуются по нему)
  const streamingAssistantId =
    streamingId ? (streamingRef.current.get(streamingId) ?? null) : null;

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
    subRuns,
    queuedMsgs,
    setQueuedMsgs,
    setPendingCorrections,
    pendingCorrectionsRef,
    interactions,
    handleConfirmDecision,
    handleAskAnswer,
    chainAbortRef,
  };
}
