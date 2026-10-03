import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  chatExportWrite,
  loadProjectSessions,
  loadSessions,
  pickSaveFile,
  saveProjectSessions,
  saveSessions,
} from "../api";
import { useLang } from "../locales";
import { uid } from "./useAgentRun";
import { dayKeyLocal } from "../time";
import {
  exportFileName,
  sessionToMarkdown,
  sessionToJson,
  sessionsToJson,
} from "../export/chatExport";
import type { Message, PermissionMode, Session, UsageEvent } from "../types";

/**
 * Домен «Задачи» (данные): список сессий, активная задача, загрузка истории
 * с диска, автосейв (dirty-флаг + очередь записи + флаш при закрытии) и
 * простые мутаторы полей сессии. Сшивки с агентным движком (Stop при удалении
 * активного прогона, очистка чата) сознательно остаются в App — там движок
 * и его рефы рядом.
 */

/** Числовые поля usage/workedMs приходят из рук редактируемого sessions.json:
 *  строка «5» в prompt раньше доезжала до сумм статистики и делала их NaN —
 *  теплокарта ломалась, а Hard Limit при сравнении с NaN молча не срабатывал */
function sanitizeUsage(u: unknown): Message["usage"] | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const o = u as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { prompt: num(o.prompt), completion: num(o.completion), total: num(o.total) };
}

/** Сообщение: обязательные id/role/content, остальное переносится как есть.
 *  Инварианты, на которые опирается агентный цикл (m.content.startsWith в
 *  agent/history.ts): повреждённая запись раньше роняла прогон TypeError'ом */
function sanitizeMessage(raw: unknown): Message | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id === "") return null;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool") return null;
  return {
    ...(m as unknown as Message),
    content: typeof m.content === "string" ? m.content : "",
    usage: sanitizeUsage(m.usage),
    workedMs:
      typeof m.workedMs === "number" && Number.isFinite(m.workedMs) ? m.workedMs : undefined,
  };
}

/** Сессия: обязательные id/createdAt; messages — ВСЕГДА массив (раньше
 *  s.messages.length на повреждённой записи клинил движок навечно) */
