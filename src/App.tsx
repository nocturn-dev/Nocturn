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
import { parseWriteResult, normalizePath } from "./diff";
import { dayKeyLocal } from "./time";
import {
  firstConfirm,
} from "./interactions";
import CryptoGate from "./components/CryptoGate";
import { useAgentRun } from "./hooks/useAgentRun";


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
  detectOllama,
  runTool,
  invalidateToolSchemas,
  mcpAutoconnect,
  loadSessions,
  saveSessions,
  setTrayVariant,
  providerFromBaseUrl,
  notesList,
  notesRead,
  notesWrite,
  notesDelete,
  keepAwake,
  DEFAULT_SETTINGS,
  type ApiSettings,
  type ApiProfile,
  type ModelInfo,
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
import { AmbientLayer } from "./components/AmbientLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";

const clampNum = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export default function App() {
  const { lang, t } = useLang();
  // Демо-чаты не создаём: список стартует пустым, задачи — только те,
  // что создал пользователь («Новая задача» / автоматизации)
  const [sessions, setSessions] = useState<Session[]>([]);
  // Проекты: единственный источник истины — projects.json (загружается
  // ниже при старте). Демо-проекты не создаём: список стартует пустым
  // и наполняется только вручную («+» во вкладке «Проекты»)
  const [projects, setProjects] = useState<Project[]>([]);
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
  // Сплэш: держится, пока грузятся хранилища (splashDone) + минимальная
  // выдержка внутри Splash; после фейда Splash зовёт onGone — убираем его
  const [splashDone, setSplashDone] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);

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
  // Рассуждения: раскрывать блок размышлений автоматически
  const [showReasoning, setShowReasoning] = useState(
    () => localStorage.getItem("haloui-show-reasoning") === "1",
  );
  // Автопродолжение ask_user: вопрос без ответа 5 минут — агент продолжит сам
  const [askAutoContinue, setAskAutoContinue] = useState(
    () => localStorage.getItem("haloui-ask-auto-continue") !== "0",
  );
  // Оболочка консоли терминала: auto | powershell | cmd | gitbash
  const [termShell, setTermShell] = useState<string>(
    () => localStorage.getItem("haloui-term-shell") || "auto",
  );
  // Скрывать в трей при закрытии окна (выход — из меню трея)
  const [closeToTray, setCloseToTray] = useState(
    () => localStorage.getItem("haloui-close-to-tray") === "1",
  );
  // Авто-архив: старые задачи (без пина, старше срока) уходят в архив
  const [autoArchive, setAutoArchive] = useState(
    () => localStorage.getItem("haloui-auto-archive") === "1",
  );
  const [archiveRetention, setArchiveRetention] = useState<number>(() => {
    const raw = Number(localStorage.getItem("haloui-archive-retention"));
    return raw === 3 || raw === 30 ? raw : 7;
  });
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

  const historyLoadedRef = useRef(false);
  const [menu, setMenu] = useState<{
    id: string;
    x: number;
    y: number;
    kind: "session" | "project" | "note";
  } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Тема применяется мгновенно и запоминается.
  // Official-тема всегда тёмная: светлая не применяется, пока она включена
  useEffect(() => {
    const forceDark = appearance.official;
    document.documentElement.classList.toggle("light", theme === "light" && !forceDark);
    localStorage.setItem("haloui-theme", theme);
  }, [theme, appearance.official]);

  // «Не давать ПК уснуть»: тумблер переживает перезапуск, но ОС-уровневый
  // флаг сбрасывается вместе с процессом — восстанавливаем при старте
  useEffect(() => {
    if (localStorage.getItem("haloui-keep-awake") === "1") {
      void keepAwake(true).catch(() => {});
    }
  }, []);

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
    // Иконка трея следует за знаком приложения (bold/classic)
    void setTrayVariant(appearance.markStyle).catch(() => {});
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
    localStorage.setItem("haloui-show-reasoning", showReasoning ? "1" : "0");
  }, [showReasoning]);
  useEffect(() => {
    localStorage.setItem("haloui-ask-auto-continue", askAutoContinue ? "1" : "0");
  }, [askAutoContinue]);
  useEffect(() => {
    localStorage.setItem("haloui-term-shell", termShell);
  }, [termShell]);
  useEffect(() => {
    localStorage.setItem("haloui-close-to-tray", closeToTray ? "1" : "0");
  }, [closeToTray]);
  useEffect(() => {
    localStorage.setItem("haloui-auto-archive", autoArchive ? "1" : "0");
  }, [autoArchive]);
  useEffect(() => {
    localStorage.setItem("haloui-archive-retention", String(archiveRetention));
  }, [archiveRetention]);

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
  }, [sidebarSide]);

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
                  setSessions(
                    parsed.map((s) =>
                      staleIds.has(s.id) ? { ...s, archived: true } : s,
                    ),
                  );
                  addToast(t("main.archivedN", { n: staleIds.size }));
                  return;
                }
              }
              setSessions(parsed);
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
  // streamingId объявлен ниже (useAgentRun) — пишем в ref там же.
  const streamingActiveRef = useRef(false);
  useEffect(() => {
    const flush = () => {
      if (!sessionsDirtyRef.current) return;
      if (streamingActiveRef.current) return;
      sessionsDirtyRef.current = false;
      void saveSessions(JSON.stringify(sessionsRef.current)).catch(() => {});
    };
    const id = window.setInterval(flush, 3000);
    // Закрытие окна — последний сейв, если есть несохранённое
    window.addEventListener("beforeunload", flush);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("beforeunload", flush);
      // Размонтирование (StrictMode/HMR): не теряем накопленное
      const wasStreaming = streamingActiveRef.current;
      streamingActiveRef.current = false;
      if (wasStreaming) {
        void saveSessions(JSON.stringify(sessionsRef.current)).catch(() => {});
      } else {
        flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // cryptoSetup/cryptoUnlock бросают при неверном пароле — гейт показывает ошибку
      try {
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
        // unlock и disable: сначала проверяем пароль
        await cryptoUnlock(password);
        if (cryptoGate === "disable") {
          await setKeyEncryption(false);
        }
        await reloadSecrets();
        setCryptoGate("none");
        return true;
      } catch {
        return false;
      }
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

  // Idle-lock: если хранилище само заперлось (15 мин без операций с ключом) —
  // при возврате в окно показываем гейт разблокировки, иначе зашифрованные
  // операции начнут падать «vault is locked» без понятного объяснения
  const cryptoGateRef = useRef(cryptoGate);
  const vaultWasUnlockedRef = useRef(false);
  useEffect(() => {
    cryptoGateRef.current = cryptoGate;
  }, [cryptoGate]);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const st = await cryptoStatus();
        if (!alive) return;
        if (st.enabled && st.setup && !st.unlocked && vaultWasUnlockedRef.current) {
          vaultWasUnlockedRef.current = false;
          if (cryptoGateRef.current === "none") setCryptoGate("unlock");
        } else if (st.unlocked) {
          vaultWasUnlockedRef.current = true;
        }
      } catch {
        // браузерное превью — крипто нет
      }
    };
    const iv = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    void check();
    return () => {
      alive = false;
      window.clearInterval(iv);
      window.removeEventListener("focus", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Снимок для длинных агентных прогонов: в уведомлениях должно быть
  // актуальное название задачи/проект/модель, а не замыкание на момент старта
  const activeSessionRef = useRef(activeSession);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

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
    setStreamingId,
    setTyping,
    typing,
    activity,
    streamingId,
    streamingAssistantId,
    activeRunRef,
    subRuns,
    queuedMsgs,
    setQueuedMsgs,
    setPendingCorrections,
    pendingCorrectionsRef,
    interactions,
    handleConfirmDecision,
    handleAskAnswer,
    chainAbortRef,
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
  // Для автосейва: активный стрим (объявлен ниже декларации ref — см. эффект автосейва)
  streamingActiveRef.current = streamingId !== null;

  // Ambient-фон: во время стрима анимация на паузе — батарея и FPS важнее
  // (эффект здесь, ниже деструктуризации streamingId)
  useEffect(() => {
    document.documentElement.classList.toggle("ambient-paused", streamingId !== null);
  }, [streamingId]);

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
  slashLatest.current = {
    handleNewChat,
    handleClearChat,
    handleToggleAgent,
    handleApplyPreset,
    handleOpenNote,
    handleRunChain,
  };

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
        {/* Ambient-слой: сцены/видео позади контента, z и паузы — в CSS */}
        {appearance.ambient && appearance.ambientScene !== "glow" && (
          <AmbientLayer
            scene={appearance.ambientScene}
            videoPath={appearance.ambientVideo}
            brightness={appearance.ambientBrightness}
            density={appearance.ambientDensity}
            paused={streamingId !== null}
          />
        )}
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
        onResizeReset={() => setSidebarWidth(340)}
        onCollapse={() => setSidebarCollapsed(true)}
      />
      <ChatArea
        session={activeSession}
        typing={typing}
        activity={activity}
        onUndoWrite={handleUndoWrite}
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
        onPermissionModeChange={handleSetPermissionMode}
        pendingConfirm={(() => {
          const c = firstConfirm(interactions);
          return c && c.kind === "confirm"
            ? { requestId: c.requestId, call: c.call }
            : null;
        })()}
        pendingAsk={(() => {
          const a = interactions.find((i) => i.kind === "ask");
          return a && a.kind === "ask"
            ? { msgId: a.msgId, ask: { ...a.spec } }
            : null;
        })()}
        onAskAnswer={handleAskAnswer}
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
        termShell={termShell}
        hideStarter={hideStarter}
        onToggleStarter={() => setHideStarter((v) => !v)}
        terminalHeightPct={terminalHeight}
        onTerminalResizeStart={startTerminalResize}
        scrollFollow={scrollFollow}
        streamSmooth={streamSmooth}
        showReasoning={showReasoning}
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
      <ErrorBoundary title={t("err.boundary")} action={t("err.boundaryRetry")}>
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
        showReasoning={showReasoning}
        onShowReasoningChange={setShowReasoning}
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
      </ErrorBoundary>
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
