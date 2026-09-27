import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFile,
  PermissionMode,
  Project,
  Session,
  Theme,
  UsageEvent,
} from "./types";
import { useLang } from "./locales";
import {
  diffLines,
  diffStats,
  normalizePath,
  parseWriteResult,
} from "./diff";
import { DiffPanel, type DiffPanelFile } from "./components/DiffPanel";
import { PlanSidePanel } from "./components/PlanSidePanel";
import { checkpointFiles } from "./api";
import {
  firstConfirm,
} from "./interactions";
import CryptoGate from "./components/CryptoGate";
import { useAgentRun } from "./hooks/useAgentRun";


import {
  loadSettings,
  saveSettings,
  loadProjectsStore,
  saveProjectsStore,
  testConnection,
  runTool,
  invalidateToolSchemas,
  mcpAutoconnect,
  notesList,
  notesRead,
  notesWrite,
  notesDelete,
  keepAwake,
  onClearDataRequest,
  onQuickEntryTask,
  quickentrySetBind,
  factoryReset,
} from "./api";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useApiSettings } from "./hooks/useApiSettings";
import { useSessions } from "./hooks/useSessions";
import {
  loadPromptLibrary,
  savePromptLibrary,
  builtinPresetsFor,
  type PromptPreset,
} from "./presets";
import Sidebar from "./components/Sidebar";
import NocturnMark from "./components/NocturnMark";
import Splash from "./components/Splash";
import Onboarding, { type OnboardingResult } from "./components/Onboarding";
import ResetConfirmModal from "./components/ResetConfirmModal";


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
import { PROVIDERS, shortcutsLoad, shortcutsSave } from "./api";
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
import { loadNotifyPrefs, saveNotifyPrefs, type NotifyPrefs } from "./notify";
import { subagentsLoad, subagentsSave, commandsLoad, pluginsLoad, type Plugin, type UserCommand } from "./api";
import {
  parseSubagentsConfig,
} from "./subagents";
import { loadLimits, saveLimits, type HardLimits } from "./limits";
import { uid } from "./hooks/useAgentRun";
import { useToasts } from "./hooks/useToasts";
import { registerCustomFonts } from "./fonts";
import { TERMINAL_PALETTES } from "./vt";
import { useAppearanceUi } from "./hooks/useAppearanceUi";
import { useBoolPref, useNumPref, useStringPref } from "./hooks/usePrefs";
import { withViewTransition } from "./motion";
import HardTerminal from "./components/HardTerminal";
import { AmbientLayer } from "./components/AmbientLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";

