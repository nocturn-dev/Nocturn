import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  ChangedFile,
  Message,
  PermissionMode,
  PlanTask,
  Project,
  Session,
  Theme,
  ToolCallInfo,
  UsageEvent,
} from "./types";
import { useLang } from "./locales";
import { parseWriteResult, normalizePath } from "./diff";
import { dayKeyLocal } from "./time";
import CryptoGate from "./components/CryptoGate";

/** Ошибки провайдера, которые имеет смысл ретраить: перегрузка/лимиты/сеть */
const RETRYABLE_RE =
  /\bHTTP (?:429|500|502|503|504|52\d)\b|failed to fetch|connection|timed?.?out/i;

/** HTTP-код из строки ошибки Rust-стрима ("HTTP 503: …") */
function parseHttpCode(raw: string): number | null {
  const m = raw.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}
import {
  loadSettings,
  saveSettings,
  loadProfiles,
  saveProfiles,
  setKeyEncryption,
  cryptoStatus,
  cryptoSetup,
  cryptoUnlock,
  cryptoReset,
  loadProjectsStore,
  saveProjectsStore,
  testConnection,
  chatStream,
  abortChat,
  detectOllama,
  runTool,
  getToolSchemas,
  invalidateToolSchemas,
  permSet,
  mcpAutoconnect,
  loadSessions,
  saveSessions,
  providerFromBaseUrl,
  notesList,
  notesRead,
  notesWrite,
  notesDelete,
  DEFAULT_SETTINGS,
  type ApiSettings,
  type ApiProfile,
  type ModelInfo,
  type ChatMsgParam,
} from "./api";
import {
  loadPromptLibrary,
  savePromptLibrary,
  builtinPresetsFor,
  type PromptPreset,
} from "./presets";
import {
  loadAppearance,
  saveAppearance,
  applyAppearance,
  type Appearance,
} from "./appearance";
import {
  loadThemeProfiles,
  saveThemeProfiles,
  type ThemeProfile,
} from "./themeProfiles";
import Sidebar from "./components/Sidebar";
import NocturnMark from "./components/NocturnMark";
import Splash from "./components/Splash";


import ChatArea from "./components/ChatArea";
import SettingsModal, { type Section } from "./components/SettingsModal";
import AutomationsModal from "./components/AutomationsModal";
import BrowserPanel from "./components/BrowserPanel";
import Toasts from "./components/Toast";
import { isDue, loadAutomations, nextRunAfter, saveAutomations, VAULT_REPORT_SUFFIX } from "./automations";
import { checkForUpdate } from "./api";
import SearchModal from "./components/SearchModal";
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
import NotesModal from "./components/NotesModal";
import GraphModal from "./components/GraphModal";
import ChainMonitor, { type ChainState, type ChainStepStatus } from "./components/ChainMonitor";
import type { SlashCommand } from "./commands";
import { PROVIDERS, checkpointSave, hooksRunEvent, shortcutsLoad, shortcutsSave } from "./api";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  comboMatches,
  parseCombo,
  type CustomShortcut,
  type ShortcutAction,
  type ShortcutBinds,
} from "./shortcuts";
import { buildChainPlan, parseNotePrompt, type Note } from "./vault";
import { loadNotifyPrefs, saveNotifyPrefs, notifyTaskDone, type NotifyPrefs } from "./notify";
import { subagentsLoad, subagentsSave, commandsLoad, pluginsLoad, type Plugin, type UserCommand } from "./api";
import {
  SUBAGENT_ROLES,
  mergeRoles,
  parseSubagentsConfig,
  runSubagent,
  type SubagentRole,
  type SubagentStep,
  type SubRunState,
} from "./subagents";
import { loadLimits, saveLimits, type HardLimits } from "./limits";

const uid = () => crypto.randomUUID();