function sanitizeSession(raw: unknown): Session | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id === "") return null;
  if (typeof s.createdAt !== "number" || !Number.isFinite(s.createdAt)) return null;
  const messages = Array.isArray(s.messages)
    ? s.messages.map(sanitizeMessage).filter((m): m is Message => m !== null)
    : [];
  return {
    ...(s as unknown as Session),
    title: typeof s.title === "string" ? s.title : "",
    // База знаний: строковый id или отсутствие (битое значение — не тащим)
    kbId: typeof s.kbId === "string" && s.kbId !== "" ? s.kbId : undefined,
    messages,
  };
}
export function useSessions(opts: {
  addToast: (text: string) => void;
  autoArchive: boolean;
  archiveRetention: number;
  setUsageLog: Dispatch<SetStateAction<UsageEvent[]>>;
  streamingActiveRef: RefObject<boolean>;
  /** Проекты с папками: сессии проекта хранятся в <root>/.nocturn */
  projectsRef: RefObject<{ id: string; root?: string }[]>;
}) {
  const {
    addToast,
    autoArchive,
    archiveRetention,
    setUsageLog,
    streamingActiveRef,
    projectsRef,
  } = opts;
  const { t } = useLang();
  // Зеркало t для вечного эффекта автосейва ниже (deps [] — C14-очередь):
  // замыкание держало t первого рендера, и тост сбоя печатался на прежнем
  // языке после смены языка (аудит А4-3)
  const tMirror = useRef(t);
  useEffect(() => {
    tMirror.current = t;
  });

  // Демо-чаты не создаём: список стартует пустым, задачи — только те,
  // что создал пользователь («Новая задача» / автоматизации)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const historyLoadedRef = useRef(false);

  // Зеркало sessions для асинхронных операций (история запроса к модели)
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  // Снимок для длинных агентных прогонов: в уведомлениях должно быть
  // актуальное название задачи/проект/модель, а не замыкание на момент старта
  const activeSessionRef = useRef(activeSession);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  /** Первичная загрузка истории: merge с локально созданными, авто-архив,
   *  бэкфилл журнала использования. Вызывается один раз из старта App.
   *  Партиции: глобальный sessions.json + <root>/.nocturn/sessions.json
   *  каждого проекта с папкой (проектный файл переопределяет глобальный —
   *  так мигрируют легаси-сессии проектов из глобала) */
  const loadHistory = useCallback(() => {
    const historyReady = (async () => {
      const globalData = await loadSessions().catch(() => null);
      const parsed: Session[] = [];
      if (globalData) {
        try {
          const raw: unknown = JSON.parse(globalData);
          const parsedGlobal = Array.isArray(raw)
            ? raw.map(sanitizeSession).filter((s): s is Session => s !== null)
            : [];
          parsed.push(...parsedGlobal);
        } catch {
          // повреждённый глобальный файл — начинаем глобальную часть с чистого
        }
      }
      // Проектные партиции: файл проекта переопределяет глобальные записи
      // с тем же id (миграция легаси: глобал → папка проекта при первом сейве)
      for (const p of projectsRef.current) {
        if (!p.root) continue;
        const data = await loadProjectSessions(p.root).catch(() => null);
        if (!data) continue;
        try {
          const raw: unknown = JSON.parse(data);
          const parsedP = Array.isArray(raw)
            ? raw.map(sanitizeSession).filter((s): s is Session => s !== null)
            : [];
          for (const s of parsedP) {
            const idx = parsed.findIndex((x) => x.id === s.id);
            if (idx >= 0) parsed[idx] = s;
            else parsed.push(s);
          }
        } catch {
          // повреждённая партиция проекта — пропускаем её
        }
      }
      {
        if (parsed.length > 0) {
          // Авто-архив при старте: старые задачи (кроме закреплённых) — в архив
          if (autoArchive) {
            const cutoff = Date.now() - archiveRetention * 86_400_000;
            const staleIds = new Set(
              parsed
                .filter(
                  (s) =>
                    !s.archived &&
                    !s.pinned &&
                    (s.updatedAt ?? s.createdAt) < cutoff,
                )
                .map((s) => s.id),
            );
            if (staleIds.size > 0) {
              setSessions((prev) => {
                // C4: сессии, созданные пользователем, пока история
                // читалась с диска, не должны затираться снапшотом
                const diskIds = new Set(parsed.map((s) => s.id));
                const localOnly = prev.filter((s) => !diskIds.has(s.id));
                return [
                  ...localOnly,
                  ...parsed.map((s) =>
                    staleIds.has(s.id) ? { ...s, archived: true } : s,
                  ),
                ];
              });
              addToast(t("main.archivedN", { n: staleIds.size }));
              // Ранний выход из async-функции: пометка «история готова»
              // обязана проставиться и здесь, иначе автосейв не включится
              historyLoadedRef.current = true;
              return;
            }
          }
          setSessions((prev) => {
            // C4: merge, не замена — за время холодного чтения диска
            // (антивирус, медленный SSD) пользователь успевал создать
            // задачу, и setSessions(parsed) терял её навсегда
            const diskIds = new Set(parsed.map((s) => s.id));
            const localOnly = prev.filter((s) => !diskIds.has(s.id));
            return localOnly.length > 0 ? [...localOnly, ...parsed] : parsed;
          });
          // Бэкфилл журнала использования из старой истории
          // (без дат сообщений — относим расход ко дню создания задачи)
          if (
            !localStorage.getItem("haloui-usage-backfill") &&
            !localStorage.getItem("haloui-usage")
          ) {
            const backfill: UsageEvent[] = [];
            for (const s of parsed) {
              const day = dayKeyLocal(new Date(s.createdAt));
              for (const m of s.messages) {
                if (m.role === "assistant" && m.usage) {
                  backfill.push({
                    day,
                    prompt: m.usage.prompt,
                    completion: m.usage.completion,
                    model: m.model ?? "?",
                    workedMs: m.workedMs ?? 0,
                  });
                }
              }
            }
            if (backfill.length > 0) setUsageLog(backfill);
            localStorage.setItem("haloui-usage-backfill", "1");
          }
        }
      }
      historyLoadedRef.current = true;
    })();
    return historyReady;
  }, [autoArchive, archiveRetention, addToast, t, setUsageLog, projectsRef]);

  // Автосохранение истории.
  // FIX [perf]: раньше трейлинг-дебаунс 400мс перезапускался каждой дельтой
  // стрима, а потом строкифицировал ВЕСЬ стор (включая base64-вложения) на
  // главном потоке. Теперь dirty-флаг + периодический сейв: не чаще раза
  // в 3с независимо от плотности стрима, а окно потери данных ограничено.
  const sessionsDirtyRef = useRef(false);
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    sessionsDirtyRef.current = true;
  }, [sessions]);
  // Во время активного стрима stringify всего стора (с base64-вложениями)
  // каждые 3с давал регулярные фризы: дельты держат стор «грязным»
  // постоянно. Стримим → пропускаем, dirty остаётся; сбросим на finalize
  // (следующий тик после окончания) или на beforeunload.
  // streamingActiveRef пишет App из streamingId агента.
  useEffect(() => {
    // C14: очередь записи — flush-интервал 3с не ждал завершения предыдущего
    // saveSessions; на больших историях stringify+IPC превышали 3с, два
    // параллельных invoke заканчивались в произвольном порядке, и на диск
    // мог лечь более старый снапшот
    const saveQueue = { p: Promise.resolve() };
    let failStreak = 0;
    // Танк (thunk): партиции строкифицируются в момент исполнения, а не
    // постановки — между flush'ами стор продолжает меняться
    const enqueueSave = (thunk: () => Promise<void>) => {
      saveQueue.p = saveQueue.p
        .then(thunk)
        .then(() => {
          failStreak = 0;
        })
        .catch(() => {
          // Тихий .catch терял правки навсегда: помечаем стор снова грязным
          // (ретрай на следующем тике) и один раз показываем ошибку
          sessionsDirtyRef.current = true;
          failStreak += 1;
          if (failStreak === 3) addToast(tMirror.current("error.saveFailed"));
        });
    };
    /** Партиции стора: сессии проектов с папкой — в <root>/.nocturn,
     *  остальные — в глобальный sessions.json */
    const enqueuePartitionedSave = () => {
      const list = sessionsRef.current;
      const globalList: Session[] = [];
      const byRoot = new Map<string, Session[]>();
      for (const s of list) {
        const root = s.projectId
          ? projectsRef.current.find((p) => p.id === s.projectId)?.root
          : undefined;
        if (root) {
          const arr = byRoot.get(root) ?? [];
          arr.push(s);
          byRoot.set(root, arr);
        } else {
          globalList.push(s);
        }
      }
      enqueueSave(() => saveSessions(JSON.stringify(globalList)));
      for (const [root, items] of byRoot) {
        enqueueSave(() => saveProjectSessions(root, JSON.stringify(items)));
      }
    };
    const flush = () => {
      if (!sessionsDirtyRef.current) return;
      if (streamingActiveRef.current) return;
      sessionsDirtyRef.current = false;
      enqueuePartitionedSave();
    };
    // A15: 10 с вместо 3 с — stringify всего стора (с base64-вложениями,
    // теперь сжатыми) на каждый тик давал периодические фризы; окно потери
    // при краше ограничено beforeunload-флашем
    const id = window.setInterval(flush, 10_000);
    // Закрытие окна — последний сейв, если есть несохранённое
    window.addEventListener("beforeunload", flush);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("beforeunload", flush);
      // Размонтирование (StrictMode/HMR): не теряем накопленное
      const wasStreaming = streamingActiveRef.current;
      streamingActiveRef.current = false;
      if (wasStreaming) {
        enqueuePartitionedSave();
      } else {
        flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Уведомление «модель изменена» — служебное сообщение в активный чат */
  const notifyModelChanged = useCallback(
    (model: string) => {
      setSessions((cur) =>
        cur.map((s) =>
          s.id === activeId && s.messages.length > 0
            ? {
                ...s,
                messages: [
                  ...s.messages,
                  {
                    id: uid(),
                    role: "assistant" as const,
                    content: t("chat.modelChanged", { model }),
                  },
                ],
              }
            : s,
        ),
      );
    },
    [activeId, t],
  );

  /** Ручной авто-архив: задачи старше срока (кроме закреплённых и активной) */
  const archiveOldNow = useCallback(() => {
    const cutoff = Date.now() - archiveRetention * 86_400_000;
    const ids = new Set(
      sessions
        .filter(
          (s) =>
            !s.archived &&
            !s.pinned &&
            s.id !== activeId &&
            (s.updatedAt ?? s.createdAt) < cutoff,
        )
        .map((s) => s.id),
    );
    if (ids.size > 0) {
      setSessions((prev) =>
        prev.map((s) => (ids.has(s.id) ? { ...s, archived: true } : s)),
      );
    }
    addToast(t("main.archivedN", { n: ids.size }));
  }, [sessions, activeId, archiveRetention, addToast, t]);

  // ---------- Простые мутаторы полей активной/указанной задачи ----------

  const handleSetSystemPrompt = (prompt: string | null) => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, systemPrompt: prompt ?? undefined } : s,
      ),
    );
  };

  const handleToggleAgent = () => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, agentMode: !s.agentMode } : s,
      ),
    );
  };

  // Режим разрешений агента (plan / ask / edit / full) — для активной задачи
  const handleSetPermissionMode = (mode: PermissionMode) => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, permissionMode: mode } : s,
      ),
    );
  };

  // Чёрный список инструментов активной задачи (поповер у композера):
  // схемы не отдаются модели, сервер отклоняет вызов (run_tool)
  const handleToggleDisabledTool = (tool: string) => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeId) return s;
        const has = s.disabledTools?.includes(tool) ?? false;
        return {
          ...s,
          disabledTools: has
            ? (s.disabledTools ?? []).filter((n) => n !== tool)
            : [...(s.disabledTools ?? []), tool],
        };
      }),
    );
  };

  // Глобальный просмотр allowlist'ов: правка разрешений любой задачи
  const agentAllowlists = useMemo(
    () =>
      sessions
        .filter((s) => (s.allowedCommands?.length ?? 0) > 0)
        .map((s) => ({ id: s.id, title: s.title, commands: s.allowedCommands ?? [] })),
    [sessions],
  );

  const handleSetSessionAllowed = (id: string, list: string[]) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, allowedCommands: list.length > 0 ? list : undefined }
          : s,
      ),
    );
  };

  // Редактор allowlist (M5.2): правка списка «Всегда для задачи» активной задачи
  const handleSetAllowedCommands = (list: string[]) => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? { ...s, allowedCommands: list.length > 0 ? list : undefined }
          : s,
      ),
    );
  };

  const handleTogglePin = (id: string) =>
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
    );

  const handleDuplicate = (id: string) =>
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const src = idx >= 0 ? prev[idx] : undefined;
      if (!src) return prev;
      // FIX: раньше копия переносила только title/messages/pinned/projectId —
      // agentMode, permissionMode, systemPrompt, allowedCommands, profileId,
      // tag и plan молча терялись (дубликат агентной задачи превращался
      // в обычный чат). Переносим все поля сессии, заменяя идентифицирующие.
      const { id: _id, createdAt: _createdAt, ...rest } = src;
      const copy: Session = {
        ...rest,
        id: uid(),
        title: `${src.title} ${t("session.copy")}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // Копия всегда живёт в основном списке, даже если оригинал в архиве
        archived: false,
        messages: src.messages.map((m) => ({ ...m, id: uid() })),
      };
      const next = [...prev];
      // FIX: findIndex мог вернуть -1 → вставка в начало списка;
      // здесь idx гарантированно валиден (проверен выше)
      next.splice(idx + 1, 0, copy);
      return next;
    });

  // Архивация чата: скрыть из списка / вернуть
  const handleArchiveSession = (id: string, archived: boolean) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, archived } : s)),
    );
  };

  // Тег чата: короткая метка в списке (undefined — снять)
  const handleTagSession = (id: string, tag?: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, tag: tag?.trim() || undefined } : s,
      ),
    );
  };

  // ---------- Экспорт чатов ----------

  // Экспорт чата из контекст-меню: MD — для чтения/шаринга, JSON — полная копия
  const handleExportSession = async (id: string, format: "md" | "json") => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    try {
      // Фильтр диалога обязан совпадать с форматом: дефолтный JSON-фильтр
      // заставлял md-экспорт сохраняться как .md.json
      const path = await pickSaveFile(
        exportFileName(session, format),
        format === "md" ? "md" : "json",
      );
      if (!path) return;
      const content = format === "md" ? sessionToMarkdown(session) : sessionToJson(session);
      await chatExportWrite(path, content);
      addToast(t("export.done"));
    } catch {
      addToast(t("export.failed"));
    }
  };

  // Все чаты одним JSON-архивом — кнопка в «Основном» разделе настроек
  const handleExportAllChats = async () => {
    try {
      if (sessions.length === 0) return;
      const path = await pickSaveFile("nocturn-chats.json");
      if (!path) return;
      await chatExportWrite(path, sessionsToJson(sessions));
      addToast(t("export.chatsDone", { n: sessions.length }));
    } catch {
      addToast(t("export.failed"));
    }
  };

  return {
    sessions,
    setSessions,
    sessionsRef,
    activeId,
    setActiveId,
    activeSession,
    activeSessionRef,
    loadHistory,
    notifyModelChanged,
    archiveOldNow,
    agentAllowlists,
    handleSetSystemPrompt,
    handleToggleAgent,
    handleSetPermissionMode,
    handleToggleDisabledTool,
    handleSetSessionAllowed,
    handleSetAllowedCommands,
    handleTogglePin,
    handleDuplicate,
    handleArchiveSession,
    handleTagSession,
    handleExportSession,
    handleExportAllChats,
  };
}