const clampNum = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export default function App() {
  const { lang, t } = useLang();
  // Проекты: единственный источник истины — projects.json (загружается
  // ниже при старте). Демо-проекты не создаём: список стартует пустым
  // и наполняется только вручную («+» во вкладке «Проекты»)
  const [projects, setProjects] = useState<Project[]>([]);
  const projectsLoadedRef = useRef(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Раздел настроек для программного открытия (плагины из сайдбара)
  const [settingsSection, setSettingsSection] = useState<Section | null>(null);
  // Пользовательские шрифты: регистрация FontFace после старта
  // (userCss перенесён в main.tsx до первого рендера — без FOUC)
  useEffect(() => {
    void registerCustomFonts();
  }, []);

  // Автообновление: разовая проверка после старта (native-only, тихо)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdate({
        available: (v) => window.confirm(t("upd.available", { v })),
        installed: () => addToast(t("upd.installed")),
      });
    }, 8000);
    return () => window.clearTimeout(timer);
    // mount-only: разовая проверка за сессию — t/addToast сознательно не
    // в deps, иначе смена языка перезапускала бы проверку обновления
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Экран «Автоматизации»
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // Плавающие уведомления (чекпоинты и пр.) — без строк в чате
  const { toasts, addToast } = useToasts();
  // Панель живого просмотра браузера агента + тумблер автооткрытия
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false);
  const [browserAutoPanel, setBrowserAutoPanel] = useBoolPref(
    "haloui-browser-panel",
    true,
  );
  const browserAutoPanelRef = useRef(browserAutoPanel);
  useEffect(() => {
    browserAutoPanelRef.current = browserAutoPanel;
  }, [browserAutoPanel]);
  // Сплэш: держится, пока грузятся хранилища (splashDone) + минимальная
  // выдержка внутри Splash; после фейда Splash зовёт onGone — убираем его
  const [splashDone, setSplashDone] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);
  // Онбординг первого запуска: показываем после загрузки хранилищ (splashDone);
  // флаг haloui-onboarded ставится по завершению визарда или «Пропустить всё»
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !localStorage.getItem("haloui-onboarded"),
  );
  // Полный сброс из трея: подтверждение спрашиваем модалкой в окне
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

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

  // ---------- Review: живой дифф прогона в правой панели ----------
  const [diffReview, setDiffReview] = useState<{
    open: boolean;
    files: DiffPanelFile[];
  }>({ open: false, files: [] });

  // ---------- Панель плана (Plan Mode): авто-открытие при смене режима ----------
  const [planPanelOpen, setPlanPanelOpen] = useState(false);

  // ---------- Цитата из Review-панели: клик по строке диффа → композер ----------
  // nonce заставляет ChatArea реагировать и на повторный клик по той же строке
  const [diffQuote, setDiffQuote] = useState<{ text: string; nonce: number } | null>(null);
  const handleDiffQuote = useCallback((path: string, line: number, text: string) => {
    setDiffQuote((prev) => ({
      text: `${path}:${line}${text.trim() ? `\n${text.trim()}` : ""}`,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  // Домен «Оформление»: тема, стекло, кастомизация, профили вида
  const {
    theme,
    setTheme,
    glass,
    setGlass,
    appearance,
    setAppearance,
    themeProfiles,
    setThemeProfiles,
    applyThemeProfile,
  } = useAppearanceUi();
  // Эргономика: сторона сайдбара, скрытие стартовых подсказок,
  // ширина сайдбара и высота терминала (всё — drag/настройки, с запоминанием)
  const [sidebarSide, setSidebarSide] = useStringPref<"left" | "right">(
    "haloui-sidebar-side",
    "left",
  );
  const [hideStarter, setHideStarter] = useBoolPref("haloui-hide-starter", false);
  // Заметки (M-N1): список + открытая заметка
  const [notes, setNotes] = useState<Note[]>([]);
  const [openNoteFile, setOpenNoteFile] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [chainRunning, setChainRunning] = useState(false);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [chainMonitorOpen, setChainMonitorOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useBoolPref(
    "haloui-sidebar-collapsed",
    false,
  );
  const [sidebarWidth, setSidebarWidth] = useNumPref(
    "haloui-sidebar-width",
    340,
    // Старые дефолты (288/320) не влезали в текущий контент — мигрируем
    (v) => (isNaN(v) || v === 288 || v === 320 ? 340 : clampNum(v, 220, 440)),
  );
  const [terminalHeight, setTerminalHeight] = useNumPref(
    "haloui-terminal-height",
    42,
    (v) => clampNum(isNaN(v) ? 42 : v, 25, 70),
  );
  // Поведение генерации: скролл и печать
  const [scrollFollow, setScrollFollow] = useBoolPref("haloui-scroll-follow", false);
  const [streamSmooth, setStreamSmooth] = useBoolPref("haloui-stream-smooth", true);
  // Скорость плавной печати: множитель догоняющего темпаAssistantCard
  // Hard-Mode: терминальный скин (моношрифт, без стекла/скруглений/ambient)
  // Тумблер в «Основном» только РАЗРЕШАЕТ режим; вход/выход — хоткей
  // hard_mode (дефолт Ctrl+Shift+H, переназначается)
  const [hardMode, setHardMode] = useBoolPref("haloui-hard-mode", false);
  const [hardSkin, setHardSkin] = useBoolPref("haloui-hard-skin", false);
  const hardModeRef = useRef(hardMode);
  const hardSkinRef = useRef(hardSkin);
  useEffect(() => {
    hardModeRef.current = hardMode;
    hardSkinRef.current = hardSkin;
    if (!hardMode) setHardSkin(false); // тумблер выключен — скин снимается
  }, [hardMode, hardSkin, setHardSkin]);
  const [printSpeed, setPrintSpeed] = useNumPref("haloui-print-speed", 1, (v) =>
    [0.5, 1, 2].includes(v) ? v : 1,
  );
  // Рассуждения: раскрывать блок размышлений автоматически
  const [showReasoning, setShowReasoning] = useBoolPref("haloui-show-reasoning", false);
  // Вид ленты по умолчанию: normal — только ответы, thinking — с размышлениями,
  // verbose — плюс сообщения пользователя; сегмент в «Основном» двигает обе prefs
  const [transcriptView, setTranscriptView] = useStringPref<"normal" | "thinking" | "verbose">(
    "haloui-transcript-view",
    "normal",
  );
  // Автопродолжение ask_user: вопрос без ответа 5 минут — агент продолжит сам
  const [askAutoContinue, setAskAutoContinue] = useBoolPref("haloui-ask-auto-continue", true);
  // Оболочка консоли терминала: auto | powershell | cmd | gitbash
  const [termShell, setTermShell] = useStringPref<string>("haloui-term-shell", "auto");
  // Скрывать в трей при закрытии окна (выход — из меню трея)
  const [closeToTray, setCloseToTray] = useBoolPref("haloui-close-to-tray", false);
  // Авто-архив: старые задачи (без пина, старше срока) уходят в архив
  const [autoArchive, setAutoArchive] = useBoolPref("haloui-auto-archive", false);
  const [archiveRetention, setArchiveRetention] = useNumPref(
    "haloui-archive-retention",
    7,
    (v) => (v === 3 || v === 30 ? v : 7),
  );
  const [streamCaret, setStreamCaret] = useBoolPref("haloui-stream-caret", true);
  // Показ сообщений пользователя в чате (можно скрыть — останутся только ответы)
  const [showUserMsgs, setShowUserMsgs] = useBoolPref("haloui-show-user-msgs", true);
  // Объединять весь ход агента (мысли + команды + результаты + текст)
  // в одну карточку ответа; иначе каждый шаг — отдельная карточка
  const [groupTurns, setGroupTurns] = useBoolPref("haloui-group-turns", true);
  // Журнал использования (раздел «Статистика»): одна запись на отправку
  const [usageLog, setUsageLog] = useState<UsageEvent[]>(() => {
    try {
      const raw = localStorage.getItem("haloui-usage");
      return raw ? (JSON.parse(raw) as UsageEvent[]) : [];
    } catch {
      return [];
    }
  });
  // Зеркало для отложенного флаша (flush-эффект монтируется один раз)
  const usageLogRef = useRef(usageLog);
  useEffect(() => {
    usageLogRef.current = usageLog;
  }, [usageLog]);
  // Окно настроек по умолчанию большое (отдельное окно ~1200×820), а не компактное
  const [settingsLarge, setSettingsLarge] = useBoolPref("haloui-settings-large", false);
  // Память проектов: контекст предыдущих задач в новых сессиях
  const [memoryEnabled, setMemoryEnabled] = useBoolPref("haloui-memory", false);
  // Призрачный логотип на фоне чата
  const [chatMark, setChatMark] = useBoolPref("haloui-chat-mark", true);
  // Эффект стекла на карточках ответов ИИ
  const [msgGlass, setMsgGlass] = useBoolPref("haloui-msg-glass", false);

  // Saved-тост (фидбек 26.09): изменения в открытых настройках не тостят
  // вовсе (слайдер масштаба хоть по 1% — ни одного лишнего окна); один тост
  // «Сохранено» — при закрытии модалки, если что-то менялось
  const settingsTouchedRef = useRef(false);
  const settingsFingerprint = useMemo(
    () => JSON.stringify(appearance) + theme + String(glass),
    [appearance, theme, glass],
  );
  const prevFingerprintRef = useRef<string | null>(null);
  useEffect(() => {
    // prev-хук: изменение отпечатка ВНУТРИ открытых настроек = dirty;
    // монтирование и само открытие «изменением» не считаются
    if (!settingsOpen) {
      prevFingerprintRef.current = null;
      return;
    }
    if (prevFingerprintRef.current !== null && prevFingerprintRef.current !== settingsFingerprint) {
      settingsTouchedRef.current = true;
    }
    prevFingerprintRef.current = settingsFingerprint;
  }, [settingsFingerprint, settingsOpen]);
  const closeSettings = useCallback(() => {
    if (settingsTouchedRef.current) {
      settingsTouchedRef.current = false;
      addToast(t("settings.saved"));
    }
    setSettingsOpen(false);
  }, [addToast, t]);

  const [searchOpen, setSearchOpen] = useState(false);
  // Терминальный режим (M4.5): панель снизу
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Реф «идёт ли стрим» — пишется из streamingId агента ниже; читается автосейвом
  const streamingActiveRef = useRef(false);
  // Домен «Задачи»: данные сессий, загрузка истории, автосейв, мутаторы
  const {
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
  } = useSessions({
    addToast,
    autoArchive,
    archiveRetention,
    setUsageLog,
    streamingActiveRef,
  });

  // Домен «Подключение к ИИ»: настройки, профили, шифрование, статус соединения
  const {
    apiSettings,
    setApiSettings,
    apiStatus,
    setApiStatus,
    profiles,
    activeProfileId,
    cryptoGate,
    ollamaModels,
    loadInitial,
    detectLocal,
    handleTestConnection,
    handleSaveSettings,
    handleEncryptionToggle,
    handleGateSubmit,
    handleGateReset,
    handleGateCancel,
    handleAddProfile,
    handleApplyProfile,
    handleDeleteProfile,
    handleUseLocalModel,
  } = useApiSettings({ activeId, sessions, setSessions, appearance });
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
  const [promptLibrary, setPromptLibrary] = useState<PromptPreset[]>(() =>
    loadPromptLibrary(),
  );
  // Корневая папка проекта для файлового менеджера (M4.2), помнит выбор
  const [projectRoot, setProjectRoot] = useState<string | null>(() =>
    localStorage.getItem("haloui-project-root"),
  );
  // projectRoot для агентного цикла: актуальное значение через реф
  const projectRootRef = useRef<string | null>(projectRoot);
  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    kind: "session" | "project" | "note";
  } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Тема применяется мгновенно и запоминается — в useAppearanceUi (S7:
  // здесь был дословный дубль эффекта, два источника правды разъезжались
  // бы при правке одного из них)

  // «Не давать ПК уснуть»: тумблер переживает перезапуск, но ОС-уровневый
  // флаг сбрасывается вместе с процессом — восстанавливаем при старте
  useEffect(() => {
    if (localStorage.getItem("haloui-keep-awake") === "1") {
      void keepAwake(true).catch(() => {});
    }
  }, []);

  // Корневая папка файлового менеджера запоминается между запусками
  useEffect(() => {
    if (projectRoot) localStorage.setItem("haloui-project-root", projectRoot);
    else localStorage.removeItem("haloui-project-root");
  }, [projectRoot]);

  // Заметки загружаются при старте
  const refreshNotes = useCallback(async () => {
    try {
      const metas = await notesList();
      // C16: последовательные await на каждую заметку висили на старте
      // суммой латентностей IPC; ошибка одной заметки абортит весь список.
      // Параллельно, с per-item фолбэком
      const full = await Promise.all(
        metas.map(async (m): Promise<Note> => {
          try {
            const content = await notesRead(m.file);
            return { ...m, content };
          } catch {
            return { ...m, content: "" };
          }
        }),
      );
      setNotes(full);
    } catch {
      // нет папки заметок — пусто
    }
  }, []);
  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

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

  // Журнал использования: stringify до 5000 записей на каждый чейндж —
  // синхронный на главном потоке. Пишем отложенно (dirty + интервал +
  // beforeunload), как автосейв сессий
  const usageDirtyRef = useRef(false);
  useEffect(() => {
    usageDirtyRef.current = true;
  }, [usageLog]);
  useEffect(() => {
    const flushUsage = () => {
      if (!usageDirtyRef.current) return;
      usageDirtyRef.current = false;
      localStorage.setItem("haloui-usage", JSON.stringify(usageLogRef.current.slice(-4999)));
    };
    const id = window.setInterval(flushUsage, 10_000);
    window.addEventListener("beforeunload", flushUsage);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("beforeunload", flushUsage);
    };
  }, []);

  // Drag-ресайз сайдбара и терминала: слушатели вешаются один раз,
  // активная зона выбирается рефом на mousedown
  const resizeRef = useRef<"sidebar" | "terminal" | null>(null);
  useEffect(() => {
    let resizeRaf = 0;
    const clearResize = () => {
      if (resizeRef.current) {
        resizeRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Возвращаем плавные переходы ширины/высоты после перетаскивания
        delete document.body.dataset.resizing;
      }
    };
    const onMove = (e: MouseEvent) => {
      // Кнопку отпустили за пределами окна — mouseup не приходит,
      // поэтому сбрасываем сами, как только видим «пустую» кнопку
      if (e.buttons === 0) {
        clearResize();
        return;
      }
      // rAF-троттлинг: setState на каждый mousemove ре-рендерил всё
      // дерево App на каждый пиксель перетаскивания
      if (resizeRaf !== 0) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (resizeRef.current === "sidebar") {
          const x = sidebarSide === "right" ? window.innerWidth - e.clientX : e.clientX;
          setSidebarWidth(clampNum(x, 220, 440));
        } else if (resizeRef.current === "terminal") {
          // Секция чата занимает всю высоту окна
          const pct = ((window.innerHeight - e.clientY) / window.innerHeight) * 100;
          setTerminalHeight(clampNum(Math.round(pct), 25, 70));
        }
      });
    };
    const onUp = () => clearResize();
    const onBlur = () => clearResize();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
    };
    // setSidebarWidth/setTerminalHeight — стабильные useState-сеттеры из
    // useNumPref; перечислены явно: сквозь хук линтер стабильности не видит
  }, [sidebarSide, setSidebarWidth, setTerminalHeight]);

  const startSidebarResize = () => {
    resizeRef.current = "sidebar";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Без transition-[width]: иначе панель «плывёт» за курсором
    document.body.dataset.resizing = "1";
  };
  const startTerminalResize = () => {
    resizeRef.current = "terminal";
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.body.dataset.resizing = "1";
  };

  // Загружаем сохранённые настройки API и историю при старте
  useEffect(() => {
    // Домен API: настройки + профили + гейт пароля (внутри хука)
    const apiReady = loadInitial();
    // Проекты: миграция из localStorage в projects.json
    const projectsReady = loadProjectsStore()
      .then((recs) => {
        if (Array.isArray(recs) && recs.length > 0) {
          setProjects(
            // Диск не доверяем: битая запись (name: null и т.п.) раньше
            // доезжала до UI как undefined и падала в рендере сайдбара
            recs.flatMap((r) => {
              if (typeof r !== "object" || r === null) return [];
              const rec = r as Record<string, unknown>;
              if (typeof rec.id !== "string" || typeof rec.name !== "string") return [];
              return [
                {
                  id: rec.id,
                  name: rec.name,
                  profileId:
                    typeof rec.profile_id === "string" ? rec.profile_id : undefined,
                  accent: typeof rec.accent === "string" ? rec.accent : undefined,
                },
              ];
            }),
          );
        }
        // пусто в файле — остаётся localStorage-состояние, автосейв запишет его
      })
      .catch(() => {})
      .finally(() => {
        projectsLoadedRef.current = true;
      });
    const historyReady = loadHistory();
    // Сплэш: приложение готово, когда все хранилища прочитаны
    // (ошибки не мешают готовности — .finally уже отработал в каждом)
    void Promise.all([apiReady, projectsReady, historyReady]).then(() =>
      setSplashDone(true),
    );
    // mount-only: загрузка выполняется один раз за сессию; autoArchive/
    // archiveRetention/addToast/t — снимок на момент старта, повторный
    // запуск эффекта при их смене перечитывал бы хранилища заново
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Автосохранение проектов (projects.json, миграция из localStorage)
  useEffect(() => {
    if (!projectsLoadedRef.current) return;
    const t = window.setTimeout(() => {
      saveProjectsStore(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          profile_id: p.profileId ?? "",
          accent: p.accent ?? null,
        })),
      ).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [projects]);

  // Создание задачи с наследованием профиля проекта. Используется и для
  // «Новая задача», и для предварительного включения тумблеров (агент/режим/
  // промт/инструменты) до того, как чат существует
  const createChat = useCallback(
    (over: Partial<Session>): void => {
      const project = projects.find((p) => p.id === activeProjectId);
      const session: Session = {
        id: uid(),
        title: t("chat.new"),
        createdAt: Date.now(),
        messages: [],
        projectId: activeProjectId ?? undefined,
        profileId: activeProfileId || project?.profileId || undefined,
        ...over,
      };
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
    },
    [activeProjectId, activeProfileId, projects, t, setSessions, setActiveId],
  );

  // Opt-in «Тема из профиля»: при переключении профиля (или открытии чата,
  // привязанного к нему) применяется сохранённое в профиле оформление
  const profileThemeOn = appearance.profileTheme ?? false;
  useEffect(() => {
    if (!profileThemeOn) return;
    const p = profiles.find((x) => x.id === activeProfileId);
    if (!p?.appearance) return;
    setAppearance((cur) => ({ ...cur, ...p.appearance }));
  }, [profileThemeOn, activeProfileId, profiles, setAppearance]);

  // Opt-in «Акцент проекта»: при выборе проекта применяется его акцент.
  // При выходе из проекта акцент остаётся текущим (меняется вручную)
  const projectAccentOn = appearance.projectAccent ?? false;
  useEffect(() => {
    if (!projectAccentOn || !activeProjectId) return;
    const acc = projects.find((p) => p.id === activeProjectId)?.accent;
    if (acc) setAppearance((cur) => ({ ...cur, accent: acc }));
  }, [projectAccentOn, activeProjectId, projects, setAppearance]);

  // Акцент проекта: инлайн-редактор hex вместо window.prompt — в Tauri
  // WebView prompt всегда возвращает null (как и для тегов в Sidebar)
  const [accentEdit, setAccentEdit] = useState<{ id: string; value: string } | null>(null);
  const handleProjectAccent = (id: string) => {
    setAccentEdit({ id, value: projects.find((p) => p.id === id)?.accent ?? "" });
  };
  const commitProjectAccent = (raw: string) => {
    if (!accentEdit) return;
    const hex = raw.trim();
    if (hex !== "" && !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      // Невалидный ввод: тост, диалог остаётся открытым для правки
      addToast(t("menu.projectAccentBad"));
      return;
    }
    setProjects((prev) =>
      prev.map((p) => (p.id === accentEdit.id ? { ...p, accent: hex || undefined } : p)),
    );
    setAccentEdit(null);
  };

  const handleNewChat = useCallback(() => {
    // Переход к пустой ленте — через View Transition (кроссфейд ленты)
    withViewTransition(() => {
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
    });
  // sessionsRef/setActiveId/setSessions — стабильные (реф и useState-сеттеры
  // из useSessions); перечислены явно: сквозь хук линтер стабильности не видит
  }, [
    activeId,
    activeProjectId,
    activeProfileId,
    projects,
    t,
    sessionsRef,
    setActiveId,
    setSessions,
  ]);

  // MCP: автоконнект включённых серверов при старте (фоново, ошибки молча)
  useEffect(() => {
    mcpAutoconnect()
      .then(() => invalidateToolSchemas())
      .catch(() => {});
  }, []);

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
  // Производные сущности плагинов — useMemo: без него четыре flatMap
  // выполнялись на каждый рендер App и уезжали вниз новыми ссылками
  const enabledPlugins = useMemo(
    () => plugins.filter((p) => p.enabled),
    [plugins],
  );
  const pluginCommands = useMemo(
    () => enabledPlugins.flatMap((p) => p.commands ?? []),
    [enabledPlugins],
  );
  const pluginSkills = useMemo(
    () => enabledPlugins.flatMap((p) => p.skills ?? []),
    [enabledPlugins],
  );
  const pluginRoles = useMemo(
    () => enabledPlugins.flatMap((p) => p.roles ?? []),
    [enabledPlugins],
  );
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
  // Стабильная ссылка: [...a, ...b] в пропсах на каждый рендер ломал бы
  // будущую мемоизацию потребителей
  const mergedUserCommands = useMemo(
    () => [...pluginCommands, ...userCommands],
    [pluginCommands, userCommands],
  );
  useEffect(() => {
    commandsLoad()
      .then(setUserCommands)
      .catch(() => {});
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
  // ---------- Агентный движок: стримы, инструментальные циклы, взаимодействия ----------
  const {
    handleSend,
    handleStop,
    handleSendRef,
    typing,
    activity,
    streamingId,
    streamingAssistantId,
    activeRunRef,
    runStartedRef,
    streamingTargetRef,
    subRuns,
    queuedMsgs,
    setQueuedMsgs,
    setPendingCorrections,
    pendingCorrectionsRef,
    interactions,
    handleConfirmDecision,
    handleAskAnswer,
    chainAbortRef,
    lastCheckpointRef,
  } = useAgentRun({
    setSessions,
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
  });
  // Для автосейва: активный стрим. Эффект вместо записи в теле рендера —
  // под React Compiler мутация ref во время рендера вне модели
  useEffect(() => {
    streamingActiveRef.current = streamingId !== null;
  }, [streamingId]);

  // C9: стабильные обёртки для колбэков движка — handleSend/handleStop
  // пересоздаются каждый рендер (heavy-хук), а ChatArea получает их пропсами.
  // handleSendRef внутри хука уже держит свежую версию — читаем через ref
  const stableHandleSend = useCallback<typeof handleSend>(
    (...args) => handleSendRef.current?.(...args) ?? Promise.resolve(),
    [handleSendRef],
  );
  const handleStopRef = useRef(handleStop);
  useEffect(() => {
    handleStopRef.current = handleStop;
  });
  const stableHandleStop = useCallback(() => handleStopRef.current(), []);

  // Quick Entry: Enter во втором окне → новая задача с текстом. Движок
  // однопоточный: при живом прогоне показываем тост, иначе handleSend
  // молча отбросил бы текст (guard внутри)
  useEffect(() => {
    // StrictMode double-mount: см. комментарий у onClearDataRequest
    let disposed = false;
    let un: (() => void) | undefined;
    void onQuickEntryTask((text) => {
      if (disposed) return;
      if (activeRunRef.current !== null) {
        addToast(t("quickentry.busy"));
        return;
      }
      void stableHandleSend(text);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [activeRunRef, addToast, t, stableHandleSend]);

  // Quick Entry: применить сохранённый ремап комбо (дефолт уже зарегистрирован
  // на бекенде в setup; промах — комбо занято другим приложением, остаётся
  // дефолт: молча это выглядело как «настройка не работает»)
  useEffect(() => {
    const saved = localStorage.getItem("haloui-quickentry-bind");
    if (saved)
      void quickentrySetBind(saved).catch(() => {
        addToast(t("main.quickentryBindFail"));
      });
  }, [addToast, t]);

  // pendingConfirm/pendingAsk раньше считались IIFE прямо в JSX: новый объект
  // каждый рендер убивал сравнение пропсов у карточек-подтверждений
  const pendingConfirm = useMemo(() => {
    const c = firstConfirm(interactions);
    return c && c.kind === "confirm"
      ? { requestId: c.requestId, call: c.call }
      : null;
  }, [interactions]);
  const pendingAsk = useMemo(() => {
    const a = interactions.find((i) => i.kind === "ask");
    return a && a.kind === "ask"
      ? { msgId: a.msgId, ask: { ...a.spec } }
      : null;
  }, [interactions]);
  const queuedProps = useMemo(
    () => queuedMsgs.map((q) => ({ id: q.id, text: q.text })),
    [queuedMsgs],
  );

  // Ambient-фон: во время стрима анимация на паузе — батарея и FPS важнее
  // (эффект здесь, ниже деструктуризации streamingId)
  useEffect(() => {
    document.documentElement.classList.toggle("ambient-paused", streamingId !== null);
  }, [streamingId]);

  // Обои: класс на html — CSS делает сайдбар/чат чуть прозрачными,
  // чтобы фон уходил за сайдбар (раньше обои обрывались на его границе)
  useEffect(() => {
    document.documentElement.classList.toggle(
      "has-wallpaper",
      Boolean(appearance.chatWallpaper),
    );
  }, [appearance.chatWallpaper]);

  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : null;

  // Файлы, изменённые агентом в активной задаче (M4.3) — для подсветки в дереве.
  // C7: дорогой пересчёт (JSON.parse содержимого before/after) отсечён от
  // ежекадровых флешей стрима — дешёвый ключ (id fs_write-результатов)
  // меняется только когда реально появился новый результат записи
  const writeKey = useMemo(() => {
    let key = "";
    for (const m of activeSession?.messages ?? []) {
      if (m.role === "tool" && m.toolName === "fs_write") key += `${m.id}|`;
    }
    return key;
  }, [activeSession]);
  const modifiedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const m of activeSession?.messages ?? []) {
      if (m.role !== "tool" || m.toolName !== "fs_write") continue;
      const w = parseWriteResult(m.content);
      if (w?.path) set.add(normalizePath(w.path));
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ключ отсекает ежекадровый пересчёт
  }, [writeKey]);

  // ---------- Review: живой дифф прогона в правой панели ----------
  // fs_write-диффы берутся мгновенно из результатов инструментов; чекпоинт
  // прогона покрывает правки мимо fs_write (shell и т.п.): «снимок до ↔
  // файл на диске сейчас». Бинарники и файлы крупнее капа — пропускаем
  const handleReviewChanges = useCallback(
    async (fsWrites: ChangedFile[]) => {
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      const decode = (b64: string): string | null => {
        try {
          const bin = atob(b64);
          return utf8.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        } catch {
          return null;
        }
      };
      const byPath = new Map<string, DiffPanelFile>();
      const push = (
        path: string,
        before: string | null,
        after: string,
        created: boolean,
      ) => {
        const s = diffStats(diffLines(before ?? "", after));
        const dir = path.replace(/[\\/][^\\/]+$/, "");
        byPath.set(normalizePath(path), {
          path,
          base: path.slice(dir ? dir.length + 1 : 0),
          dir,
          added: s.added,
          removed: s.removed,
          created,
          before,
          after,
        });
      };
      for (const f of fsWrites) push(f.path, f.before, f.after, f.created);
      const cp = lastCheckpointRef.current;
      if (cp) {
        try {
          const states = await checkpointFiles(cp.root, cp.id);
          for (const st of states) {
            const before = decode(st.before);
            const after = st.current ? decode(st.current) : "";
            if (before == null || after == null) continue;
            // Чекпоинт приоритетнее fs_write: он видит итог всего прогона
            push(st.rel, before, after, false);
          }
        } catch {
          // снимок недоступен (ротация CP_KEEP/удалён) — остаётся fs_write
        }
      }
      setDiffReview({ open: true, files: [...byPath.values()] });
    },
    // ref стабилен; включён для exhaustive-deps
    [lastCheckpointRef],
  );

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
      // FIX [re-entrancy]: раньше тик запускал второй прогон поверх идущего:
      // streamingId перезаписывался, finalize/Stop гасили чужой стрим.
      // Занятый движок = тик пропускается; nextRunAt не двигаем, запуск
      // произойдёт на ближайшем тике после освобождения — промт не теряется.
      if (activeRunRef.current) return;
      // Без настроенного API запуск бессмыслен — сдвигаем срок, не спамим
      if (
        apiSettingsRef.current.api_key.trim() === "" ||
        apiSettingsRef.current.model.trim() === ""
      ) {
        due.nextRunAt = nextRunAfter(due, now);
        saveAutomations(autos);
        return;
      }
      const session: Session = {
        id: uid(),
        title: due.name.slice(0, 48),
        createdAt: now,
        messages: [],
      };
      const send = handleSendRef.current;
      // FIX: отметку «выполнен» ставим только когда отправка реально возможна —
      // раньше прогон записывался и переносился ДО проверки send и терялся
      if (!send) return;
      due.lastRunAt = now;
      due.runs = [...(due.runs ?? []), now].slice(-10);
      due.nextRunAt = nextRunAfter(due, now);
      saveAutomations(autos);
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      const prompt = due.toVault ? due.prompt + VAULT_REPORT_SUFFIX : due.prompt;
      void send(prompt, undefined, session.id);
    }, 30000);
    return () => clearInterval(timer);
    // activeRunRef/handleSendRef — рефы со стабильной идентичностью;
    // тикер автоматизаций mount-only по замыслу
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Диспетчер действий биндов — актуальные обработчики через реф.
  // Эффект без deps вместо присваивания в теле рендера (React Compiler)
  const dispatchShortcutRef = useRef<(a: ShortcutAction) => void>(() => {});
  useEffect(() => {
    dispatchShortcutRef.current = (action: ShortcutAction) => {
    switch (action) {
      case "new_task":
        handleNewChatRef.current();
        break;
      case "search":
        withViewTransition(() => setSearchOpen(true));
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
      case "toggle_fullscreen":
        void invoke("window_toggle_fullscreen").catch(() => {});
        break;
      case "hard_mode":
        if (hardModeRef.current) setHardSkin((v) => !v);
        else addToast(t("hard.needEnable"));
        break;
      case "cycle_perm_mode": {
        if (!activeId) break;
        const order: PermissionMode[] = ["ask", "plan", "edit", "full"];
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeId) return s;
            const idx = order.indexOf(s.permissionMode ?? "ask");
            const next = order[(idx + 1) % order.length];
            // План-режим — открыть панель плана (авто-открытие, Волна 3)
            if (next === "plan") setPlanPanelOpen(true);
            return { ...s, permissionMode: next };
          }),
        );
        break;
      }
    }
  };
  });

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
      // В Hard-Mode (полноэкранный терминал) глобальные бинды глушим —
      // клавиши принадлежат шеллу; исключение — выход (hard_mode)
      if (hardSkinRef.current) {
        const bind = bindsRef.current.hard_mode;
        if (bind && comboMatches(bind, e)) {
          e.preventDefault();
          dispatchShortcutRef.current("hard_mode");
        }
        return;
      }
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







  const handleClearChat = () => {
    if (!activeId) return;
    // C12: очищаемая задача могла быть в активном прогоне — прерываем,
    // иначе цикл продолжал стримить и дописывать сообщения в «очищенную»
    // сессию частями (удалённое «возвращалось»)
    if (streamingTargetRef.current === activeId) handleStop();
    setSessions((prev) =>
      prev.map((s) => (s.id === activeId ? { ...s, messages: [] } : s)),
    );
  };

  const handleSavePromptLibrary = (list: PromptPreset[]) => {
    setPromptLibrary(list);
    savePromptLibrary(list);
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
    } catch (e) {
      // C16: try/finally без catch давал unhandled rejection — редактор
      // показывал старый контент, и пользователь терял текст, считая его
      // сохранённым
      addToast(t("error.noteSaveFailed"));
      console.error("note save failed:", e);
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
    // Движок однопоточный: занятый прогон не перебиваем, иначе step-запросы
    // цепочки отклонялись guard'ом handleSend после уже созданной сессии
    if (!start || chainRunning || activeRunRef.current !== null) return;
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
        const stepPlan = plan[i];
        const { prompt } = parseNotePrompt(stepPlan?.content ?? "");
        if (!prompt) {
          status[i] = "skipped";
          setChain({ ...state, current: i + 1, status: [...status] });
          continue;
        }
        status[i] = "running";
        setChain({ ...state, current: i, status: [...status] });
        // C10: движок мог занять тик автоматизации между шагами — handleSend
        // bail-ит по guard'у, и раньше шаг всё равно помечался «done», а
        // остальные молча пропускались. runStartedRef различает «не стартовал»
        runStartedRef.current = false;
        await handleSend(prompt, undefined, session.id);
        if (!runStartedRef.current || chainAbortRef.current) {
          for (let k = i; k < plan.length; k++) status[k] = "skipped";
          setChain({ ...state, status: [...status] });
          break;
        }
        status[i] = "done";
        setChain({ ...state, current: i + 1, status: [...status] });
      }
    } finally {
      setChainRunning(false);
      // streamingId/typing НЕ трогаем: finalize каждого прогона чистит их
      // только при владении (cur === requestId) — безусловный сброс здесь
      // гасил индикаторы ЧУЖОГО активного прогона (кнопка Stop исчезала)
    }
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


  const handleDelete = (id: string) => {
    // C12: удаление активной задачи не прерывало прогон — цикл продолжал
    // жечь токены и писать в несуществующую сессию
    if (streamingTargetRef.current === id) handleStop();
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) setActiveId(null);
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

  // ---------- Онбординг первого запуска и полный сброс ----------

  // Событие трея «Clear All Data»: подписка ставится один раз на монтирование
  useEffect(() => {
    // StrictMode double-mount: cleanup первого монтирования срабатывает ДО
    // резолва промиса, и первая подписка оставалась жить вечно
    let disposed = false;
    let un: (() => void) | undefined;
    void onClearDataRequest(() => {
      if (!disposed) setResetOpen(true);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const handleFactoryReset = async () => {
    setResetBusy(true);
    try {
      localStorage.clear(); // флаг онбординга и UI-превьюшки — заводское состояние
      await factoryReset(); // Rust стирает каталоги данных и перезапускает процесс
    } catch {
      setResetBusy(false);
      addToast(t("reset.failed"));
    }
  };

  // Живое превью из онбординга: сеттеры сами применяют и запоминают
  const handleOnboardingTheme = (th: Theme) => setTheme(th);
  const handleOnboardingAccent = (hex: string) =>
    setAppearance((a) => ({ ...a, accent: hex }));

  const handleOnboardingFinish = async (res: OnboardingResult) => {
    localStorage.setItem("haloui-onboarded", "1");
    setOnboardingOpen(false);
    if (!res.settings) return;
    try {
      const cur = await loadSettings();
      const merged = { ...cur, ...res.settings };
      setApiSettings(merged);
      await saveSettings(merged);
      if (merged.api_key && merged.base_url) {
        setApiStatus({ kind: "checking" });
        testConnection(merged.base_url, merged.api_key)
          .then((models) =>
            setApiStatus({
              kind: "ok",
              models,
              message: t("api.connected", { n: models.length }),
            }),
          )
          .catch((e) => setApiStatus({ kind: "error", message: String(e) }));
      }
    } catch {
      // сохранить не вышло — не валим онбординг, ключ можно ввести в настройках
    }
  };

  // Выбор из поиска: активируем задачу и синхронизируем фильтр проекта,
  // чтобы задача не «пропала» из списка
  const handleSearchSelect = (id: string) => {
    withViewTransition(() => {
      const session = sessions.find((s) => s.id === id);
      setActiveProjectId(session?.projectId ?? null);
      setActiveId(id);
      setSearchOpen(false);
    });
  };

  const menuProject = menu?.kind === "project" ? projects.find((p) => p.id === menu.id) : null;
  const menuNote = menu?.kind === "note" ? notes.find((n) => n.file === menu.id) : null;

  // ---------- Slash-команды (палитра "/" в поле ввода) ----------
  // FIX [stale-closure]: deps мемо не включают activeId и сами хендлеры —
  // /clear, /agent, /new после переключения задачи работали по СТАРОЙ задаче.
  // Команды зовут обработчики через ref, обновляемый каждым рендером
  const slashLatest = useRef({
    handleNewChat,
    handleClearChat,
    handleToggleAgent,
    handleApplyPreset,
    handleOpenNote,
    handleRunChain,
  });
  // Эффект без deps вместо присваивания в теле рендера (React Compiler)
  useEffect(() => {
    slashLatest.current = {
      handleNewChat,
      handleClearChat,
      handleToggleAgent,
      handleApplyPreset,
      handleOpenNote,
      handleRunChain,
    };
  });

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
        run: () => slashLatest.current.handleNewChat(),
      },
      {
        name: "clear",
        desc: t("cmd.clear"),
        run: () => slashLatest.current.handleClearChat(),
      },
      {
        name: "agent",
        desc: t("cmd.agent"),
        run: () => slashLatest.current.handleToggleAgent(),
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
          if (preset) slashLatest.current.handleApplyPreset(preset.text);
        },
      },
      {
        name: "note",
        desc: t("cmd.note"),
        argHint: t("cmd.noteHint"),
        suggestions: () => notes.map((n) => n.title),
        run: (arg: string) => {
          const title = arg.trim();
          if (title) void slashLatest.current.handleOpenNote(title);
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
          if (note) void slashLatest.current.handleRunChain(note.file, note.content);
        },
      },
    ];

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, notes, promptLibrary]);

  const menuItems: MenuItem[] = menuProject
    ? [
        {
          label: t("menu.rename"),
          onSelect: () => setRenamingId(menuProject.id),
        },
        {
          label: t("menu.projectAccent"),
          onSelect: () => handleProjectAccent(menuProject.id),
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
        {
          label: t("menu.exportMd"),
          onSelect: () => void handleExportSession(menuSession.id, "md"),
        },
        {
          label: t("menu.exportJson"),
          onSelect: () => void handleExportSession(menuSession.id, "json"),
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
        {/* Обои на уровне окна: за сайдбаром и чатом (кастомизация) —
            раньше жили только в колонке чата и «не уходили» за сайдбар */}
        {appearance.chatWallpaper && (
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
          >
            <img
              src={convertFileSrc(appearance.chatWallpaper)}
              alt=""
              className="h-full w-full object-cover opacity-35"
            />
          </div>
        )}
        {/* Ambient-слой: сцены/видео позади контента, z и паузы — в CSS */}
        {appearance.ambient && appearance.ambientScene !== "glow" && (
          <AmbientLayer
            scene={appearance.ambientScene}
            videoPath={appearance.ambientVideo}
            density={appearance.ambientDensity}
            paused={streamingId !== null || appearance.reduceMotion === true}
            gradFrom={appearance.ambientGradFrom}
            gradTo={appearance.ambientGradTo}
            gradAngle={appearance.ambientGradAngle}
          />
        )}
        <button
          onClick={() => setSidebarCollapsed(false)}
          title={t("sidebar.expand")}
          className={`absolute top-2 z-40 flex size-8 items-center justify-center rounded-lg text-halo-accent transition duration-200 hover:bg-halo-hover ${
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
        onSelect={(id) => withViewTransition(() => setActiveId(id))}
        onOpenSettings={() => {
          setSettingsSection("main");
          setSettingsOpen(true);
        }}
        onOpenPlugins={() => {
          setSettingsSection("plugins");
          setSettingsOpen(true);
        }}
        onOpenAutomations={() => setAutomationsOpen(true)}
        onOpenSearch={() => withViewTransition(() => setSearchOpen(true))}
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
        onResizeReset={() => setSidebarWidth(340)}
        onCollapse={() => setSidebarCollapsed(true)}
      />
      <ChatArea
        session={activeSession}
        typing={typing}
        activity={activity}
        onUndoWrite={handleUndoWrite}
        onReviewChanges={handleReviewChanges}
        subRuns={subRuns}
        plan={activeSession?.plan}
        userCommands={mergedUserCommands}
        extraSkills={pluginSkills}
        onEditMessage={(msgId, text) =>
          void handleSend(text, undefined, activeId ?? undefined, undefined, msgId)
        }
        model={apiSettings.model}
        streamingMsgId={streamingAssistantId}
        visionCapable={
          apiStatus.models?.find((m) => m.id === apiSettings.model)?.vision
        }
        isLocal={/localhost|127\.0\.0\.1/.test(apiSettings.base_url)}
        agentMode={activeSession?.agentMode ?? false}
        permissionMode={activeSession?.permissionMode ?? "ask"}
        onPermissionModeChange={(m) => {
          // «План» — панель плана открывается сама (и из поповера, и при
          // создании задачи сразу в плане)
          if (m === "plan") setPlanPanelOpen(true);
          if (activeId) handleSetPermissionMode(m);
          else createChat({ permissionMode: m });
        }}
        disabledTools={activeSession?.disabledTools ?? []}
        onToggleDisabledTool={(tool) =>
          activeId ? handleToggleDisabledTool(tool) : createChat({ disabledTools: [tool] })
        }
        pendingConfirm={pendingConfirm}
        pendingAsk={pendingAsk}
        onAskAnswer={handleAskAnswer}
        onConfirmDecision={handleConfirmDecision}
        promptPresets={builtinPresetsFor(lang)}
        customPresets={promptLibrary}
        onSend={stableHandleSend}
        pendingQuote={diffQuote}
        queued={queuedProps}
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
        onStop={stableHandleStop}
        onOpenSettings={() => {
          setSettingsSection("main");
          setSettingsOpen(true);
        }}
        onSetSystemPrompt={(p) =>
          activeId || p == null
            ? handleSetSystemPrompt(p)
            : createChat({ systemPrompt: p })
        }
        onApplyPreset={handleApplyPreset}
        onToggleAgent={() =>
          activeId ? handleToggleAgent() : createChat({ agentMode: true })
        }
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        projectRoot={projectRoot}
        termShell={termShell}
        termPalette={TERMINAL_PALETTES[appearance.termPalette ?? "default"]}
        termBlur={appearance.termBlur}
        hideStarter={hideStarter}
        onToggleStarter={() => setHideStarter((v) => !v)}
        terminalHeightPct={terminalHeight}
        onTerminalResizeStart={startTerminalResize}
        scrollFollow={scrollFollow}
        printSpeed={printSpeed}
        streamSmooth={streamSmooth}
        showReasoning={showReasoning}
        streamCaret={streamCaret}
        showUserMsgs={showUserMsgs}
        groupTurns={groupTurns}
        chatMark={chatMark}
        msgGlass={msgGlass}
        showMsgTime={appearance.showMsgTime ?? false}
        showWindowControls={sidebarSide === "left"}
        headerInset={sidebarCollapsed ? sidebarSide : null}
        slashCommands={slashCommands}
        models={apiStatus.models ?? []}
        onModelChange={(id) => {
          setApiSettings((prev) => ({ ...prev, model: id }));
          notifyModelChanged(id);
        }}
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
      {openNoteFile !== null && (
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
      )}
      <ErrorBoundary title={t("err.boundary")} action={t("err.boundaryRetry")}>
      {settingsOpen && (
      <SettingsModal
        open={settingsOpen}
        usageLog={usageLog}
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
        printSpeed={printSpeed}
        onPrintSpeedChange={setPrintSpeed}
        hardMode={hardMode}
        onHardModeChange={setHardMode}
        showReasoning={showReasoning}
        onShowReasoningChange={setShowReasoning}
        transcriptView={transcriptView}
        onTranscriptViewChange={setTranscriptView}
        askAutoContinue={askAutoContinue}
        onAskAutoContinueChange={setAskAutoContinue}
        autoArchive={autoArchive}
        onAutoArchiveChange={setAutoArchive}
        termShell={termShell}
        onTermShellChange={setTermShell}
        closeToTray={closeToTray}
        onCloseToTrayChange={setCloseToTray}
        archiveRetention={archiveRetention}
        onArchiveRetentionChange={setArchiveRetention}
        onArchiveNow={archiveOldNow}
        onExportChats={() => void handleExportAllChats()}
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
        onClose={() => closeSettings()}
      />
      )}
      </ErrorBoundary>
      {automationsOpen && (
        <AutomationsModal
          open={automationsOpen}
          onClose={() => setAutomationsOpen(false)}
        />
      )}
      {browserPanelOpen && (
        <BrowserPanel
          open={browserPanelOpen}
          onClose={() => setBrowserPanelOpen(false)}
        />
      )}
      <DiffPanel
        open={diffReview.open}
        files={diffReview.files}
        onQuote={handleDiffQuote}
        onClose={() => setDiffReview((p) => ({ ...p, open: false }))}
      />
      <PlanSidePanel
        open={planPanelOpen}
        plan={activeSession?.plan ?? []}
        canApprove={activeId !== null}
        onApprove={() => {
          handleSetPermissionMode("ask");
          setPlanPanelOpen(false);
        }}
        onCopied={() => addToast(t("plan.copied"))}
        onClose={() => setPlanPanelOpen(false)}
      />
      {/* Hard-Mode: полноэкранный живой терминал поверх «спящего» UI */}
      {hardMode && hardSkin && (
        <HardTerminal
          cwd={projectRootRef.current ?? undefined}
          combo={bindsRef.current.hard_mode ?? "Ctrl+Shift+H"}
        />
      )}
      <Toasts items={toasts} />
      {onboardingOpen && splashDone && (
        <Onboarding
          theme={theme}
          onTheme={handleOnboardingTheme}
          onAccent={handleOnboardingAccent}
          onFinish={(r) => void handleOnboardingFinish(r)}
        />
      )}
      {resetOpen && (
        <ResetConfirmModal
          busy={resetBusy}
          onConfirm={() => void handleFactoryReset()}
          onCancel={() => setResetOpen(false)}
        />
      )}
      {accentEdit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={() => setAccentEdit(null)}
        >
          <div
            className="glass-pane w-72 rounded-xl border border-halo-line bg-halo-surface p-3"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="mb-2 text-xs font-medium text-halo-text">{t("menu.projectAccent")}</p>
            <input
              autoFocus
              value={accentEdit.value}
              placeholder={t("menu.projectAccentPh")}
              onChange={(e) => setAccentEdit({ ...accentEdit, value: e.target.value })}
              onKeyDown={(e) => {
                // isComposing: энтер подтверждения IME не должен коммитить
                if (e.key === "Enter" && !e.nativeEvent.isComposing) commitProjectAccent(accentEdit.value);
                if (e.key === "Escape") setAccentEdit(null);
              }}
              className="w-full rounded-md border border-halo-accent/50 bg-halo-surface px-2 py-1.5 text-sm text-halo-text outline-none"
            />
          </div>
        </div>
      )}
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
      {searchOpen && (
        <SearchModal
          open={searchOpen}
          sessions={sessions}
          onSelect={handleSearchSelect}
          onClose={() => withViewTransition(() => setSearchOpen(false))}
        />
      )}
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