const clampNum = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export default function App() {
  const { lang, t } = useLang();
  // Демо-чаты не создаём: список стартует пустым, задачи — только те,
  // что создал пользователь («Новая задача» / автоматизации)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>(() => {
    try {
      const raw = localStorage.getItem("haloui-projects");
      if (raw) {
        const parsed = JSON.parse(raw) as Project[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // битый JSON — начинаем с пустого списка
    }
    // Демо-проекты не создаём: список стартует пустым и наполняется
    // только вручную («+» во вкладке «Проекты»)
    return [];
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  // Профили ключей — отдельное хранилище profiles.json
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const profilesLoadedRef = useRef(false);
  // Настройки ещё не загружены с диска — автосейв ждёт, чтобы не затереть файл
  const settingsLoadedRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Раздел настроек для программного открытия (плагины из сайдбара)
  const [settingsSection, setSettingsSection] = useState<Section | null>(null);
  // Автообновление: разовая проверка после старта (native-only, тихо)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdate({
        available: (v) => window.confirm(t("upd.available", { v })),
        installed: () => addToast(t("upd.installed")),
      });
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  // Экран «Автоматизации»
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // Плавающие уведомления (чекпоинты и пр.) — без строк в чате
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const addToast = useCallback((text: string) => {
    const id = uid();
    setToasts((prev) => [...prev.slice(-3), { id, text }]);
    window.setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      4200,
    );
  }, []);
  // Панель живого просмотра браузера агента + тумблер автооткрытия
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false);
  const [browserAutoPanel, setBrowserAutoPanel] = useState(
    () => localStorage.getItem("haloui-browser-panel") !== "0",
  );
  const browserAutoPanelRef = useRef(browserAutoPanel);
  useEffect(() => {
    browserAutoPanelRef.current = browserAutoPanel;
  }, [browserAutoPanel]);
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
  // Сплэш: держится, пока грузятся хранилища (splashDone) + минимальная
  // выдержка внутри Splash; после фейда Splash зовёт onGone — убираем его
  const [splashDone, setSplashDone] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);

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
  // созданный — удаляем
  const handleUndoWrite = useCallback(async (f: ChangedFile) => {
    if (f.created || f.before == null) {
      await runTool("fs_delete", JSON.stringify({ path: f.path })).catch(
        () => undefined,
      );
    } else {
      await runTool("fs_write", JSON.stringify({ path: f.path, content: f.before })).catch(
        () => undefined,
      );
    }
  }, []);

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
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantId ? { ...m, error: { title, raw } } : m,
          ),
        })),
      );
    },
    [t],
  );
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("haloui-theme") === "light" ? "light" : "dark",
  );
  const [glass, setGlass] = useState(
    () => localStorage.getItem("haloui-glass") === "1",
  );
  // Кастомизация оформления (акцент, стиль тёмной, масштаб, шрифт терминала)
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  // Профили внешнего вида: именованные пресеты (Theme + Appearance)
  const [themeProfiles, setThemeProfiles] = useState<ThemeProfile[]>(loadThemeProfiles);
  // Эргономика: сторона сайдбара, скрытие стартовых подсказок,
  // ширина сайдбара и высота терминала (всё — drag/настройки, с запоминанием)
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">(() =>
    localStorage.getItem("haloui-sidebar-side") === "right" ? "right" : "left",
  );
  const [hideStarter, setHideStarter] = useState(
    () => localStorage.getItem("haloui-hide-starter") === "1",
  );
  // Заметки (M-N1): список + открытая заметка
  const [notes, setNotes] = useState<Note[]>([]);
  const [openNoteFile, setOpenNoteFile] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [chainRunning, setChainRunning] = useState(false);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [chainMonitorOpen, setChainMonitorOpen] = useState(false);
  const chainAbortRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("haloui-sidebar-collapsed") === "1",
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = parseInt(localStorage.getItem("haloui-sidebar-width") ?? "340", 10);
    // Старые дефолты (288/320) не влезали в текущий контент — мигрируем
    const w = isNaN(v) || v === 288 || v === 320 ? 340 : v;
    return clampNum(w, 220, 440);
  });
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const v = parseInt(localStorage.getItem("haloui-terminal-height") ?? "42", 10);
    return clampNum(isNaN(v) ? 42 : v, 25, 70);
  });
  // Поведение генерации: скролл и печать
  const [scrollFollow, setScrollFollow] = useState(
    () => localStorage.getItem("haloui-scroll-follow") === "1",
  );
  const [streamSmooth, setStreamSmooth] = useState(
    () => localStorage.getItem("haloui-stream-smooth") !== "0",
  );
  const [streamCaret, setStreamCaret] = useState(
    () => localStorage.getItem("haloui-stream-caret") !== "0",
  );
  // Показ сообщений пользователя в чате (можно скрыть — останутся только ответы)
  const [showUserMsgs, setShowUserMsgs] = useState(
    () => localStorage.getItem("haloui-show-user-msgs") !== "0",
  );
  // Объединять весь ход агента (мысли + команды + результаты + текст)
  // в одну карточку ответа; иначе каждый шаг — отдельная карточка
  const [groupTurns, setGroupTurns] = useState(
    () => localStorage.getItem("haloui-group-turns") !== "0",
  );
  // Журнал использования (раздел «Статистика»): одна запись на отправку
  const [usageLog, setUsageLog] = useState<UsageEvent[]>(() => {
    try {
      const raw = localStorage.getItem("haloui-usage");
      return raw ? (JSON.parse(raw) as UsageEvent[]) : [];
    } catch {
      return [];
    }
  });
  // Окно настроек по умолчанию большое (отдельное окно ~1200×820), а не компактное
  const [settingsLarge, setSettingsLarge] = useState(
    () => localStorage.getItem("haloui-settings-large") === "1",
  );
  // Гейт мастер-пароля: loading → none / unlock / create.
  // Пока не «none» — автосейвы ключей заблокированы (защита от затирания)
  const [cryptoGate, setCryptoGate] = useState<"loading" | "none" | "unlock" | "create" | "disable">("loading");
  // Память проектов: контекст предыдущих задач в новых сессиях
  const [memoryEnabled, setMemoryEnabled] = useState(
    () => localStorage.getItem("haloui-memory") === "1",
  );
  // Призрачный логотип на фоне чата
  const [chatMark, setChatMark] = useState(
    () => localStorage.getItem("haloui-chat-mark") !== "0",
  );
  // Эффект стекла на карточках ответов ИИ
  const [msgGlass, setMsgGlass] = useState(
    () => localStorage.getItem("haloui-msg-glass") === "1",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  // Терминальный режим (M4.5): панель снизу
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [apiSettings, setApiSettings] = useState<ApiSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [apiStatus, setApiStatus] = useState<{
    kind: "idle" | "checking" | "ok" | "error";
    message?: string;
    models?: ModelInfo[];
  }>({ kind: "idle" });
  // Hard Limit: лимиты расхода на задачу (localStorage) — реф синхронный,
  // его читает handleSend, который живёт в замыкании
  const [limits, setLimits] = useState<HardLimits>(loadLimits);
  const limitsRef = useRef(limits);
  useEffect(() => {
    limitsRef.current = limits;
    saveLimits(limits);
  }, [limits]);
  // Reasoning effort: усилие размышлений («off» — не отправлять провайдеру)
  const [effort, setEffort] = useState<"off" | "low" | "high" | "max">(() => {
    const raw = localStorage.getItem("haloui-effort");
    return raw === "low" || raw === "high" || raw === "max" ? raw : "off";
  });
  const effortRef = useRef(effort);
  useEffect(() => {
    effortRef.current = effort;
    localStorage.setItem("haloui-effort", effort);
  }, [effort]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    requestId: string;
    call: ToolCallInfo;
  } | null>(null);
  const confirmResolverRef = useRef<((d: "once" | "always" | "deny") => void) | null>(null);
  const [promptLibrary, setPromptLibrary] = useState<PromptPreset[]>(() =>
    loadPromptLibrary(),
  );
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  // Корневая папка проекта для файлового менеджера (M4.2), помнит выбор
  const [projectRoot, setProjectRoot] = useState<string | null>(() =>
    localStorage.getItem("haloui-project-root"),
  );
  // projectRoot для агентного цикла: актуальное значение через реф
  const projectRootRef = useRef<string | null>(projectRoot);
  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);
  // Чекпоинт за прогон агента: снимок делаем один раз перед первой правкой
  const runCheckpointRef = useRef(false);

  // requestId → id ассистентского сообщения в активном стриме
  const streamingRef = useRef<Map<string, string>>(new Map());
  const abortedRef = useRef<Set<string>>(new Set());
  // Hard Limit: одноразовый триггер на задачу — сбрасывается в начале handleSend
  const limitHitRef = useRef(false);
  const historyLoadedRef = useRef(false);
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    kind: "session" | "project" | "note";
  } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Тема применяется мгновенно и запоминается
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("haloui-theme", theme);
  }, [theme]);

  // Эффект стекла — независимый слой поверх любой темы
  useEffect(() => {
    document.documentElement.classList.toggle("glass", glass);
    localStorage.setItem("haloui-glass", glass ? "1" : "0");
  }, [glass]);

  // Корневая папка файлового менеджера запоминается между запусками
  useEffect(() => {
    if (projectRoot) localStorage.setItem("haloui-project-root", projectRoot);
    else localStorage.removeItem("haloui-project-root");
  }, [projectRoot]);

  // Заметки загружаются при старте
  const refreshNotes = useCallback(async () => {
    try {
      const metas = await notesList();
      const full: Note[] = [];
      for (const m of metas) {
        const content = await notesRead(m.file);
        full.push({ ...m, content });
      }
      setNotes(full);
    } catch {
      // нет папки заметок — пусто
    }
  }, []);
  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  // Кастомизация применяется мгновенно и запоминается
  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  // Профили внешнего вида: персистентность
  useEffect(() => {
    saveThemeProfiles(themeProfiles);
  }, [themeProfiles]);

  // Применение профиля одним кликом: подмена темы и оформления целиком
  // (glass — отдельный тумблер, в профиль не входит и не трогается)
  const applyThemeProfile = useCallback((p: ThemeProfile) => {
    setTheme(p.theme);
    setAppearance(p.appearance);
  }, []);

  // Эргономика: персистентность настроек
  useEffect(() => {
    localStorage.setItem("haloui-sidebar-side", sidebarSide);
  }, [sidebarSide]);
  useEffect(() => {
    localStorage.setItem("haloui-projects", JSON.stringify(projects));
  }, [projects]);
  useEffect(() => {
    localStorage.setItem("haloui-sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  // Плавающая кнопка возврата появляется с небольшой задержкой,
  // когда панель уже складывается — без щелчка
  const [sparkVisible, setSparkVisible] = useState(false);
  useEffect(() => {
    if (!sidebarCollapsed) {
      setSparkVisible(false);
      return;
    }
    const t = window.setTimeout(() => setSparkVisible(true), 160);
    return () => window.clearTimeout(t);
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("haloui-hide-starter", hideStarter ? "1" : "0");
  }, [hideStarter]);
  useEffect(() => {
    localStorage.setItem("haloui-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("haloui-terminal-height", String(terminalHeight));
  }, [terminalHeight]);
  useEffect(() => {
    localStorage.setItem("haloui-scroll-follow", scrollFollow ? "1" : "0");
  }, [scrollFollow]);
  useEffect(() => {
    localStorage.setItem("haloui-stream-smooth", streamSmooth ? "1" : "0");
  }, [streamSmooth]);
  useEffect(() => {
    localStorage.setItem("haloui-stream-caret", streamCaret ? "1" : "0");
  }, [streamCaret]);
  useEffect(() => {
    localStorage.setItem("haloui-show-user-msgs", showUserMsgs ? "1" : "0");
  }, [showUserMsgs]);
  useEffect(() => {
    localStorage.setItem("haloui-group-turns", groupTurns ? "1" : "0");
  }, [groupTurns]);
  useEffect(() => {
    localStorage.setItem("haloui-usage", JSON.stringify(usageLog.slice(-4999)));
  }, [usageLog]);
  useEffect(() => {
    localStorage.setItem("haloui-settings-large", settingsLarge ? "1" : "0");
  }, [settingsLarge]);
  useEffect(() => {
    localStorage.setItem("haloui-memory", memoryEnabled ? "1" : "0");
  }, [memoryEnabled]);
  useEffect(() => {
    localStorage.setItem("haloui-chat-mark", chatMark ? "1" : "0");
  }, [chatMark]);
  useEffect(() => {
    localStorage.setItem("haloui-msg-glass", msgGlass ? "1" : "0");
  }, [msgGlass]);

  // Drag-ресайз сайдбара и терминала: слушатели вешаются один раз,
  // активная зона выбирается рефом на mousedown
  const resizeRef = useRef<"sidebar" | "terminal" | null>(null);
  useEffect(() => {
    const clearResize = () => {
      if (resizeRef.current) {
        resizeRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    const onMove = (e: MouseEvent) => {
      // Кнопку отпустили за пределами окна — mouseup не приходит,
      // поэтому сбрасываем сами, как только видим «пустую» кнопку
      if (e.buttons === 0) {
        clearResize();
        return;
      }
      if (resizeRef.current === "sidebar") {
        const x = sidebarSide === "right" ? window.innerWidth - e.clientX : e.clientX;
        setSidebarWidth(clampNum(x, 220, 420));
      } else if (resizeRef.current === "terminal") {
        // Секция чата занимает всю высоту окна
        const pct = ((window.innerHeight - e.clientY) / window.innerHeight) * 100;
        setTerminalHeight(clampNum(Math.round(pct), 25, 70));
      }
    };
    const onUp = () => clearResize();
    const onBlur = () => clearResize();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [sidebarSide]);

  const startSidebarResize = () => {
    resizeRef.current = "sidebar";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const startTerminalResize = () => {
    resizeRef.current = "terminal";
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  // Загружаем сохранённые настройки API и историю при старте
  useEffect(() => {
    const settingsReady = loadSettings()
      .then((s) => {
        if (s.api_key || s.base_url || s.model) {
          // Старые настройки без метки провайдера — восстанавливаем по URL
          if (!s.provider) s.provider = providerFromBaseUrl(s.base_url);
          setApiSettings(s);
          // Свежий список моделей при старте — для vision-предупреждений
          if (s.api_key && s.base_url) {
            setApiStatus({ kind: "checking" });
            testConnection(s.base_url, s.api_key)
              .then((models) =>
                setApiStatus({
                  kind: "ok",
                  models,
                  message: t("api.connected", { n: models.length }),
                }),
              )
              .catch((e) =>
                setApiStatus({ kind: "error", message: String(e) }),
              );
          }
        }
      })
      .catch(() => {
        // Настройек ещё нет — остаёмся с дефолтами
      })
      .finally(() => {
        settingsLoadedRef.current = true;
      });
    // Профили: отдельное хранилище, при первом запуске мигрируют из settings.json
    const profilesReady = loadProfiles()
      .then((store) => {
        // Защита от битого/неожиданного ответа хранилища
        setProfiles(
          Array.isArray((store as { profiles?: unknown })?.profiles)
            ? (store.profiles as ApiProfile[])
            : [],
        );
        setActiveProfileId(
          typeof (store as { active?: unknown })?.active === "string"
            ? (store.active as string)
            : "",
        );
      })
      .catch(() => {})
      .finally(() => {
        profilesLoadedRef.current = true;
      });
    // Гейт мастер-пароля: если шифрование включено и хранилище заперто —
    // блокируем интерфейс окном входа до разблокировки
    cryptoStatus()
      .then((cs) => {
        if (cs.enabled && !cs.unlocked) {
          setCryptoGate(cs.setup ? "unlock" : "create");
        } else {
          setCryptoGate("none");
        }
      })
      .catch(() => setCryptoGate("none"));
    // Проекты: миграция из localStorage в projects.json
    const projectsReady = loadProjectsStore()
      .then((recs) => {
        if (Array.isArray(recs) && recs.length > 0) {
          setProjects(
            recs.map((r) => {
              const rec = r as { id: string; name: string; profile_id?: string };
              return {
                id: rec.id,
                name: rec.name,
                profileId: rec.profile_id || undefined,
              };
            }),
          );
        }
        // пусто в файле — остаётся localStorage-состояние, автосейв запишет его
      })
      .catch(() => {})
      .finally(() => {
        projectsLoadedRef.current = true;
      });
    const historyReady = loadSessions()
      .then((data) => {
        if (data) {
          try {
            const parsed = JSON.parse(data) as Session[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              setSessions(parsed);
              // Бэкфилл журнала использования из старой истории
              // (без дат сообщений — относим расход ко дню создания задачи)
              if (
                !localStorage.getItem("haloui-usage-backfill") &&
                !localStorage.getItem("haloui-usage")
              ) {
                const backfill: UsageEvent[] = [];
                for (const s of parsed) {
                  const day = new Date(s.createdAt).toISOString().slice(0, 10);
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
          } catch {
            // повреждённая история — начинаем с чистого листа
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        historyLoadedRef.current = true;
      });
    // Сплэш: приложение готово, когда все четыре хранилища прочитаны
    // (ошибки не мешают готовности — .finally уже отработал в каждом)
    void Promise.all([
      settingsReady,
      profilesReady,
      projectsReady,
      historyReady,
    ]).then(() => setSplashDone(true));
  }, []);

  // Автосохранение истории (с дебаунсом)
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    const t = window.setTimeout(() => {
      saveSessions(JSON.stringify(sessions)).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [sessions]);

  // Автосохранение настроек API: любое изменение (включая смену профиля
  // из чата) попадает на диск без кнопки «Сохранить».
  // Пока гейт пароля не пройден — не пишем (не затираем зашифрованные поля)
  useEffect(() => {
    if (!settingsLoadedRef.current || cryptoGate !== "none") return;
    const t = window.setTimeout(() => {
      saveSettings(apiSettings).catch(() => {});
    }, 500);
    return () => window.clearTimeout(t);
  }, [apiSettings, cryptoGate]);

  // Уведомление в чате о смене модели (после первой загрузки настроек)
  const lastModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const prev = lastModelRef.current;
    lastModelRef.current = apiSettings.model;
    if (prev === null || prev === apiSettings.model) return;
    setSessions((cur) =>
      cur.map((s) =>
        s.id === activeId && s.messages.length > 0
          ? {
              ...s,
              messages: [
                ...s.messages,
                {
                  id: uid(),
                  role: "assistant",
                  content: t("chat.modelChanged", { model: apiSettings.model }),
                },
              ],
            }
          : s,
      ),
    );
  }, [apiSettings.model, activeId]);

  // Автосохранение профилей (profiles.json); ключи шифруются, если включено
  useEffect(() => {
    if (!profilesLoadedRef.current || cryptoGate !== "none") return;
    const t = window.setTimeout(() => {
      saveProfiles(
        { profiles, active: activeProfileId },
        apiSettings.encrypt_keys ?? false,
      ).catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [profiles, activeProfileId, apiSettings.encrypt_keys, cryptoGate]);

  // Автосохранение проектов (projects.json, миграция из localStorage)
  useEffect(() => {
    if (!projectsLoadedRef.current) return;
    const t = window.setTimeout(() => {
      saveProjectsStore(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          profile_id: p.profileId ?? "",
        })),
      ).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [projects]);

  const handleTestConnection = useCallback(() => {
    setApiStatus({ kind: "checking" });
    testConnection(apiSettings.base_url, apiSettings.api_key)
      .then((models) =>
        setApiStatus({
          kind: "ok",
          models,
          message: t("api.connected", { n: models.length }),
        }),
      )
      .catch((e) => setApiStatus({ kind: "error", message: String(e) }));
  }, [apiSettings.base_url, apiSettings.api_key]);

  const handleSaveSettings = async () => {
    await saveSettings(apiSettings);
  };

  // Ожидание создания мастер-пароля при включении тумблера шифрования
  const encPendingRef = useRef(false);

  /** Перечитать ключи с диска (после разблокировки/смены шифрования) */
  const reloadSecrets = useCallback(async () => {
    const [s, store] = await Promise.all([loadSettings(), loadProfiles()]);
    setApiSettings(s);
    setProfiles(store.profiles ?? []);
    setActiveProfileId(store.active ?? "");
  }, []);

  /** Тумблер шифрования: включение открывает окно создания мастер-пароля,
      выключение — окно разблокировки (расшифровать можно только с паролем) */
  const handleEncryptionToggle = useCallback(
    async (enable: boolean) => {
      if (enable) {
        encPendingRef.current = true;
        setCryptoGate("create");
        return true;
      }
      setCryptoGate("disable");
      return true;
    },
    [],
  );

  /** Сабмит из окна гейта: создание пароля, разблокировка или отключение шифрования */
  const handleGateSubmit = useCallback(
    async (password: string) => {
      if (cryptoGate === "create") {
        await cryptoSetup(password);
        if (encPendingRef.current) {
          await setKeyEncryption(true);
          encPendingRef.current = false;
        }
        await reloadSecrets();
        setCryptoGate("none");
        return true;
      }
      // unlock и disable: сначала проверяем пароль (бросает исключение при неверном)
      await cryptoUnlock(password);
      if (cryptoGate === "disable") {
        await setKeyEncryption(false);
        await reloadSecrets();
      } else {
        await reloadSecrets();
      }
      setCryptoGate("none");
      return true;
    },
    [cryptoGate, reloadSecrets],
  );

  /** «Забыли пароль»: сброс шифрования, зашифрованные ключи утеряны */
  const handleGateReset = useCallback(async () => {
    await cryptoReset().catch(() => {});
    encPendingRef.current = false;
    await reloadSecrets();
    setCryptoGate("none");
  }, [reloadSecrets]);

  /** Отмена гейта, открытого из тумблера: ничего не включаем/не выключаем */
  const handleGateCancel = useCallback(() => {
    encPendingRef.current = false;
    setCryptoGate("none");
  }, []);

  // ---------- Профили API: отдельное хранилище + привязка к чату/проекту ----------

  /** Подставить связку профиля в активные настройки */
  const applyProfileSettings = useCallback((p: ApiProfile) => {
    setApiSettings((prev) => ({
      ...prev,
      api_key: p.api_key,
      base_url: p.base_url,
      model: p.model,
      provider: p.provider,
    }));
  }, []);

  /** Сохранить текущие ключ+URL+модель как новый профиль и привязать к чату */
  const handleAddProfile = useCallback(
    (name: string) => {
      const profile: ApiProfile = {
        id: `p-${Date.now()}`,
        name: name.trim() || providerFromBaseUrl(apiSettings.base_url),
        api_key: apiSettings.api_key,
        base_url: apiSettings.base_url,
        model: apiSettings.model,
        provider: apiSettings.provider,
      };
      setProfiles((prev) => [...prev, profile]);
      setActiveProfileId(profile.id);
      // Привязка к активному чату — при его открытии профиль вернётся
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId ? { ...s, profileId: profile.id } : s,
        ),
      );
    },
    [apiSettings, activeId],
  );

  /** Переключиться на профиль: подставить настройки + привязать к чату */
  const handleApplyProfile = useCallback(
    (id: string) => {
      const p = profiles.find((x) => x.id === id);
      if (!p) return;
      setActiveProfileId(id);
      applyProfileSettings(p);
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, profileId: id } : s)),
      );
    },
    [profiles, activeId, applyProfileSettings],
  );

  const handleDeleteProfile = useCallback(
    (id: string) => {
      setProfiles((prev) => prev.filter((p) => p.id !== id));
      if (activeProfileId === id) setActiveProfileId("");
    },
    [activeProfileId],
  );

  // Открытие чата с привязанным профилем — подставляем его связку.
  // Сравнение по id профиля: настройки могли менять вручную, не перетираем
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId);
    if (!s?.profileId || s.profileId === activeProfileId) return;
    const p = profiles.find((x) => x.id === s.profileId);
    if (!p) return; // профиль удалён — остаёмся на текущих настройках
    setActiveProfileId(p.id);
    applyProfileSettings(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleNewChat = useCallback(() => {
    // Не плодим пустые задачи подряд
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (cur && cur.messages.length === 0) {
      setActiveId(cur.id);
      return;
    }
    // Новый чат наследует профиль проекта (если открыт проект) или активный
    const project = projects.find((p) => p.id === activeProjectId);
    if (project && project.profileId && project.profileId !== activeProfileId) {
      // Запоминаем выбор и за проектом
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? { ...p, profileId: activeProfileId } : p,
        ),
      );
    }
    const session: Session = {
      id: uid(),
      title: t("chat.new"),
      createdAt: Date.now(),
      messages: [],
      projectId: activeProjectId ?? undefined,
      profileId: activeProfileId || project?.profileId || undefined,
    };
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
  }, [activeId, activeProjectId, activeProfileId, projects, t]);

  // Автообнаружение Ollama: при старте и каждые 30 секунд
  const detectLocal = useCallback(() => {
    detectOllama()
      .then((models) => setOllamaModels(models))
      .catch(() => setOllamaModels(null));
  }, []);
  useEffect(() => {
    detectLocal();
    const iv = window.setInterval(detectLocal, 30_000);
    return () => window.clearInterval(iv);
  }, [detectLocal]);

  // MCP: автоконнект включённых серверов при старте (фоново, ошибки молча)
  useEffect(() => {
    mcpAutoconnect()
      .then(() => invalidateToolSchemas())
      .catch(() => {});
  }, []);

  // Переключение на локальную модель: Ollama не требует ключа
  const handleUseLocalModel = (id: string) => {
    setApiSettings({
      api_key: "ollama",
      base_url: "http://localhost:11434/v1",
      model: id,
      provider: "custom",
    });
  };

  // Зеркало sessions для асинхронных операций (история запроса к модели)
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  // ---------- Уведомления о завершении / подтверждении (когда окно не в фокусе) ----------
  // Конфиг субагентов (M3): роли/параллельность/тумблер — subagents.json
  const [subConfig, setSubConfig] = useState(parseSubagentsConfig({}));
  const subConfigRef = useRef(subConfig);
  useEffect(() => {
    subagentsLoad()
      .then((raw) => setSubConfig(parseSubagentsConfig(raw)))
      .catch(() => {});
  }, []);

  // Плагины: реестр + производные сущности (команды/скилы/роли)
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  useEffect(() => {
    pluginsLoad()
      .then(setPlugins)
      .catch(() => {});
  }, []);
  const enabledPlugins = plugins.filter((p) => p.enabled);
  const pluginCommands = enabledPlugins.flatMap((p) => p.commands ?? []);
  const pluginSkills = enabledPlugins.flatMap((p) => p.skills ?? []);
  const pluginRoles = enabledPlugins.flatMap((p) => p.roles ?? []);
  // Эффективный конфиг субагентов: свои роли + роли из плагинов
  const subConfigEffective = useMemo(
    () => ({ ...subConfig, roles: [...subConfig.roles, ...pluginRoles] }),
    [subConfig, pluginRoles],
  );
  useEffect(() => {
    subConfigRef.current = subConfigEffective;
  }, [subConfigEffective]);

  // Пользовательские slash-команды (commands.json)
  const [userCommands, setUserCommands] = useState<UserCommand[]>([]);
  useEffect(() => {
    commandsLoad()
      .then(setUserCommands)
      .catch(() => {});
  }, []);

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

  const [notifyPrefs, setNotifyPrefs] = useState<NotifyPrefs>(loadNotifyPrefs);
  const notifyPrefsRef = useRef(notifyPrefs);
  useEffect(() => {
    notifyPrefsRef.current = notifyPrefs;
    saveNotifyPrefs(notifyPrefs);
  }, [notifyPrefs]);
  /** Строка «проект · модель» для тела уведомления */
  const notifyMeta = (s: Session | null) => {
    const project = projects.find((p) => p.id === s?.projectId);
    return [project?.name ?? "", apiSettings.model].filter(Boolean).join(" · ");
  };
  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : null;

  // Файлы, изменённые агентом в активной задаче (M4.3) — для подсветки в дереве
  const modifiedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const m of activeSession?.messages ?? []) {
      if (m.role !== "tool" || m.toolName !== "fs_write") continue;
      const w = parseWriteResult(m.content);
      if (w?.path) set.add(normalizePath(w.path));
    }
    return set;
  }, [activeSession]);

  // Latest-ref паттерн: слушатель keydown вешается ровно один раз,
  // а актуальные обработчики читаются через реф
  const handleNewChatRef = useRef(handleNewChat);
  useEffect(() => {
    handleNewChatRef.current = handleNewChat;
  });

  // Пользовательские бинды: грузим из shortcuts.json, мерджим с дефолтами.
  // Формат файла: { binds: {...}, custom: [...] }; плоская карта = старая версия.
  const [binds, setBinds] = useState<ShortcutBinds>(SHORTCUT_DEFAULTS);
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcut[]>([]);
  const persistShortcuts = useCallback(
    (b: ShortcutBinds, c: CustomShortcut[]) => {
      setBinds(b);
      setCustomShortcuts(c);
      shortcutsSave({ binds: b, custom: c }).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    shortcutsLoad()
      .then((stored) => {
        const rec = stored as Record<string, unknown>;
        if (rec && Array.isArray(rec.custom)) {
          setBinds({ ...SHORTCUT_DEFAULTS, ...(rec.binds as ShortcutBinds) });
          setCustomShortcuts(rec.custom as CustomShortcut[]);
        } else {
          setBinds({ ...SHORTCUT_DEFAULTS, ...(stored as ShortcutBinds) });
        }
      })
      .catch(() => {});
  }, []);

  // Реф на реестр slash-команд (заполняется ниже, после объявления реестра)
  const slashCommandsRef = useRef<SlashCommand[]>([]);
  useEffect(() => {
    slashCommandsRef.current = slashCommands;
  });

  // Движок автоматизаций: раз в 30 сек проверяем сроки. За тик запускаем
  // максимум одну задачу (стрим один), остальные дождутся следующих тиков.
  const handleSendRef = useRef<typeof handleSend | null>(null);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });
  const apiSettingsRef = useRef(apiSettings);
  useEffect(() => {
    apiSettingsRef.current = apiSettings;
  });
  useEffect(() => {
    const timer = setInterval(() => {
      const autos = loadAutomations();
      const now = Date.now();
      const due = autos.find((a) => isDue(a, now));
      if (!due) return;
      // Без настроенного API запуск бессмыслен — сдвигаем срок, не спамим
      if (
        apiSettingsRef.current.api_key.trim() === "" ||
        apiSettingsRef.current.model.trim() === ""
      ) {
        due.nextRunAt = nextRunAfter(due, now);
        saveAutomations(autos);
        return;
      }
      due.lastRunAt = now;
      due.runs = [...(due.runs ?? []), now].slice(-10);
      due.nextRunAt = nextRunAfter(due, now);
      saveAutomations(autos);
      const session: Session = {
        id: uid(),
        title: due.name.slice(0, 48),
        createdAt: now,
        messages: [],
      };
      const send = handleSendRef.current;
      if (!send) return;
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      const prompt = due.toVault ? due.prompt + VAULT_REPORT_SUFFIX : due.prompt;
      void send(prompt, undefined, session.id);
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  // Диспетчер действий биндов — актуальные обработчики через реф
  const dispatchShortcutRef = useRef<(a: ShortcutAction) => void>(() => {});
  dispatchShortcutRef.current = (action: ShortcutAction) => {
    switch (action) {
      case "new_task":
        handleNewChatRef.current();
        break;
      case "search":
        setSearchOpen(true);
        break;
      case "open_settings":
        setSettingsSection("main");
        setSettingsOpen(true);
        break;
      case "toggle_theme":
        setTheme((v) => (v === "dark" ? "light" : "dark"));
        break;
      case "toggle_agent":
        if (activeId) {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === activeId ? { ...s, agentMode: !s.agentMode } : s,
            ),
          );
        }
        break;
      case "toggle_terminal":
        setTerminalOpen((v) => !v);
        break;
      case "toggle_sidebar":
        setSidebarCollapsed((v) => !v);
        break;
      case "cycle_perm_mode": {
        if (!activeId) break;
        const order: PermissionMode[] = ["ask", "plan", "edit", "full"];
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeId) return s;
            const idx = order.indexOf(s.permissionMode ?? "ask");
            return { ...s, permissionMode: order[(idx + 1) % order.length] };
          }),
        );
        break;
      }
    }
  };

  // Глобальные бинды: матч по e.code (физическая клавиша) — работает
  // на любой раскладке. Комбо без модификаторов игнорируются (не мешать
  // печати), кроме F-клавиш. После встроенных действий проверяются
  // кастомные хоткеи (комбо → slash-команда).
  const bindsRef = useRef(binds);
  useEffect(() => {
    bindsRef.current = binds;
  });
  const customShortcutsRef = useRef(customShortcuts);
  useEffect(() => {
    customShortcutsRef.current = customShortcuts;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const action of SHORTCUT_ACTIONS) {
        const bind = bindsRef.current[action];
        if (!bind) continue;
        if (comboMatches(bind, e)) {
          // Одинокая буква/цифра без модификаторов — не перехватываем
          const parts = parseCombo(bind);
          if (!parts) continue;
          const bare = !parts.ctrl && !parts.alt && !parts.shift;
          if (bare && !parts.code.startsWith("F")) continue;
          e.preventDefault();
          dispatchShortcutRef.current(action);
          return;
        }
      }
      // Кастомные хоткеи: "/command аргумент" через реестр slash-команд
      for (const cs of customShortcutsRef.current) {
        if (!cs.combo || !comboMatches(cs.combo, e)) continue;
        const parts = parseCombo(cs.combo);
        if (!parts) continue;
        const bare = !parts.ctrl && !parts.alt && !parts.shift;
        if (bare && !parts.code.startsWith("F")) continue;
        e.preventDefault();
        const text = cs.command.trim().replace(/^\//, "");
        const name = text.split(/\s+/)[0] ?? "";
        const arg = text.slice(name.length).trim();
        const cmd = slashCommandsRef.current.find((c) => c.name === name);
        if (cmd) cmd.run(arg);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    streamingRef.current.set(requestId, requestId);
    setStreamingId(requestId);
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
      streamingRef.current.delete(requestId);
      abortedRef.current.delete(requestId);
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
        notifyMeta(activeSession),
        activeSession?.title ?? "",
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
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.id === assistantId
              ? { ...m, workedMs: m.workedMs ?? worked }
              : m,
          ),
        })),
      );
    };

    const appendTo = (assistantId: string, delta: string, thought: string) => {
      if (abortedRef.current.has(requestId)) return;
      setTyping(false);
      // Текст уже печатается в карточке — статус-бабл скрываем;
      // идёт поток размышлений — показываем «Размышляет…»
      setActivity(thought ? t("activity.thinking") : null);
      setSessions((prev) =>
        prev.map((s) => ({
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
        })),
      );
    };

    const pushMessage = (msg: Message) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId ? { ...s, messages: [...s.messages, msg] } : s,
        ),
      );
    };

    // Сообщение пользователя попадает в историю сессии: без этого в чате
    // видны только ответы модели, а само сообщение существует лишь в запросе
    pushMessage(userMsg);

    // Контекст: системный промт + последние 30 сообщений + новое
    const current =
      currentOverride ?? sessionsRef.current.find((s) => s.id === targetId);
    const history: ChatMsgParam[] = [
      ...(current?.systemPrompt
        ? [{ role: "system", content: current.systemPrompt }]
        : []),
      ...(current?.messages ?? [])
        .filter(
          (m) =>
            (m.content !== "" || m.thought || m.attachments?.length || m.toolCalls) &&
            // Служебные уведомления (смена модели) в запрос не попадают
            !m.content.startsWith("[i]"),
        )
        .slice(-30)
        .map(toApiMessage),
      { role: "user", content: toApiContent(userMsg) },
    ];

    const isAgent = current?.agentMode ?? false;
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
        ].join(" "),
      });
    }

    // ---------- Одиночный режим: один стрим, без инструментов ----------
    if (!isAgent) {
      const assistantId = uid();
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetId
            ? {
                ...s,
                title:
                    s.messages.length === 0
                      ? (text || images[0]?.name || t("chat.imageTitle")).slice(0, 48)
                      : s.title,
              }
            : s,
        ),
      );
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
            setSessions((prev) =>
              prev.map((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, usage } : m,
                ),
              })),
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
        confirmResolverRef.current = resolve;
        setPendingConfirm({ requestId, call });
        // Пользователь может быть в другом приложении — уведомить о запросе
        void notifyTaskDone(
          notifyPrefsRef.current,
          t("notify.confirmTitle"),
          notifyMeta(activeSession),
          activeSession?.title ?? "",
        );
      });

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (abortedRef.current.has(requestId)) return finalize();
      // Поправки, накопившиеся за прошлый шаг, попадают модели до нового запроса
      injectCorrections();

      const assistantId = uid();
      pushMessage({ id: assistantId, role: "assistant", content: "", thought: "", model: apiSettings.model });
      setTyping(true);
      setActivity(t("activity.thinking"));

      const toolCallsHolder: { calls: ToolCallInfo[] | null } = { calls: null };
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
          onDelta: (delta) => appendTo(assistantId, delta, ""),
          onThought: (thought) => appendTo(assistantId, "", thought),
          onUsage: (usage) => {
            usageAcc.prompt += usage.prompt;
            usageAcc.completion += usage.completion;
            checkHardLimit();
            setSessions((prev) =>
              prev.map((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, usage } : m,
                ),
              })),
            );
          },
          onToolCalls: (calls) => {
            toolCallsHolder.calls = calls;
            setActivity(
              t("activity.toolCall", {
                name:
                  calls.length === 1
                    ? calls[0].name
                    : `${calls[0].name} +${calls.length - 1}`,
              }),
            );
            setSessions((prev) =>
              prev.map((s) => ({
                ...s,
                messages: s.messages.map((m) =>
                  m.id === assistantId ? { ...m, toolCalls: calls } : m,
                ),
              })),
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

      // Вызовы инструментов в истории как assistant.tool_calls
      history.push({
        role: "assistant",
        content: null,
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
      const runOneSubagent = async (call: ToolCallInfo): Promise<void> => {
        let subContent: string;
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
          } else if (
            !subConfigRef.current.autonomous &&
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
        if (permMode === "plan" && mutating) {
          // Режим плана: запись и команды блокируются, модель должна
          // предъявить план, не трогая систему
          result = t("agent.planBlocked");
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
    // Если агент ждал подтверждения — отклоняем, цикл завершится
    confirmResolverRef.current?.("deny");
    confirmResolverRef.current = null;
    setPendingConfirm(null);
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
    setTyping(false);
  };




  const handleClearChat = () => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === activeId ? { ...s, messages: [] } : s)),
    );
  };

  const handleSetSystemPrompt = (prompt: string | null) => {
    if (!activeId) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, systemPrompt: prompt ?? undefined } : s,
      ),
    );
  };

  const handleSavePromptLibrary = (list: PromptPreset[]) => {
    setPromptLibrary(list);
    savePromptLibrary(list);
  };

  // Быстрая роль: применяется к активной задаче, если её нет — создаём
  const handleConfirmDecision = (d: "once" | "always" | "deny") => {
    confirmResolverRef.current?.(d);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  };

  // Открыть заметку. Принимает имя файла ИЛИ заголовок: как в Obsidian,
  // клик по ссылке на ещё не созданную заметку — создаёт её
  const handleOpenNote = async (fileOrTitle: string) => {
    const byFile = notes.find((n) => n.file === fileOrTitle);
    if (byFile) {
      setOpenNoteFile(fileOrTitle);
      return;
    }
    const byTitle = notes.find(
      (n) => n.title.toLowerCase() === fileOrTitle.toLowerCase(),
    );
    if (byTitle) {
      setOpenNoteFile(byTitle.file);
      return;
    }
    // Нет такой — создаём (заголовок = первая строка "# ...")
    if (/[\/]/.test(fileOrTitle) || fileOrTitle.includes("..")) return;
    const file = `note-${crypto.randomUUID().slice(0, 8)}.md`;
    const content = `# ${fileOrTitle}${"\n\n"}`;
    await notesWrite(file, content).catch(() => {});
    setNotes((prev) => [
      {
        file,
        title: fileOrTitle,
        content,
        updated: Math.floor(Date.now() / 1000),
      },
      ...prev,
    ]);
    setOpenNoteFile(file);
  };

  const handleNewNote = async () => {
    const file = `note-${crypto.randomUUID().slice(0, 8)}.md`;
    const content = `# ${t("notes.new")}\n\n`;
    await notesWrite(file, content).catch(() => {});
    setNotes((prev) => [
      { file, title: t("notes.new"), content, updated: Math.floor(Date.now() / 1000) },
      ...prev,
    ]);
    setOpenNoteFile(file);
  };

  const handleSaveNote = async (file: string, content: string) => {
    setNoteSaving(true);
    try {
      await notesWrite(file, content);
      const title =
        content
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("# "))
          ?.slice(2)
          .trim() || file.replace(/\.md$/, "");
      setNotes((prev) =>
        prev.map((n) =>
          n.file === file ? { ...n, content, title, updated: Math.floor(Date.now() / 1000) } : n,
        ),
      );
    } finally {
      setNoteSaving(false);
    }
  };

  const handleDeleteNote = async (file: string) => {
    await notesDelete(file).catch(() => {});
    setNotes((prev) => prev.filter((n) => n.file !== file));
    setOpenNoteFile(null);
  };

  // Заголовок из первой строки "# ..." (для списка и цепочек)
  const noteTitleOf = (content: string, file: string) =>
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("# "))
      ?.slice(2)
      .trim() || file.replace(/\.md$/, "");

  /** Сохранить и запустить цепочку шагов от этой заметки (M-N3) */
  const handleRunChain = async (file: string, content: string) => {
    await notesWrite(file, content).catch(() => {});
    const updated = notes.map((n) =>
      n.file === file
        ? { ...n, content, title: noteTitleOf(content, file), updated: Math.floor(Date.now() / 1000) }
        : n,
    );
    setNotes(updated);
    await runChain(file, updated);
  };

  const runChain = async (file: string, list?: Note[]) => {
    const src = list ?? notes;
    const start = src.find((n) => n.file === file);
    if (!start || chainRunning) return;
    const plan = buildChainPlan(src, file, 12);
    if (plan.length === 0) return;
    const anyAgent = plan.some((n) => parseNotePrompt(n.content).agent);

    // Цепочка живёт в отдельной задаче «⛓ ...»: контекст между шагами —
    // это история диалога, стриминг/отмена работают из коробки
    const session: Session = {
      id: uid(),
      title: `⛓ ${start.title}`,
      createdAt: Date.now(),
      messages: [],
      agentMode: anyAgent,
    };
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setOpenNoteFile(null);
    setGraphOpen(false);
    setChainRunning(true);
    chainAbortRef.current = false;
    const status: ChainStepStatus[] = plan.map(() => "pending");
    const state: ChainState = { plan, current: 0, status };
    setChain(state);
    setChainMonitorOpen(true);

    try {
      for (let i = 0; i < plan.length; i++) {
        if (chainAbortRef.current) {
          // Остаток цепочки помечаем пропущенным
          for (let k = i; k < plan.length; k++) status[k] = "skipped";
          setChain({ ...state, status: [...status] });
          break;
        }
        const { prompt } = parseNotePrompt(plan[i].content);
        if (!prompt) {
          status[i] = "skipped";
          setChain({ ...state, status: [...status] });
          continue;
        }
        status[i] = "running";
        setChain({ ...state, current: i, status: [...status] });
        await handleSend(prompt, undefined, session.id);
        status[i] = chainAbortRef.current ? "skipped" : "done";
        setChain({ ...state, current: i + 1, status: [...status] });
      }
    } finally {
      setChainRunning(false);
      setStreamingId(null);
      setTyping(false);
    }
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

  // Глобальный просмотр allowlist'ов: правка разрешений любой задачи
  const agentAllowlists = sessions
    .filter((s) => (s.allowedCommands?.length ?? 0) > 0)
    .map((s) => ({ id: s.id, title: s.title, commands: s.allowedCommands ?? [] }));

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

  const handleApplyPreset = (prompt: string) => {
    if (activeSession) {
      handleSetSystemPrompt(prompt);
      return;
    }
    const session: Session = {
      id: uid(),
      title: t("chat.new"),
      createdAt: Date.now(),
      messages: [],
      systemPrompt: prompt,
      projectId: activeProjectId ?? undefined,
    };
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
  };

  const handleTogglePin = (id: string) =>
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
    );

  const handleRenameCommit = (id: string, title: string) => {
    if (projects.some((p) => p.id === id)) {
      handleRenameProject(id, title);
    } else if (notes.some((n) => n.file === id)) {
      void handleRenameNote(id, title);
    } else {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title } : s)),
      );
    }
    setRenamingId(null);
  };

  const handleDuplicate = (id: string) =>
    setSessions((prev) => {
      const src = prev.find((s) => s.id === id);
      if (!src) return prev;
      const copy: Session = {
        id: uid(),
        title: `${src.title} ${t("session.copy")}`,
        createdAt: Date.now(),
        messages: src.messages.map((m) => ({ ...m, id: uid() })),
        pinned: src.pinned,
        projectId: src.projectId,
      };
      const next = [...prev];
      next.splice(prev.findIndex((s) => s.id === id) + 1, 0, copy);
      return next;
    });

  const handleDelete = (id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) setActiveId(null);
  };

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

  const handleAddProject = (name: string) => {
    setProjects((prev) => [
      ...prev,
      { id: `p-${crypto.randomUUID().slice(0, 8)}`, name },
    ]);
  };

  const handleRenameProject = (id: string, name: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p)),
    );
  };

  const handleDeleteProject = (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeProjectId === id) setActiveProjectId(null);
    // Задачи проекта остаются, но отвязываются от него
    setSessions((prev) =>
      prev.map((s) => (s.projectId === id ? { ...s, projectId: undefined } : s)),
    );
  };

  // Переименование заметки: правим первую строку "# ..."
  const handleRenameNote = async (file: string, title: string) => {
    const note = notes.find((n) => n.file === file);
    if (!note || !title.trim()) return;
    const lines = note.content.split("\n");
    const idx = lines.findIndex((l) => l.trim().startsWith("# "));
    if (idx >= 0) lines[idx] = `# ${title.trim()}`;
    else lines.unshift(`# ${title.trim()}`, "");
    await notesWrite(file, lines.join("\n")).catch(() => {});
    setNotes((prev) =>
      prev.map((n) =>
        n.file === file ? { ...n, title: title.trim(), content: lines.join("\n") } : n,
      ),
    );
  };

  const handleAssignProject = (id: string, projectId?: string) =>
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, projectId } : s,
      ),
    );

  const handleCopyTitle = async (title: string) => {
    try {
      await navigator.clipboard.writeText(title);
    } catch {
      // В WebView буфер может быть недоступен — молча игнорируем
    }
  };

  // Выбор из поиска: активируем задачу и синхронизируем фильтр проекта,
  // чтобы задача не «пропала» из списка
  const handleSearchSelect = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    setActiveProjectId(session?.projectId ?? null);
    setActiveId(id);
  };

  const menuProject = menu?.kind === "project" ? projects.find((p) => p.id === menu.id) : null;
  const menuNote = menu?.kind === "note" ? notes.find((n) => n.file === menu.id) : null;

  // ---------- Slash-команды (палитра "/" в поле ввода) ----------
  const slashCommands: SlashCommand[] = useMemo(() => {
    const roleNames = [
      ...builtinPresetsFor(lang).map((p) => p.name),
      ...promptLibrary.map((p) => p.name),
    ];
    const roleByName = (name: string) =>
      [...builtinPresetsFor(lang), ...promptLibrary].find((p) => p.name === name);
    const list = [
      {
        name: "new",
        desc: t("cmd.new"),
        run: () => handleNewChat(),
      },
      {
        name: "clear",
        desc: t("cmd.clear"),
        run: () => handleClearChat(),
      },
      {
        name: "agent",
        desc: t("cmd.agent"),
        run: () => handleToggleAgent(),
      },
      {
        name: "terminal",
        desc: t("cmd.terminal"),
        run: () => setTerminalOpen((v) => !v),
      },
      {
        name: "theme",
        desc: t("cmd.theme"),
        suggestions: () => [lang === "ru" ? "светлая" : "light"],
        run: () => setTheme((v) => (v === "dark" ? "light" : "dark")),
      },
      {
        name: "glass",
        desc: t("cmd.glass"),
        run: () => setGlass((v) => !v),
      },
      {
        name: "provider",
        desc: t("cmd.provider"),
        argHint: PROVIDERS.map((p) => p.label).join(" / "),
        suggestions: () => PROVIDERS.map((p) => p.label),
        run: (arg: string) => {
          const p = PROVIDERS.find(
            (x) => x.label.toLowerCase() === arg.toLowerCase() || x.id === arg.toLowerCase(),
          );
          if (p) {
            setApiSettings((prev) => ({ ...prev, base_url: p.baseUrl, provider: p.id }));
          }
        },
      },
      {
        name: "prompt",
        desc: t("cmd.prompt"),
        argHint: roleNames.join(" / "),
        suggestions: () => roleNames,
        run: (arg: string) => {
          const preset = roleByName(arg.trim());
          if (preset) handleApplyPreset(preset.text);
        },
      },
      {
        name: "note",
        desc: t("cmd.note"),
        argHint: t("cmd.noteHint"),
        suggestions: () => notes.map((n) => n.title),
        run: (arg: string) => {
          const title = arg.trim();
          if (title) void handleOpenNote(title);
        },
      },
      {
        name: "chain",
        desc: t("cmd.chain"),
        argHint: t("cmd.noteHint"),
        suggestions: () => notes.map((n) => n.title),
        run: (arg: string) => {
          const note = notes.find(
            (n) => n.title.toLowerCase() === arg.trim().toLowerCase(),
          );
          if (note) void handleRunChain(note.file, note.content);
        },
      },
    ];

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, notes, promptLibrary, chainRunning, userCommands]);

  const menuItems: MenuItem[] = menuProject
    ? [
        {
          label: t("menu.rename"),
          onSelect: () => setRenamingId(menuProject.id),
        },
        {
          label: confirmingDelete ? t("menu.deleteConfirm") : t("menu.delete"),
          danger: true,
          keepOpen: !confirmingDelete,
          onSelect: () => {
            if (confirmingDelete) {
              handleDeleteProject(menuProject.id);
            } else {
              setConfirmingDelete(true);
            }
          },
        },
      ]
    : menuNote
      ? [
          {
            label: t("menu.open"),
            onSelect: () => void handleOpenNote(menuNote.file),
          },
          {
            label: t("menu.rename"),
            onSelect: () => setRenamingId(menuNote.file),
          },
          {
            label: confirmingDelete ? t("menu.deleteConfirm") : t("menu.delete"),
            danger: true,
            separator: true,
            keepOpen: !confirmingDelete,
            onSelect: () => {
              if (confirmingDelete) {
                void handleDeleteNote(menuNote.file);
              } else {
                setConfirmingDelete(true);
              }
            },
          },
        ]
    : menuSession
    ? [
        {
          label: menuSession.pinned ? t("menu.unpin") : t("menu.pin"),
          onSelect: () => handleTogglePin(menuSession.id),
        },
        {
          label: t("menu.rename"),
          onSelect: () => setRenamingId(menuSession.id),
        },
        {
          label: t("menu.duplicate"),
          onSelect: () => handleDuplicate(menuSession.id),
        },
        {
          label: t("menu.copyTitle"),
          separator: true,
          onSelect: () => handleCopyTitle(menuSession.title),
        },
        ...projects
          .filter((p) => p.id !== menuSession.projectId)
          .map((p, i): MenuItem => ({
            label: t("menu.toProject", { name: p.name }),
            separator: i === 0,
            onSelect: () => handleAssignProject(menuSession.id, p.id),
          })),
        ...(menuSession.projectId
          ? [
              {
                label: t("menu.removeProject"),
                separator: projects.length > 0,
                onSelect: () => handleAssignProject(menuSession.id, undefined),
              } satisfies MenuItem,
            ]
          : []),
        {
          label: confirmingDelete ? t("menu.deleteConfirm") : t("menu.delete"),
          danger: true,
          separator: true,
          keepOpen: !confirmingDelete,
          onSelect: () => {
            if (confirmingDelete) {
              handleDelete(menuSession.id);
            } else {
              setConfirmingDelete(true);
            }
          },
        },
      ]
    : [];

  const openMenu = (id: string, x: number, y: number) => {
    setConfirmingDelete(false);
    setMenu({ id, x, y, kind: "session" });
  };

  return (
    <div
      className={`flex h-full overflow-hidden ${
        sidebarSide === "right" ? "flex-row-reverse" : ""
      }`}
    >
        <button
          onClick={() => setSidebarCollapsed(false)}
          title={t("sidebar.expand")}
          className={`absolute top-2 z-40 flex size-8 items-center justify-center rounded-lg text-halo-accent transition-all duration-200 hover:bg-halo-hover ${
            sparkVisible ? "opacity-100" : "pointer-events-none opacity-0"
          } ${
            sidebarSide === "right" ? "right-3" : "left-3"
          }`}
        >
          <span className="scale-125">
            <NocturnMark size={18} />
          </span>
        </button>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        projects={projects}
        activeProjectId={activeProjectId}
        activeId={activeId}
        renamingId={renamingId}
        onNewChat={handleNewChat}
        onSelect={setActiveId}
        onOpenSettings={() => {
          setSettingsSection("main");
          setSettingsOpen(true);
        }}
        onOpenPlugins={() => {
          setSettingsSection("plugins");
          setSettingsOpen(true);
        }}
        onOpenAutomations={() => setAutomationsOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        onSessionMenu={openMenu}
        onDeleteSession={handleDelete}
        onArchiveSession={handleArchiveSession}
        onTagSession={handleTagSession}
        onRenameCommit={handleRenameCommit}
        onRenameCancel={() => setRenamingId(null)}
        onAddProject={handleAddProject}
        onProjectMenu={(id, x, y) => {
          setConfirmingDelete(false);
          setMenu({ id, x, y, kind: "project" });
        }}
        onNoteMenu={(id, x, y) => {
          setConfirmingDelete(false);
          setMenu({ id, x, y, kind: "note" });
        }}
        onSelectProject={setActiveProjectId}
        projectRoot={projectRoot}
        onProjectRootChange={setProjectRoot}
        modifiedFiles={modifiedFiles}
        side={sidebarSide}
        width={sidebarWidth}
        showWindowControls={sidebarSide === "right"}
        notes={notes}
        activeNoteFile={openNoteFile}
        onOpenNote={(f) => void handleOpenNote(f)}
        onNewNote={() => void handleNewNote()}
        onOpenGraph={() => setGraphOpen(true)}
        onResizeStart={startSidebarResize}
        onResizeReset={() => setSidebarWidth(288)}
        onCollapse={() => setSidebarCollapsed(true)}
      />
      <ChatArea
        session={activeSession}
        typing={typing}
        activity={activity}
        onUndoWrite={handleUndoWrite}
        subRuns={subRuns}
        plan={activeSession?.plan}
        userCommands={[...pluginCommands, ...userCommands]}
        extraSkills={pluginSkills}
        onEditMessage={(msgId, text) =>
          void handleSend(text, undefined, activeId ?? undefined, undefined, msgId)
        }
        model={apiSettings.model}
        streamingMsgId={streamingId}
        visionCapable={
          apiStatus.models?.find((m) => m.id === apiSettings.model)?.vision
        }
        isLocal={/localhost|127\.0\.0\.1/.test(apiSettings.base_url)}
        agentMode={activeSession?.agentMode ?? false}
        permissionMode={activeSession?.permissionMode ?? "ask"}
        onPermissionModeChange={handleSetPermissionMode}
        pendingConfirm={pendingConfirm}
        onConfirmDecision={handleConfirmDecision}
        promptPresets={builtinPresetsFor(lang)}
        customPresets={promptLibrary}
        onSend={handleSend}
        queued={queuedMsgs.map((q) => ({ id: q.id, text: q.text }))}
        onQueue={(text, attachments, quote) =>
          setQueuedMsgs((prev) => [
            ...prev,
            { id: uid(), text, attachments, quote },
          ])
        }
        onQueuedRemove={(id) =>
          setQueuedMsgs((prev) => prev.filter((q) => q.id !== id))
        }
        onCorrect={(text) => {
          // streamingId — это requestId текущего прогона (см. handleStop:
          // abortedRef.current.add(streamingId))
          const rid = streamingId;
          if (!rid) return;
          // Реф обновляем синхронно: агентный цикл читает поправки между
          // шагами, не дожидаясь очередного рендера
          pendingCorrectionsRef.current = {
            ...pendingCorrectionsRef.current,
            [rid]: [...(pendingCorrectionsRef.current[rid] ?? []), text],
          };
          setPendingCorrections((prev) => ({
            ...prev,
            [rid]: [...(prev[rid] ?? []), text],
          }));
        }}
        onClearChat={handleClearChat}
        onStop={handleStop}
        onOpenSettings={() => {
          setSettingsSection("main");
          setSettingsOpen(true);
        }}
        onSetSystemPrompt={handleSetSystemPrompt}
        onApplyPreset={handleApplyPreset}
        onToggleAgent={handleToggleAgent}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        projectRoot={projectRoot}
        hideStarter={hideStarter}
        onToggleStarter={() => setHideStarter((v) => !v)}
        terminalHeightPct={terminalHeight}
        onTerminalResizeStart={startTerminalResize}
        scrollFollow={scrollFollow}
        streamSmooth={streamSmooth}
        streamCaret={streamCaret}
        showUserMsgs={showUserMsgs}
        groupTurns={groupTurns}
        chatMark={chatMark}
        msgGlass={msgGlass}
        showWindowControls={sidebarSide === "left"}
        headerInset={sidebarCollapsed ? sidebarSide : null}
        slashCommands={slashCommands}
        models={apiStatus.models ?? []}
        onModelChange={(id) => setApiSettings((prev) => ({ ...prev, model: id }))}
        effort={effort}
        onEffortChange={setEffort}
        theme={theme}
        appearance={appearance}
        onThemeChange={setTheme}
        onAppearanceChange={setAppearance}
        glass={glass}
        onGlassChange={setGlass}
      />
      {chainMonitorOpen && (
        <ChainMonitor
          chain={chain}
          onClose={() => setChainMonitorOpen(false)}
        />
      )}
      {graphOpen && (
        <GraphModal
          notes={notes}
          onOpenNote={(f) => {
            setGraphOpen(false);
            void handleOpenNote(f);
          }}
          onClose={() => setGraphOpen(false)}
        />
      )}
      <NotesModal
        note={notes.find((n) => n.file === openNoteFile) ?? null}
        allNotes={notes}
        saving={noteSaving}
        onSave={(f, c) => void handleSaveNote(f, c)}
        onRunChain={(f, c) => void handleRunChain(f, c)}
        onDelete={(f) => void handleDeleteNote(f)}
        onOpenNote={(f) => void handleOpenNote(f)}
        onClose={() => setOpenNoteFile(null)}
      />
      <SettingsModal
        open={settingsOpen}
        theme={theme}
        glass={glass}
        appearance={appearance}
        onAppearanceChange={setAppearance}
        themeProfiles={themeProfiles}
        onThemeProfilesChange={setThemeProfiles}
        onApplyThemeProfile={applyThemeProfile}
        limits={limits}
        onLimitsChange={setLimits}
        sidebarSide={sidebarSide}
        onSidebarSideChange={setSidebarSide}
        hideStarter={hideStarter}
        onHideStarterChange={setHideStarter}
        scrollFollow={scrollFollow}
        onScrollFollowChange={setScrollFollow}
        streamSmooth={streamSmooth}
        onStreamSmoothChange={setStreamSmooth}
        streamCaret={streamCaret}
        onStreamCaretChange={setStreamCaret}
        showUserMsgs={showUserMsgs}
        onShowUserMsgsChange={setShowUserMsgs}
        groupTurns={groupTurns}
        onGroupTurnsChange={setGroupTurns}
        notifyPrefs={notifyPrefs}
        onNotifyPrefsChange={setNotifyPrefs}
        plugins={plugins}
        onPluginsChange={setPlugins}
        subConfig={subConfigEffective}
        onSubConfigChange={(c) => {
          // роли из плагинов не пишем в свой конфиг — они приходят из плагина
          const pluginIds = new Set(pluginRoles.map((r) => r.id));
          const base = { ...c, roles: c.roles.filter((r) => !pluginIds.has(r.id)) };
          setSubConfig(base);
          subagentsSave(base).catch(() => {});
        }}
        sessions={sessions}
        settingsLarge={settingsLarge}
        browserPanel={browserAutoPanel}
        onBrowserPanelChange={(v) => {
          setBrowserAutoPanel(v);
          localStorage.setItem("haloui-browser-panel", v ? "1" : "0");
        }}
        binds={binds}
        customShortcuts={customShortcuts}
        availableCommands={slashCommands.map((c) => ({
          name: c.name,
          desc: c.desc,
          argHint: c.argHint,
        }))}
        onBindsChange={(b) => persistShortcuts(b, customShortcuts)}
        onCustomShortcutsChange={(c) => persistShortcuts(binds, c)}
        onSettingsLargeChange={setSettingsLarge}
        onEncryptionToggle={handleEncryptionToggle}
        chatMark={chatMark}
        onChatMarkChange={setChatMark}
        msgGlass={msgGlass}
        onMsgGlassChange={setMsgGlass}
        memoryEnabled={memoryEnabled}
        onMemoryChange={setMemoryEnabled}
        initialSection={settingsSection}
        apiSettings={apiSettings}
        apiStatus={apiStatus}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onAddProfile={handleAddProfile}
        onApplyProfile={handleApplyProfile}
        onDeleteProfile={handleDeleteProfile}
        promptLibrary={promptLibrary}
        ollamaModels={ollamaModels}
        allowedCommands={activeSession?.allowedCommands ?? []}
        allowedCommandsTitle={activeSession?.title ?? null}
        agentAllowlists={agentAllowlists}
        onSessionAllowedChange={handleSetSessionAllowed}
        onPromptLibraryChange={handleSavePromptLibrary}
        onAllowedCommandsChange={handleSetAllowedCommands}
        onThemeChange={setTheme}
        onGlassChange={setGlass}
        onApiChange={setApiSettings}
        onTestConnection={handleTestConnection}
        onSaveSettings={handleSaveSettings}
        onDetectOllama={detectLocal}
        onUseLocalModel={handleUseLocalModel}
        onClose={() => setSettingsOpen(false)}
      />
      <AutomationsModal
        open={automationsOpen}
        onClose={() => setAutomationsOpen(false)}
      />
      <BrowserPanel
        open={browserPanelOpen}
        onClose={() => setBrowserPanelOpen(false)}
      />
      <Toasts items={toasts} />
      {cryptoGate !== "none" && cryptoGate !== "loading" && (
        <CryptoGate
          setup={cryptoGate === "create"}
          intent={cryptoGate === "disable" ? "disable" : "unlock"}
          onSubmit={handleGateSubmit}
          onReset={cryptoGate === "unlock" ? handleGateReset : undefined}
          onCancel={
            cryptoGate === "create" || cryptoGate === "disable"
              ? handleGateCancel
              : undefined
          }
        />
      )}
      <SearchModal
        open={searchOpen}
        sessions={sessions}
        onSelect={handleSearchSelect}
        onClose={() => setSearchOpen(false)}
      />
      {menu && (menuSession || menuProject || menuNote) && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {/* Сплэш: поверх всего, убирается после фейда (onGone из Splash) */}
      {splashVisible && (
        <Splash done={splashDone} onGone={() => setSplashVisible(false)} />
      )}
    </div>
  );
}
