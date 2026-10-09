import { STORAGE_KEYS } from "./storageKeys";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFile,
  PermissionMode,
  Project,
  Session,
  Theme,
  UsageEvent,
} from "./types";
import { useLang } from "./locales";
import { copyText } from "./clipboard";
import {
  diffLines,
  diffStats,
  normalizePath,
  parseWriteResult,
} from "./diff";
import { DiffPanel, type DiffPanelFile } from "./components/DiffPanel";
import { PlanSidePanel } from "./components/PlanSidePanel";
import { checkpointFiles, windowToggleFullscreen, openFileExternal } from "./api";
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
  quickentryStatus,
  factoryReset,
  dictationTranscribe,
  onTelegramCommand,
  type TelegramCommand,
  pickFolder,
  type KbTrace,
} from "./api";
import { stopSpeaking, speak } from "./tts";
import { VoiceWake, stripWakeWord, type WakeHandle, type WakeOptions } from "./voice/wake";
import VoicePill, { type VoicePhase } from "./components/VoicePill";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApiSettings } from "./hooks/useApiSettings";
import { useSessions } from "./hooks/useSessions";
import {
  loadPromptLibrary,
  savePromptLibrary,
  builtinPresetsFor,
  type PromptPreset,
} from "./presets";
import {
  loadJailbreaks,
  saveJailbreaks,
  appendJailbreak,
  type JailbreakEntry,
} from "./jailbreaks";
import Sidebar from "./components/Sidebar";
import NocturnMark from "./components/NocturnMark";
import Splash from "./components/Splash";
import Onboarding, { type OnboardingResult } from "./components/Onboarding";


import ChatArea, { filterVisibleMessages } from "./components/ChatArea";
import { LyricsRibbon } from "./components/LyricsRibbon";
import { YouTubeLayer } from "./components/YouTubeLayer";
import { ytSetLoopQueue, ytToggleOpen } from "./yt/ytPlayer";
import type { Section } from "./components/SettingsModal";
import BrowserPanel from "./components/BrowserPanel";
import Toasts from "./components/Toast";
import DownloadProgress from "./components/DownloadProgress";
import { isDue, loadAutomations, nextRunAfter, saveAutomations, VAULT_REPORT_SUFFIX } from "./automations";
import { isIdle, loadOffPeak, nextWaiting, saveOffPeak } from "./offpeak";
import { checkForUpdate } from "./api";
import SearchModal from "./components/SearchModal";
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
import type { ChainState, ChainStepStatus } from "./components/ChainMonitor";
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
import { loadNotifyPrefs, saveNotifyPrefs, loadRunSoundPrefs, saveRunSoundPrefs, type NotifyPrefs, type RunSoundPrefs } from "./notify";
import { loadPermRules, PERM_RULES_CHANGED, type PermRules } from "./agent/permRules";
import { loadMediaPrefs, saveMediaPrefs, type MediaPrefs, type MediaLyricsSnapshot } from "./mediaPrefs";
import { subagentsLoad, subagentsSave, commandsLoad, pluginsLoad, type Plugin, type UserCommand } from "./api";
import {
  parseSubagentsConfig,
  type SubagentsConfig,
} from "./subagents";
import type { VoiceSettings } from "./voice/prefs";
import { loadLimits, saveLimits, type HardLimits } from "./limits";
import { uid } from "./hooks/useAgentRun";
import { useToasts } from "./hooks/useToasts";
import { registerCustomFonts } from "./fonts";
import { TERMINAL_PALETTES } from "./vt";
import { useAppearanceUi } from "./hooks/useAppearanceUi";
import { useBoolPref, useNumPref, useStringPref } from "./hooks/usePrefs";
import { withViewTransition } from "./motion";
import { AmbientLayer } from "./components/AmbientLayer";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Волна 2 (жёсткая оптимизация): тяжёлые поверхности — ленивые чанки.
// Модалки грузятся при первом открытии и после него живут смонтированными
// (useEverOpened): внутреннее состояние (вкладки настроек, черновики) и
// exit-анимации useDelayedUnmount ведут себя ровно как при
// всегда-смонтированной модалке, но старт приложения их не парсит.
// memo (аудит A4-4): App перерисовывается на каждый 40мс-флаш стрима —
// без мемоизации sticky-mounted модалки рендерились целиком на каждый
// флаш (SessionRow/AssistantCard мемоизированы по той же причине);
// работает в паре со стабильными пропсами ниже (блок «Стабильные пропсы»)
const LazySettingsModal = memo(lazy(() => import("./components/SettingsModal")));
const LazyAutomationsModal = memo(lazy(() => import("./components/AutomationsModal")));
const LazyCompareModal = memo(lazy(() => import("./components/CompareModal")));
const LazyGgufLabModal = memo(lazy(() => import("./components/GgufLabModal")));
const LazyKnowledgeModal = memo(lazy(() => import("./components/KnowledgeModal")));
const LazyNotesModal = lazy(() => import("./components/NotesModal"));
const LazyGraphModal = lazy(() => import("./components/GraphModal"));
const LazyChainMonitor = lazy(() => import("./components/ChainMonitor"));
const LazyResetConfirmModal = lazy(() => import("./components/ResetConfirmModal"));
const LazyHardTerminal = lazy(() => import("./components/HardTerminal"));

/** [фикс] Прогрев lazy-чанков на простое: первый клик по «Настройкам» иначе
 *  ждёт загрузку 273 кБ чанка (в dev-сервере — секунды on-demand
 *  трансформации), пользователь читает это как зависание. Идл-импорт старт
 *  не трогает (после первой отрисовки + requestIdleCallback), а первый
 *  показ модалки становится мгновенным. sticky-mount монтирование не меняет */
const WARM_CHUNKS: (() => Promise<unknown>)[] = [
  () => import("./components/SettingsModal"),
  () => import("./components/AutomationsModal"),
  () => import("./components/CompareModal"),
  () => import("./components/KnowledgeModal"),
  () => import("./components/NotesModal"),
  () => import("./components/GraphModal"),
  () => import("./components/ChainMonitor"),
  () => import("./components/ResetConfirmModal"),
  () => import("./components/HardTerminal"),
];

function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  useEffect(() => {
    if (open) setEver(true);
  }, [open]);
  return ever;
}

const clampNum = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/** Санитизация журнала usage из localStorage. Ключ пишем сами, но ручная
 *  правка в devtools (или сторонний код того же origin) не должна ронять
 *  flush-таймер и статистику: голый JSON.parse-cast превращал не-массив
 *  в TypeError внутри setInterval и невосстановимо убивал журнал. Контраст:
 *  sessions.json проходит sanitizeSession, automations — sanitizeAutomation */
function sanitizeUsageEvents(raw: string): UsageEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: UsageEvent[] = [];
  for (const e of parsed) {
    if (typeof e !== "object" || e === null) continue;
    const u = e as Partial<UsageEvent>;
    if (
      typeof u.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(u.day) &&
      typeof u.prompt === "number" &&
      Number.isFinite(u.prompt) &&
      typeof u.completion === "number" &&
      Number.isFinite(u.completion) &&
      typeof u.model === "string" &&
      typeof u.workedMs === "number" &&
      Number.isFinite(u.workedMs)
    ) {
      out.push({ day: u.day, prompt: u.prompt, completion: u.completion, model: u.model, workedMs: u.workedMs });
    }
  }
  return out;
}

/** Текстовое решение по подтверждению из Telegram (фаза 2): «да/нет/всегда»
 *  на ru/en + утилитарные (1/2/0, +/-). Не-решение (null) — текст пойдёт
 *  как задача/поправка */
function confirmDecisionFromText(text: string): "once" | "always" | "deny" | null {
  const s = text.trim().toLowerCase();
  if (/^(всегда|always|2)\s*[!.]*$/.test(s)) return "always";
  if (/^(нет|no|n|отклонить|deny|0|-)\s*[!.]*$/.test(s)) return "deny";
  if (/^(да|yes|y|ок|ok|окей|разрешить|1|\+)\s*[!.]*$/.test(s)) return "once";
  return null;
}

export default function App() {
  const { lang, t } = useLang();
  // Проекты: единственный источник истины — projects.json (загружается
  // ниже при старте). Демо-проекты не создаём: список стартует пустым
  // и наполняется только вручную («+» во вкладке «Проекты»)
  const [projects, setProjects] = useState<Project[]>([]);
  // Зеркало проектов для хуков с реф-доступом (партиции сейва сессий
  // в useSessions читают корни проектов асинхронно)
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  const projectsLoadedRef = useRef(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Сколько раз настройки закрылись (Нок выдыхает с облегчением)
  const [settingsClosedSeq, setSettingsClosedSeq] = useState(0);
  const settingsWasOpenRef = useRef(false);
  useEffect(() => {
    if (settingsWasOpenRef.current && !settingsOpen) {
      setSettingsClosedSeq((v) => v + 1);
    }
    settingsWasOpenRef.current = settingsOpen;
  }, [settingsOpen]);
  // Раздел настроек для программного открытия (плагины из сайдбара)
  const [settingsSection, setSettingsSection] = useState<Section | null>(null);
  // Пользовательские шрифты: регистрация FontFace после старта
  // (userCss перенесён в main.tsx до первого рендера — без FOUC)
  useEffect(() => {
    void registerCustomFonts();
  }, []);

  // Проверка обновлений — строго opt-in (local-first): раньше запрос к
  // GitHub уходил на каждом старте без всякого спроса
  const [autoUpdateCheck, setAutoUpdateCheck] = useBoolPref("haloui-auto-update", false);
  // Автообновление: ТОЛЬКО по тумблеру (haloui-auto-update, дефолт off —
  // никаких обращений к github без явного согласия пользователя)
  useEffect(() => {
    if (!autoUpdateCheck) return;
    const timer = window.setTimeout(() => {
      void checkForUpdate({
        available: (v) => window.confirm(t("upd.available", { v })),
        installed: () => addToast(t("upd.installed")),
      });
    }, 8000);
    return () => window.clearTimeout(timer);
    // mount-only логика проверки: t/addToast сознательно не в deps (смена
    // языка не должна перезапускать проверку), тумблер — должен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUpdateCheck]);

  // Экран «Автоматизации»
  const [automationsOpen, setAutomationsOpen] = useState(false);
  // Сравнение моделей бок-о-бок (общий промпт → параллельные стримы)
  const [compareOpen, setCompareOpen] = useState(false);
  const [ggufLabOpen, setGgufLabOpen] = useState(false);
  // Базы знаний (RAG): индексы документов + привязка к активному чату
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  // Sticky-mount ленивых модалок (см. блок lazy выше)
  const settingsMounted = useEverOpened(settingsOpen);
  const automationsMounted = useEverOpened(automationsOpen);
  const compareMounted = useEverOpened(compareOpen);
  const ggufLabMounted = useEverOpened(ggufLabOpen);
  const knowledgeMounted = useEverOpened(knowledgeOpen);
  // RAG-трасса (PLAN §24 ш.3): последний поиск по базе — для KnowledgeModal
  const [kbTrace, setKbTrace] = useState<KbTrace | null>(null);
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
    () => !localStorage.getItem(STORAGE_KEYS.onboarded),
  );
  // Прогрев lazy-чанков: после сплэша на простое приложения подтягиваем
  // тяжёлые поверхности — первый клик по «Настройкам» больше не ждёт чанк
  useEffect(() => {
    if (!splashDone) return;
    const warm = () => {
      for (const load of WARM_CHUNKS) void load().catch(() => {});
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    // TS2774: requestIdleCallback в lib.dom всегда определён, но в старых
    // WebView2-рантаймах отсутствует в рантайме — проверяем именно значение
    const ric = w.requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    if (ric) {
      const id = ric(warm, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(t);
  }, [splashDone]);
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
    /** Файл, на котором сфокусироваться (кнопка Review на строке карточки) */
    focus?: string;
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

  // Voice Wake («Jarvis-режим»): локальное голосовое пробуждение по фразе.
  // Всё офлайн: openWakeWord в вебвью, команды — через существующий perm-слой
  const [voiceWakeOn, setVoiceWakeOn] = useBoolPref("haloui-voice-wake", false);
  const [voiceModel, setVoiceModel] = useStringPref<"hey_jarvis" | "hey_mycroft">(
    "haloui-voice-model",
    "hey_jarvis",
  );
  const [voiceThreshold, setVoiceThreshold] = useNumPref(
    "haloui-voice-threshold",
    0.45,
    (v) => (isNaN(v) ? 0.45 : clampNum(v, 0.3, 0.9)),
  );
  const [voiceTtsReply, setVoiceTtsReply] = useBoolPref("haloui-voice-tts", false);
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
  // Git-автокоммит перед правками агента (Aider-паттерн, opt-in)
  const [gitAutocommit, setGitAutocommit] = useBoolPref(STORAGE_KEYS.gitAutocommit, false);
  // Подсветка кода во время стрима: выкл — hljs только после завершения
  // (тик плавной печати без highlight в разы дешевле на длинных ответах)
  const [highlightLive, setHighlightLive] = useBoolPref("haloui-highlight-live", true);
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
  // Zen-режим (бинд toggle_zen, дефолт Ctrl+Alt+Z): весь GUI скрыт,
  // остаётся только ambient/фон — медитативный вид. Не персистим:
  // приложение всегда стартует с интерфейсом
  const [zenMode, setZenMode] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("zen", zenMode);
    return () => document.documentElement.classList.remove("zen");
  }, [zenMode]);
  // Скорость плавной печати: множитель догоняющего темпа (сегмент
  // «Основного»; в ленту едет пропом printSpeed) — комментарий жил в 20
  // строках выше состояния, склеенный с чужим обрывком (аудит 2026-10-04)
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
  const [termShell, setTermShell] = useStringPref<string>(STORAGE_KEYS.termShell, "auto");
  // Скрывать в трей при закрытии окна (выход — из меню трея)
  const [closeToTray, setCloseToTray] = useBoolPref(STORAGE_KEYS.closeToTray, false);
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
  const [usageLog, setUsageLog] = useState<UsageEvent[]>([]);
  // Журнал usage грузим ПОСЛЕ первого рендера (волна 5): JSON.parse до 5000
  // записей на старте держал главный поток в момент, когда он занят гидрацией.
  // Единственный потребитель — ленивая секция статистики в настройках; на
  // первом экране его нет, а API-события usage ещё физически не могут прийти
  // (первая сеть — checkForUpdate через 8 с)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const raw = localStorage.getItem(STORAGE_KEYS.usage);
      if (!raw) return;
      const events = sanitizeUsageEvents(raw);
      if (events.length === 0 && raw.trim() !== "[]") {
        // Невалидное содержимое стираем: бэкфилл из sessions.json снова увидит
        // пустой ключ и восстановит журнал (голый cast оставлял поломку навсегда)
        localStorage.removeItem(STORAGE_KEYS.usage);
      }
      setUsageLog(events);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
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
  // Маскот Нок у композера (PLAN.md §21) + его характер
  const [mascot, setMascot] = useBoolPref("haloui-mascot", true);
  const [mascotSize, setMascotSize] = useNumPref("haloui-mascot-size", 1);
  const [mascotGlow, setMascotGlow] = useNumPref("haloui-mascot-glow", 1);
  const [mascotEaster, setMascotEaster] = useBoolPref("haloui-mascot-easter", true);
  const [mascotSelf, setMascotSelf] = useBoolPref("haloui-mascot-self", true);
  // Кастомные цвета частей Нока ("" — токен темы); JSON в строке-префе
  const [mascotColorsRaw, setMascotColorsRaw] = useStringPref<string>("haloui-mascot-colors", "{}");
  const mascotColors = useMemo(() => {
    try {
      const o = JSON.parse(mascotColorsRaw) as { body?: string; glow?: string; wing?: string };
      return { body: o.body ?? "", glow: o.glow ?? "", wing: o.wing ?? "" };
    } catch {
      return { body: "", glow: "", wing: "" };
    }
  }, [mascotColorsRaw]);
  const setMascotColor = useCallback(
    (part: "body" | "glow" | "wing", v: string) => {
      setMascotColorsRaw(JSON.stringify({ ...mascotColors, [part]: v }));
    },
    [mascotColors, setMascotColorsRaw],
  );
  // Насест Нока (драг по кромке шелла) и «спрятать до рестарта» (ПКМ-меню:
  // сознательно не персистится — рестарт возвращает маскота)
  // Кастомное имя Нока ("" — локализованное «Нок»); реплики с {name}
  const [mascotName, setMascotName] = useStringPref<string>("haloui-mascot-name", "");
  const [mascotSide, setMascotSide] = useStringPref<"left" | "right">("haloui-mascot-side", "left");
  const [mascotShooed, setMascotShooed] = useState(false);

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
  // Стабильные пропсы sticky-модалок (аудит 07.10 A4-9): инлайн-стрелки
  // пробивали memo — модалки ре-рендерились на каждом 40мс-флаше стрима
  const openGgufLab = useCallback(() => setGgufLabOpen(true), []);
  const closeGgufLab = useCallback(() => setGgufLabOpen(false), []);

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
    projectsRef,
  });
  // «Пустая лента» по ЕДИНОЙ формуле с ChatArea (filterVisibleMessages):
  // раньше App смотрел сырой messages.length, и при скрытых сообщениях
  // пользователя композер центрировался, а лента лирики рисовалась в
  // нижней полосе — тексты сталкивались (аудит А4-4)
  const chatEmptyForRibbon = useMemo(
    () =>
      filterVisibleMessages(activeSession?.messages ?? [], showUserMsgs)
        .length === 0,
    [activeSession, showUserMsgs],
  );
  // Стабильный пропс sticky-настроек: `?? []` создавал новый массив каждый
  // рендер и пробивал memo (аудит 07.10 A4-9)
  const allowedCommands = useMemo(
    () => activeSession?.allowedCommands ?? [],
    [activeSession?.allowedCommands],
  );

  // Pre-toggle «Agent» до создания чата: без него клик по чипу создавал
  // сессию и стирал набранный черновик (запрос при этом не отправлялся).
  // Сбрасывается, когда появляется активная сессия (режим поглощён ей)
  const [pendingAgentMode, setPendingAgentMode] = useState(false);
  useEffect(() => {
    if (activeId) setPendingAgentMode(false);
  }, [activeId]);

  // Домен «Подключение к ИИ»: настройки, профили, шифрование, статус соединения
  const {
    apiSettings,
    setApiSettings,
    apiStatus,
    setApiStatus,
    profiles,
    activeProfileId,
    cryptoGate,
    localRuntimes,
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
    handleUseGgufServe,
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
  // Библиотека джейлбрейков: свои записи в localStorage; применяется
  // только явным кликом (карточка «Промптов» / пикер системного промта)
  const [jailbreaks, setJailbreaks] = useState<JailbreakEntry[]>(() =>
    loadJailbreaks(),
  );
  // Корневая папка проекта для файлового менеджера (M4.2), помнит выбор
  const [projectRoot, setProjectRoot] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEYS.projectRoot),
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
    if (localStorage.getItem(STORAGE_KEYS.keepAwake) === "1") {
      void keepAwake(true).catch(() => {});
    }
  }, []);

  // Корневая папка файлового менеджера запоминается между запусками
  useEffect(() => {
    if (projectRoot) localStorage.setItem(STORAGE_KEYS.projectRoot, projectRoot);
    else localStorage.removeItem(STORAGE_KEYS.projectRoot);
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
      localStorage.setItem(STORAGE_KEYS.usage, JSON.stringify(usageLogRef.current.slice(-4999)));
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
                  // root — критичное поле: сессии проекта хранятся в
                  // <root>/.nocturn, а без него loadHistory пропускает партицию
                  // (чаты проекта исчезают после рестарта)
                  root: typeof rec.root === "string" ? rec.root : undefined,
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
          // root обязан уезжать на диск: без него Rust-сторона (ProjectRec,
          // serde default None) затирала бы файл, и партиция сессий проекта
          // переставала читаться после рестарта
          root: p.root ?? null,
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
  // [P12] Реестр плагинных скиллов для skill_run — рефом (паттерн
  // notifyPrefsRef): рефы не пересоздают колбэки движка.
  // Обновление в эффекте: запись в ref в теле рендера вне модели
  // React Compiler (аудит A4-8)
  const pluginSkillsRef = useRef(pluginSkills);
  useEffect(() => {
    pluginSkillsRef.current = pluginSkills;
  }, [pluginSkills]);
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
  // Волна E1: персистентные правила прав — реф для useAgentRun (perm_set и
  // политика подтверждений). Секция «Права» сохраняет сама и дёргает событие
  const [permRules, setPermRules] = useState<PermRules>(loadPermRules);
  const permRulesRef = useRef(permRules);
  useEffect(() => {
    permRulesRef.current = permRules;
  }, [permRules]);
  useEffect(() => {
    const onChange = () => setPermRules(loadPermRules());
    window.addEventListener(PERM_RULES_CHANGED, onChange);
    return () => window.removeEventListener(PERM_RULES_CHANGED, onChange);
  }, []);

  const notifyPrefsRef = useRef(notifyPrefs);
  useEffect(() => {
    notifyPrefsRef.current = notifyPrefs;
    saveNotifyPrefs(notifyPrefs);
  }, [notifyPrefs]);
  // Звуки прогона: стор — localStorage (useAgentRun читает его в момент
  // события, пропсы в хук не тянут); стейт здесь — только для UI настроек
  const [runSoundPrefs, setRunSoundPrefs] = useState<RunSoundPrefs>(loadRunSoundPrefs);
  useEffect(() => {
    saveRunSoundPrefs(runSoundPrefs);
  }, [runSoundPrefs]);
  // Медиа-минибар («Интеграции»): стейт для настроек и рендера полоски
  const [mediaPrefs, setMediaPrefs] = useState<MediaPrefs>(loadMediaPrefs);
  // Лента лирики (LyricsRibbon): снимок от MediaBar — режим интеграции
  // Spotify/YouTube, ambient-фон не трогается; пусто без музыки/лирики
  const [mediaLyrics, setMediaLyrics] = useState<MediaLyricsSnapshot | null>(
    null,
  );
  useEffect(() => {
    saveMediaPrefs(mediaPrefs);
  }, [mediaPrefs]);
  // Повтор очереди YT: тумблер «Интеграций» — источник правды, плеер —
  // потребитель. Раньше поле и ветка в onTrackChange были, а синка не было:
  // тумблер молча ничего не делал (аудит 07.10 A7-13)
  useEffect(() => {
    ytSetLoopQueue(mediaPrefs.ytLoopQueue);
  }, [mediaPrefs.ytLoopQueue]);
  // Лента «за интерфейсом» (CSS читает data-attr): ставим по тумблеру,
  // не по наличию снапшота — иначе завеса корня чата мигала бы на паузе
  useEffect(() => {
    if (mediaPrefs.ribbon) {
      document.documentElement.dataset.mediaRibbon = "1";
    } else {
      delete document.documentElement.dataset.mediaRibbon;
    }
  }, [mediaPrefs.ribbon]);
  // Включил YouTube — всплывающая инструкция «как этим пользоваться»
  // (реф-гард: один тост на включение, без deps-эффекта — паттерн дома)
  const ytHowToShownRef = useRef(false);
  useEffect(() => {
    if (mediaPrefs.youtube && !ytHowToShownRef.current) {
      ytHowToShownRef.current = true;
      addToast(
        t("media.ytHowTo", { bind: binds.youtube_toggle ?? "Ctrl+Alt+Y" }),
      );
    }
    if (!mediaPrefs.youtube) ytHowToShownRef.current = false;
  });
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
    limitSeq,
  } = useAgentRun({
    setSessions,
    sessionsRef,
    activeId,
    apiSettings,
    effortRef,
    subConfigRef,
    pluginSkillsRef,
    notifyPrefsRef,
    projectRootRef,
    browserAutoPanelRef,
    activeSessionRef,
    setBrowserPanelOpen,
    addToast,
    setUsageLog,
    chainRunning,
    pendingAgentMode,
    askAutoContinue,
    notifyMeta,
    activeProjectId,
    setActiveId,
    limitsRef,
    memoryEnabled,
    permRulesRef,
    onKbTrace: setKbTrace,
  });
  // Для автосейва: активный стрим. Эффект вместо записи в теле рендера —
  // под React Compiler мутация ref во время рендера вне модели
  useEffect(() => {
    streamingActiveRef.current = streamingId !== null;
  }, [streamingId]);

  // Прогрев аудиотракта по ПЕРВОМУ жесту в окне, а не по таймеру при старте:
  // открытие микрофона заставляет Windows приглушать чужую музыку под
  // «связь» (тот же эффект, что у Discord) и переводит BT-гарнитуру в
  // режим гарнитуры — на запуске это воспринималось как «Nocturn глушит
  // музыку». Тот же первый getUserMedia в сессии WebView2 морозил UI на
  // секунды. Гасим обе неприятности в момент первого клика/клавиши, когда
  // пользователь уже активно пользуется окном; до жеста — ни звука
  useEffect(() => {
    let warmed = false;
    const warm = () => {
      if (warmed) return;
      warmed = true;
      window.removeEventListener("pointerdown", warm, true);
      window.removeEventListener("keydown", warm, true);
      void navigator.mediaDevices
        ?.getUserMedia({ audio: true })
        .then((s) => s.getTracks().forEach((t) => t.stop()))
        .catch(() => {});
    };
    window.addEventListener("pointerdown", warm, true);
    window.addEventListener("keydown", warm, true);
    return () => {
      window.removeEventListener("pointerdown", warm, true);
      window.removeEventListener("keydown", warm, true);
    };
  }, []);

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

  // Стабильная правка сообщения: инлайн-стрелка в JSX пересоздавалась
  // каждый рендер и сидела в deps useMemo feedNodes (ChatArea) — лента
  // перестраивалась на каждый тик стрима. deps: сессия/движок
  const handleEditMessage = useCallback(
    (msgId: string, text: string) => {
      void stableHandleSend(text, undefined, activeId ?? undefined, undefined, undefined, msgId);
    },
    [stableHandleSend, activeId],
  );

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

  // Telegram фаза 2/3: команда от привязанного чата (текст или нажатие
  // inline-кнопки). Диспетчер через реф (паттерн dispatchShortcutRef):
  // подписка mount-only, замыкание всегда свежее
  const telegramDispatchRef = useRef<(cmd: TelegramCommand) => void>(() => {});
  useEffect(() => {
    telegramDispatchRef.current = (cmd: TelegramCommand) => {
      // Фаза 3: нажатие inline-кнопки — решение по подтверждению или выбор
      // опции ask_user, одним тапом с телефона
      if (cmd.type === "callback") {
        if (cmd.data.startsWith("confirm:")) {
          const d = cmd.data.slice("confirm:".length);
          if (
            (d === "once" || d === "always" || d === "deny") &&
            interactions.some((i) => i.kind === "confirm")
          ) {
            handleConfirmDecision(d);
          }
          return;
        }
        if (cmd.data.startsWith("ask:")) {
          const [, mid, idxRaw] = cmd.data.split(":");
          if (!mid) return;
          const idx = Number(idxRaw);
          const ask = interactions.find((i) => i.kind === "ask" && i.msgId === mid);
          if (ask && ask.kind === "ask" && Number.isInteger(idx)) {
            const opt = ask.spec.options[idx];
            if (opt) handleAskAnswer(mid, { answers: [opt.label] });
          }
          return;
        }
        return;
      }

      const text = cmd.text.trim();
      if (!text) return;
      // /stop — остановить идущий прогон
      if (/^\/stop\b/i.test(text)) {
        stableHandleStop();
        return;
      }
      // Текстовое решение по ожидающемуся подтверждению (да/нет/всегда)
      const decision = confirmDecisionFromText(text);
      if (decision) {
        if (interactions.some((i) => i.kind === "confirm")) {
          handleConfirmDecision(decision);
          return;
        }
        // подтверждения нет — текст пойдёт как задача/поправка
      }
      // Поправка в идущий прогон — тот же путь, что кнопка «Поправить»
      const rid = streamingIdRef.current;
      if (rid) {
        // Реф синхронно: агентный цикл читает поправки между шагами
        pendingCorrectionsRef.current = {
          ...pendingCorrectionsRef.current,
          [rid]: [...(pendingCorrectionsRef.current[rid] ?? []), text],
        };
        setPendingCorrections((prev) => ({
          ...prev,
          [rid]: [...(prev[rid] ?? []), text],
        }));
        addToast(t("tg.correctionSent"));
        return;
      }
      // Движок занят (окно подготовки) — в очередь, как чипы композера
      if (activeRunRef.current !== null) {
        setQueuedMsgs((prev) => [...prev, { id: uid(), text }]);
        addToast(t("tg.taskQueued"));
        return;
      }
      // Новая задача (создаст сессию, если активной нет)
      void stableHandleSend(text);
    };
  });

  useEffect(() => {
    let disposed = false;
    let un: (() => void) | undefined;
    void onTelegramCommand((cmd) => {
      if (disposed) return;
      telegramDispatchRef.current(cmd);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Quick Entry: применить сохранённый ремап комбо (дефолт уже зарегистрирован
  // на бекенде в setup; промах — комбо занято другим приложением, бэк вернёт
  // дефолт). Затем статус регистрации: на Wayland-подобных системах глобальный
  // хоткей недоступен вовсе — сообщаем тостом вместо вечной тишины.
  // t — через зеркало (паттерн useSessions): смена языка не должна
  // перезапускать бинд + двойной статус-чек с паузой 6 с
  const tMirrorQuickEntry = useRef(t);
  useEffect(() => {
    tMirrorQuickEntry.current = t;
  }, [t]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = localStorage.getItem(STORAGE_KEYS.quickentryBind);
      if (saved) {
        await quickentrySetBind(saved).catch(() => {
          if (!cancelled) addToast(tMirrorQuickEntry.current("main.quickentryBindFail"));
        });
      }
      const ok = await quickentryStatus().catch(() => true);
      if (!ok && !cancelled) {
        // На Wayland портал показывает диалог подтверждения — хоткей может
        // появиться через несколько секунд после старта: перепроверяем,
        // прежде чем объявлять его недоступным
        await new Promise((r) => setTimeout(r, 6000));
        const rechecked = await quickentryStatus().catch(() => false);
        if (!rechecked && !cancelled)
          addToast(tMirrorQuickEntry.current("main.quickentryUnavailable"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addToast]);

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
  // Ключ темы маскота: stringify в теле JSX пересчитывался на каждый флеш
  // стрима (App ре-рендерится на typing/activity) — тот же класс, что уже
  // закрыт settingsFingerprint'ом (аудит 2026-10-04)
  const mascotThemeKey = useMemo(
    () => `${theme}|${JSON.stringify(appearance)}`,
    [theme, appearance],
  );
  const queuedProps = useMemo(
    () => queuedMsgs.map((q) => ({ id: q.id, text: q.text })),
    [queuedMsgs],
  );

  // Обои: класс на html — CSS делает сайдбар/чат чуть прозрачными,
  // чтобы фон уходил за сайдбар (раньше обои обрывались на его границе).
  // Full Claude обои игнорирует — чистые монолитные заливки
  useEffect(() => {
    document.documentElement.classList.toggle(
      "has-wallpaper",
      Boolean(appearance.chatWallpaper) && !appearance.fullClaude,
    );
  }, [appearance.chatWallpaper, appearance.fullClaude]);

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
    async (fsWrites: ChangedFile[], focusPath?: string) => {
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
      setDiffReview({ open: true, files: [...byPath.values()], focus: focusPath });
    },
    // ref стабилен; включён для exhaustive-deps
    [lastCheckpointRef],
  );

  // «＋ Новый проект» из селектора композера (паттерн-референс «добавить проект
  // прямо в секции»): выбранная папка → проект → сразу становится активным
  const handleNewProjectFromComposer = useCallback(async () => {
    const picked = await pickFolder().catch(() => null);
    if (!picked) return;
    const name =
      picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    setProjects((prev) => [...prev, { id, name, root: picked }]);
    setActiveProjectId(id);
    setProjectRoot(picked);
  }, []);

  // Open на строке карточки изменений: системное приложение (стиль референса).
  // Корень проекта — для относительных путей fs_write; ошибка — тостом,
  // а не молча (open_path фейлится на файлах без ассоциации)
  const handleOpenFileExternal = useCallback(
    (path: string, mode: "open" | "explorer" | "vscode" = "open") => {
      openFileExternal(projectRootRef.current, path, mode).catch((e) =>
        addToast(String(e)),
      );
    },
    [addToast],
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
          // Элементам с диска не верим на слово (конвенция «диск не доверяем»):
          // бинды — только строки известных действий, кастомные — валидная форма
          const rawBinds = (rec.binds ?? {}) as Record<string, unknown>;
          const cleanBinds = Object.fromEntries(
            SHORTCUT_ACTIONS.map((a) => [
              a,
              typeof rawBinds[a] === "string" ? (rawBinds[a] as string) : SHORTCUT_DEFAULTS[a],
            ]),
          ) as ShortcutBinds;
          setBinds(cleanBinds);
          setCustomShortcuts(
            (rec.custom as unknown[]).filter(
              (c): c is CustomShortcut =>
                !!c &&
                typeof c === "object" &&
                typeof (c as CustomShortcut).id === "string" &&
                typeof (c as CustomShortcut).combo === "string" &&
                typeof (c as CustomShortcut).command === "string",
            ),
          );
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

  // ---------- Идл-очередь (offpeak, блок 12 шаг 3 — паттерн референс) ----------
  // Задачи без расписания: исполняются, когда движок свободен и пользователь
  // не активен дольше порога простоя. Активность = клавиши/клики где угодно
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener("keydown", mark, { passive: true });
    window.addEventListener("pointerdown", mark, { passive: true });
    return () => {
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointerdown", mark);
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      const list = loadOffPeak();
      const task = nextWaiting(list);
      if (!task) return;
      // Движок занят (прогон/автоматизация/цепочка) — промт не теряется,
      // задача уедет на ближайшем тике простоя (контракт автоматизаций)
      if (activeRunRef.current) return;
      if (!isIdle(Date.now(), lastActivityRef.current, false)) return;
      // Без настроенного API — как у автоматизаций: ждём, не спамим
      if (
        apiSettingsRef.current.api_key.trim() === "" ||
        apiSettingsRef.current.model.trim() === ""
      ) {
        return;
      }
      const send = handleSendRef.current;
      if (!send) return;
      const session: Session = {
        id: uid(),
        title: task.title.slice(0, 48),
        createdAt: Date.now(),
        messages: [],
      };
      saveOffPeak(
        list.map((t) => (t.id === task.id ? { ...t, status: "running" as const } : t)),
      );
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
      // runStartedRef различает «движок занят, send bail-ит» (C10): задача
      // возвращается в очередь, а не помечается выполненной
      runStartedRef.current = false;
      void send(task.text, undefined, session.id).then(
        () => {
          const started = runStartedRef.current;
          const cur = loadOffPeak();
          saveOffPeak(
            cur.map((t) =>
              t.id === task.id
                ? started
                  ? { ...t, status: "done" as const, ranAt: Date.now() }
                  : { ...t, status: "waiting" as const }
                : t,
            ),
          );
        },
        (e) => {
          const cur = loadOffPeak();
          saveOffPeak(
            cur.map((t) =>
              t.id === task.id
                ? { ...t, status: "failed" as const, ranAt: Date.now(), error: String(e) }
                : t,
            ),
          );
        },
      );
    }, 30_000);
    return () => clearInterval(timer);
    // mount-only по замыслу, как тикер автоматизаций
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Voice Wake («Jarvis-режим») ----------
  // Слушатель живёт, пока включён тумблер; suspend на время стрима (микрофон
  // не нужен, пока агент работает) и на время диктовки (арбитраж через
  // nocturn-voice-busy внутри VoiceWake). Результат — новая задача через
  // тот же агентный цикл, что у обычных сообщений: perm-слой и Hard Limits
  // применяются как всегда
  const voiceWakeRef = useRef<WakeHandle | null>(null);
  // Задача, запущенная голосом: по её завершении (если включена озвучка)
  // последняя реплика ассистента произносится локальным SAPI
  const voiceSessionRef = useRef<string | null>(null);
  // Фаза для пилюли сверху: слушает (детектор активен) → выполняет (голосовая
  // задача стримится) → выполнил (завершена, гаснет сама)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const voiceOptsRef = useRef({ model: voiceModel, threshold: voiceThreshold, tts: voiceTtsReply });
  // Опции ЖИВОГО слушателя: слайдер порога мутирует threshold по месту —
  // VoiceWake читает его каждый кадр детектора, пересоздание микрофона и
  // модели на каждый шаг слайдера не нужно (аудит 07.10 A4-12)
  const wakeOptsRef = useRef<WakeOptions | null>(null);
  useEffect(() => {
    voiceOptsRef.current = { model: voiceModel, threshold: voiceThreshold, tts: voiceTtsReply };
    if (wakeOptsRef.current) wakeOptsRef.current.threshold = voiceThreshold;
  }, [voiceModel, voiceThreshold, voiceTtsReply]);
  // streamingId для асинхронных колбэков слушателя: эффект не должен
  // пересоздавать слушателя на каждый старт/финиш прогона
  const streamingIdRef = useRef(streamingId);
  useEffect(() => {
    streamingIdRef.current = streamingId;
    // Стрим идёт → микрофон не нужен: экономим устройство и батареи
    const h = voiceWakeRef.current;
    if (streamingId && voiceSessionRef.current) setVoicePhase("run");
    if (!h) return;
    if (streamingId) h.suspend();
    else h.resume();
  }, [streamingId]);

  useEffect(() => {
    if (!voiceWakeOn) return;
    setVoicePhase("listen");
    // Порог — из ref: включение его в deps пересоздавало слушателя (закрыть
    // микрофон, выгрузить модель, открыть заново) на каждый шаг слайдера
    // «Порог» (аудит 07.10 A4-12); живое изменение — через wakeOptsRef ниже
    const opts: WakeOptions = {
      model: voiceModel,
      threshold: voiceOptsRef.current.threshold,
      onState: (s) => {
        // Индикатор всегда слушающего микрофона (CSS-точка в углу)
        document.documentElement.classList.toggle(
          "voice-listening",
          s === "listening" || s === "capturing",
        );
        // Пилюля: suspended во время стрима не сбрасывает «выполняет»
        if (s === "listening" || s === "capturing") setVoicePhase("listen");
        else if (s === "suspended" && !streamingIdRef.current) setVoicePhase("idle");
      },
      onError: (msg) => {
        addToast(msg === "mic denied" ? t("voice.micDenied") : t("voice.failed", { e: msg.slice(0, 90) }));
      },
      onWake: (b64) => {
        void (async () => {
          try {
            const raw = (await dictationTranscribe(b64)).trim();
            const cmd = stripWakeWord(raw, voiceOptsRef.current.model);
            if (!cmd) {
              addToast(t("voice.noCommand"));
              return;
            }
            addToast(t("voice.heard", { s: cmd.slice(0, 80) }));
            const session: Session = {
              id: uid(),
              title: cmd.slice(0, 48),
              createdAt: Date.now(),
              messages: [],
            };
            voiceSessionRef.current = session.id;
            setSessions((prev) => [session, ...prev]);
            setActiveId(session.id);
            handleSendRef.current?.(cmd, undefined, session.id);
          } catch (e) {
            addToast(t("voice.failed", { e: String(e).slice(0, 90) }));
          }
        })();
      },
    };
    wakeOptsRef.current = opts;
    const handle = new VoiceWake(opts);
    voiceWakeRef.current = handle;
    void handle.start();
    if (streamingIdRef.current) handle.suspend();
    return () => {
      handle.stop();
      voiceWakeRef.current = null;
      wakeOptsRef.current = null;
      document.documentElement.classList.remove("voice-listening");
      setVoicePhase("idle");
    };
    // t/addToast/handleSendRef/setSessions/setActiveId — стабильные рефы и
    // сеттеры; слушатель mount-only по замыслу (как тикер автоматизаций).
    // Порог — через voiceOptsRef (см. комментарий выше): слайдер меняет его
    // без пересоздания слушателя
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceWakeOn, voiceModel]);

  // Ответ голосовой задачи — вслух (локальный SAPI), если тумблер включён.
  // По завершении голосовой задачи пилюля показывает «выполнил» и гаснет
  useEffect(() => {
    if (streamingId || !voiceSessionRef.current) return;
    const sid = voiceSessionRef.current;
    const sess = sessions.find((s) => s.id === sid);
    const lastAssistant = [...(sess?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    // Прогон упал с ошибкой (пустой content + error): раньше ранний return
    // оставлял voiceSessionRef и фазу «выполняет» висеть до следующего
    // успешного голосового прогона
    if (lastAssistant && lastAssistant.error) {
      voiceSessionRef.current = null;
      setVoicePhase(voiceWakeOn ? "listen" : "idle");
      return;
    }
    if (!lastAssistant?.content?.trim()) return;
    voiceSessionRef.current = null;
    setVoicePhase("done");
    const toListen = window.setTimeout(
      () => setVoicePhase(streamingIdRef.current ? "run" : voiceWakeOn ? "listen" : "idle"),
      2500,
    );
    if (!voiceOptsRef.current.tts) return () => window.clearTimeout(toListen);
    stopSpeaking();
    speak(lastAssistant.content, () => {});
    return () => window.clearTimeout(toListen);
  }, [streamingId, sessions, voiceWakeOn]);

  // onClose модалок мемоизированы: инлайн-стрелки пересоздавались на каждый
  // флеш стрима (~60/с), и Escape-эффекты модалок пере-подписывали listener
  // на каждый рендер (паттерн рефов для колбэков уже используется ниже)
  const closeChainMonitor = useCallback(() => setChainMonitorOpen(false), []);
  const closeGraph = useCallback(() => setGraphOpen(false), []);
  const closeNote = useCallback(() => setOpenNoteFile(null), []);
  const closeAutomations = useCallback(() => setAutomationsOpen(false), []);
  const closeCompare = useCallback(() => setCompareOpen(false), []);
  const closeKnowledge = useCallback(() => setKnowledgeOpen(false), []);
  const closeBrowserPanel = useCallback(() => setBrowserPanelOpen(false), []);
  const closeDiffReview = useCallback(
    () => setDiffReview((p) => ({ ...p, open: false })),
    [],
  );
  const closePlanPanel = useCallback(() => setPlanPanelOpen(false), []);
  const closeResetConfirm = useCallback(() => setResetOpen(false), []);
  const closeSearch = useCallback(
    () => withViewTransition(() => setSearchOpen(false)),
    [],
  );
  const closeContextMenu = useCallback(() => setMenu(null), []);

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
        void windowToggleFullscreen().catch(() => {});
        break;
      case "toggle_zen":
        // Медитативный режим: весь GUI скрыт, остаётся только ambient/фон.
        // Повторный бинд возвращает интерфейс
        setZenMode((v) => !v);
        break;
      case "youtube_toggle":
        // Плеер YouTube: окно скрывается/показывается, звук не прерывается.
        // Интеграция выключена — честная подсказка вместо мёртвого бинда
        if (mediaPrefs.youtube) ytToggleOpen();
        else addToast(t("media.ytNeedEnable"));
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
      // AltGr (европейские раскладки) приходит в Chromium как ctrl+alt:
      // AltGr+Z = «ż», и матч Ctrl+Alt+Z глотал символ preventDefault'ом
      // и дёргал Zen/YouTube посреди набора текста (аудит A3-1). Клавиши
      // с AltGraph — всегда ввод текста, хоткеям приложения они не принадлежат
      if (e.getModifierState("AltGraph")) return;
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

  const handleSaveJailbreaks = (list: JailbreakEntry[]) => {
    setJailbreaks(list);
    saveJailbreaks(list);
  };

  // Применение джейлбрейка: ДОБАВЛЯЕТ текст к системному промту активной
  // задачи (не затирая роль); без активной задачи — новая задача с этим
  // промтом, как у применения пресета роли. Возвращает, куда встал промт:
  // тост НЕ виден из открытых настроек (z-toast ниже z-modal), карточка
  // дублирует результат инлайн-строкой
  const handleApplyJailbreak = (entry: JailbreakEntry): "task" | "new" => {
    if (activeSession) {
      handleSetSystemPrompt(
        appendJailbreak(activeSession.systemPrompt ?? "", entry.text),
      );
      addToast(t("jb.applied", { name: entry.name }));
      return "task";
    }
    handleApplyPreset(entry.text);
    addToast(t("jb.appliedNew", { name: entry.name }));
    return "new";
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
      title: start.title,
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

  // Новый проект: root приходит из вариантов «+» (папка/файл); без root —
  // открываем выбор папки. В <root>/.nocturn будут жить сессии проекта
  const handleAddProject = (name: string, root?: string) => {
    if (root) {
      setProjects((prev) => [
        ...prev,
        { id: `p-${crypto.randomUUID().slice(0, 8)}`, name, root },
      ]);
      return;
    }
    void pickFolder().then((picked) => {
      setProjects((prev) => [
        ...prev,
        {
          id: `p-${crypto.randomUUID().slice(0, 8)}`,
          name,
          ...(picked ? { root: picked } : {}),
        },
      ]);
    });
  };

  // Назначить/сменить папку существующего проекта (контекст-меню проекта)
  const handleProjectFolder = (id: string) => {
    void pickFolder().then((root) => {
      if (!root) return;
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, root } : p)));
      addToast(t("menu.projectFolderSet", { s: root }));
    });
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
    // Фолбэк внутри (старые WebKitGTK) — при недоступности обоих путей молчим
    await copyText(title);
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
  // [онбординг] Жёсткие темы из визарда: всегда тёмные, взаимоисключимы,
  // выбор обычной темы гасит обе. Акцент в жёстких темах фиксируется темой
  const handleOnboardingHardTheme = (kind: "official" | "fullClaude" | null) => {
    setAppearance((a) => ({
      ...a,
      official: kind === "official",
      fullClaude: kind === "fullClaude",
    }));
    if (kind) setTheme("dark");
  };
  const handleOnboardingAccent = (hex: string) =>
    setAppearance((a) => ({ ...a, accent: hex }));

  const handleOnboardingFinish = async (res: OnboardingResult) => {
    localStorage.setItem(STORAGE_KEYS.onboarded, "1");
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
          label: menuProject.root
            ? t("menu.projectFolderChange")
            : t("menu.projectFolder"),
          onSelect: () => handleProjectFolder(menuProject.id),
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

  // --- Стабильные пропсы sticky-mounted модалок (аудит A4-4): App
  // перерисовывается на каждый 40мс-флаш стрима, инлайн-объекты и стрелки
  // в JSX пробивали бы memo модалок на каждом флаше ---
  const settingsAvailableCommands = useMemo(
    () =>
      slashCommands.map((c) => ({
        name: c.name,
        desc: c.desc,
        argHint: c.argHint,
      })),
    [slashCommands],
  );
  const voiceSettings = useMemo(
    () => ({
      wake: voiceWakeOn,
      model: voiceModel,
      threshold: voiceThreshold,
      ttsReply: voiceTtsReply,
    }),
    [voiceWakeOn, voiceModel, voiceThreshold, voiceTtsReply],
  );
  const handleImportSessions = useCallback((imported: Session[]) => {
    // Импорт внешней истории: дописываем в список, ничего не перезаписываем
    setSessions((prev) => [...imported, ...prev]);
  }, [setSessions]);
  const handleVoiceChange = useCallback((patch: Partial<VoiceSettings>) => {
    if (patch.wake !== undefined) setVoiceWakeOn(patch.wake);
    if (patch.model !== undefined) setVoiceModel(patch.model);
    if (patch.threshold !== undefined) setVoiceThreshold(patch.threshold);
    if (patch.ttsReply !== undefined) setVoiceTtsReply(patch.ttsReply);
  }, [setVoiceWakeOn, setVoiceModel, setVoiceThreshold, setVoiceTtsReply]);
  const handleWarnCancel = useCallback(() => {
    setSettingsSection("main");
  }, []);
  const handleSubConfigChange = useCallback(
    (c: SubagentsConfig) => {
      // роли из плагинов не пишем в свой конфиг — они приходят из плагина
      const pluginIds = new Set(pluginRoles.map((r) => r.id));
      const base = { ...c, roles: c.roles.filter((r) => !pluginIds.has(r.id)) };
      setSubConfig(base);
      subagentsSave(base).catch(() => {});
    },
    [pluginRoles],
  );
  const handleBrowserPanelChange = useCallback((v: boolean) => {
    // useBoolPref сам персистит значение в своём эффекте: ручной
    // setItem здесь был вторым путём записи того же ключа
    setBrowserAutoPanel(v);
  }, [setBrowserAutoPanel]);
  const handleBindsChange = useCallback(
    (b: ShortcutBinds) => persistShortcuts(b, customShortcuts),
    [persistShortcuts, customShortcuts],
  );
  const handleCustomShortcutsChange = useCallback(
    (c: CustomShortcut[]) => persistShortcuts(binds, c),
    [persistShortcuts, binds],
  );
  const handleExportChatsUi = useCallback(
    () => void handleExportAllChats(),
    [handleExportAllChats],
  );
  const handleKnowledgeAttach = useCallback(
    (kbId: string | null) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId ? { ...s, kbId: kbId ?? undefined } : s,
        ),
      );
    },
    [activeId, setSessions],
  );

  return (
    <div
      className={`flex h-full overflow-hidden ${
        sidebarSide === "right" ? "flex-row-reverse" : ""
      }`}
    >
        {/* Обои на уровне окна: за сайдбаром и чатом (кастомизация) —
            раньше жили только в колонке чата и «не уходили» за сайдбар.
            В Full Claude не рисуются: чистые монолитные заливки темы */}
        {appearance.chatWallpaper && !appearance.fullClaude && (
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
        {/* Ambient-слой: сцены/видео позади контента, z и паузы — в CSS.
            В светлой теме слой скрыт CSS-ом (display:none) — не монтируем
            совсем: rAF-цикл и видео продолжали бы работать в невидимом слое */}
        {appearance.ambient && !appearance.fullClaude && theme !== "light" && appearance.ambientScene !== "glow" && (
          <AmbientLayer
            scene={appearance.ambientScene}
            videoPath={appearance.ambientVideo}
            density={appearance.ambientDensity}
            // Ambient живой всегда (решение владельца): во время прогона
            // агента не замирает — «плавает» как в Claude Desktop.
            // Пауза только по reduce-motion и в свёрнутом/скрытом окне
            // (hasFocus внутри слоя); GPU-цена принята
            paused={appearance.reduceMotion === true}
            gradFrom={appearance.ambientGradFrom}
            gradTo={appearance.ambientGradTo}
            gradAngle={appearance.ambientGradAngle}
          />
        )}
        {/* Ambient Lyrics: лента строк лирики — режим Spotify/YouTube-
            интеграции (mediaPrefs.ribbon), НЕ зависит от ambient-фона;
            z-behind (−1) — тот же слот, что ambient-behind, выше него по
            порядку DOM, под всем контентом (см. .lyrics-ribbon в index.css) */}
        {mediaPrefs.ribbon && (
          <LyricsRibbon
            snap={mediaLyrics}
            scale={mediaPrefs.ribbonScale}
            composerCentered={chatEmptyForRibbon && !typing && !terminalOpen}
            contentLeft={sidebarWidth}
          />
        )}
        <button
          onClick={() => setSidebarCollapsed(false)}
          title={t("sidebar.expand")}
          className={`absolute top-2 z-[var(--halo-z-panel-top)] flex size-8 items-center justify-center rounded-lg text-halo-accent transition duration-200 hover:bg-halo-hover ${
            sparkVisible ? "opacity-100" : "pointer-events-none opacity-0"
          } ${
            sidebarSide === "right" ? "right-3" : "left-3"
          }`}
        >
          <span className="scale-125">
            <NocturnMark size={18} />
          </span>
        </button>
      {/* Сайдбар, оверлеи и панели — под одним boundary: render-исключение
          в любом из них (SVG-математика графа, сторонний плагин-скин) раньше
          выносило приложение в белый экран — boundary стоял только на ленте
          и SettingsModal. Внутренний boundary ленты срабатывает первым */}
      <ErrorBoundary title={t("err.boundary")} action={t("err.boundaryRetry")}>
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
        onTogglePin={handleTogglePin}
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
        onOpenFileExternal={handleOpenFileExternal}
        subRuns={subRuns}
        plan={activeSession?.plan}
        userCommands={mergedUserCommands}
        extraSkills={pluginSkills}
        onEditMessage={handleEditMessage}
        model={apiSettings.model}
        streamingMsgId={streamingAssistantId}
        visionCapable={
          apiStatus.models?.find((m) => m.id === apiSettings.model)?.vision
        }
        isLocal={/localhost|127\.0\.0\.1/.test(apiSettings.base_url)}
        agentMode={activeSession?.agentMode ?? pendingAgentMode}
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
        mediaPrefs={mediaPrefs}
        projects={projects}
        activeProjectId={activeProjectId}
        onNewProject={handleNewProjectFromComposer}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          // Корень работы следует за проектом: выбор над композером задаёт
          // и контекст новых чатов, и рабочую папку (стиль референса)
          const p = id ? projects.find((x) => x.id === id) : undefined;
          if (p?.root) setProjectRoot(p.root);
        }}
        onOpenSettingsSection={(s) => {
          setSettingsSection(s);
          setSettingsOpen(true);
        }}
        promptPresets={builtinPresetsFor(lang)}
        customPresets={promptLibrary}
        jailbreaks={jailbreaks}
        onMediaLyrics={setMediaLyrics}
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
        onOpenCompare={() => setCompareOpen(true)}
        onOpenKnowledge={() => setKnowledgeOpen(true)}
        onOpenSettings={() => {
          setSettingsSection("api");
          setSettingsOpen(true);
        }}
        onSetSystemPrompt={(p) =>
          activeId || p == null
            ? handleSetSystemPrompt(p)
            : createChat({ systemPrompt: p })
        }
        onApplyPreset={handleApplyPreset}
        onToggleAgent={() =>
          activeId ? handleToggleAgent() : setPendingAgentMode((v) => !v)
        }
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        projectRoot={projectRoot}
        termShell={termShell}
        termPalette={TERMINAL_PALETTES[appearance.termPalette ?? "default"]}
        termBlur={appearance.termBlur}
        terminalHeightPct={terminalHeight}
        onTerminalResizeStart={startTerminalResize}
        scrollFollow={scrollFollow}
        printSpeed={printSpeed}
        streamSmooth={streamSmooth}
        highlightLive={highlightLive}
        showReasoning={showReasoning}
        streamCaret={streamCaret}
        showUserMsgs={showUserMsgs}
        groupTurns={groupTurns}
        chatMark={chatMark}
        msgGlass={msgGlass}
        mascot={mascot}
        mascotSize={mascotSize}
        mascotGlow={mascotGlow}
        mascotEaster={mascotEaster}
        mascotSelf={mascotSelf}
        mascotColors={mascotColors}
        mascotThemeKey={mascotThemeKey}
        mascotSide={mascotSide}
        onMascotSideChange={setMascotSide}
        mascotShooed={mascotShooed}
        onMascotShoo={() => setMascotShooed(true)}
        mascotLimitSeq={limitSeq}
        mascotName={mascotName}
        onToast={addToast}
        settingsClosedSeq={settingsClosedSeq}
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
        <Suspense fallback={null}>
          <LazyChainMonitor
            chain={chain}
            onClose={closeChainMonitor}
          />
        </Suspense>
      )}
      {graphOpen && (
        <Suspense fallback={null}>
          <LazyGraphModal
            notes={notes}
            onOpenNote={(f) => {
              setGraphOpen(false);
              void handleOpenNote(f);
            }}
            onClose={closeGraph}
          />
        </Suspense>
      )}
      {openNoteFile !== null && (
        <Suspense fallback={null}>
          <LazyNotesModal
            note={notes.find((n) => n.file === openNoteFile) ?? null}
            allNotes={notes}
            saving={noteSaving}
            onSave={(f, c) => void handleSaveNote(f, c)}
            onRunChain={(f, c) => void handleRunChain(f, c)}
            onDelete={(f) => void handleDeleteNote(f)}
            onOpenNote={(f) => void handleOpenNote(f)}
            onClose={closeNote}
          />
        </Suspense>
      )}
      <ErrorBoundary title={t("err.boundary")} action={t("err.boundaryRetry")}>
      {/* Sticky-mount (useEverOpened): до первого открытия чанка нет вообще,
          после — компонент живёт смонтированным, поэтому внутреннее состояние
          (вкладка/поиск) и exit-анимация useDelayedUnmount — как раньше */}
      {settingsMounted && (
      <Suspense fallback={null}>
      <LazySettingsModal
        open={settingsOpen}
        onWarnCancel={handleWarnCancel}
        onOpenGgufLab={openGgufLab}
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
        onImportSessions={handleImportSessions}
        voice={voiceSettings}
        onVoiceChange={handleVoiceChange}
        sidebarSide={sidebarSide}
        onSidebarSideChange={setSidebarSide}
        scrollFollow={scrollFollow}
        onScrollFollowChange={setScrollFollow}
        streamSmooth={streamSmooth}
        onStreamSmoothChange={setStreamSmooth}
        highlightLive={highlightLive}
        onHighlightLiveChange={setHighlightLive}
        printSpeed={printSpeed}
        onPrintSpeedChange={setPrintSpeed}
        hardMode={hardMode}
        gitAutocommit={gitAutocommit}
        onGitAutocommitChange={setGitAutocommit}
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
        autoUpdateCheck={autoUpdateCheck}
        onAutoUpdateCheckChange={setAutoUpdateCheck}
        archiveRetention={archiveRetention}
        onArchiveRetentionChange={setArchiveRetention}
        onArchiveNow={archiveOldNow}
        onExportChats={handleExportChatsUi}
        streamCaret={streamCaret}
        onStreamCaretChange={setStreamCaret}
        showUserMsgs={showUserMsgs}
        onShowUserMsgsChange={setShowUserMsgs}
        groupTurns={groupTurns}
        onGroupTurnsChange={setGroupTurns}
        notifyPrefs={notifyPrefs}
        onNotifyPrefsChange={setNotifyPrefs}
        mediaPrefs={mediaPrefs}
        onMediaPrefsChange={setMediaPrefs}
        runSoundPrefs={runSoundPrefs}
        onRunSoundPrefsChange={setRunSoundPrefs}
        plugins={plugins}
        onPluginsChange={setPlugins}
        subConfig={subConfigEffective}
        onSubConfigChange={handleSubConfigChange}
        sessions={sessions}
        settingsLarge={settingsLarge}
        browserPanel={browserAutoPanel}
        onBrowserPanelChange={handleBrowserPanelChange}
        binds={binds}
        customShortcuts={customShortcuts}
        availableCommands={settingsAvailableCommands}
        onBindsChange={handleBindsChange}
        onCustomShortcutsChange={handleCustomShortcutsChange}
        onSettingsLargeChange={setSettingsLarge}
        onEncryptionToggle={handleEncryptionToggle}
        chatMark={chatMark}
        onChatMarkChange={setChatMark}
        msgGlass={msgGlass}
        onMsgGlassChange={setMsgGlass}
        mascot={mascot}
        onMascotChange={setMascot}
        mascotSize={mascotSize}
        onMascotSizeChange={setMascotSize}
        mascotGlow={mascotGlow}
        onMascotGlowChange={setMascotGlow}
        mascotEaster={mascotEaster}
        onMascotEasterChange={setMascotEaster}
        mascotSelf={mascotSelf}
        onMascotSelfChange={setMascotSelf}
        mascotColors={mascotColors}
        onMascotColorChange={setMascotColor}
        mascotName={mascotName}
        onMascotNameChange={setMascotName}
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
        jailbreaks={jailbreaks}
        onChangeJailbreaks={handleSaveJailbreaks}
        onApplyJailbreak={handleApplyJailbreak}
        localRuntimes={localRuntimes}
        allowedCommands={allowedCommands}
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
        onRescanLocal={detectLocal}
        onUseLocalModel={handleUseLocalModel}
        onClose={closeSettings}
      />
      </Suspense>
      )}
      </ErrorBoundary>
      {automationsMounted && (
      <Suspense fallback={null}>
      <LazyAutomationsModal
        open={automationsOpen}
        onClose={closeAutomations}
      />
      </Suspense>
      )}
      {ggufLabMounted && (
      <Suspense fallback={null}>
      <LazyGgufLabModal
        open={ggufLabOpen}
        onClose={closeGgufLab}
        onUseAsChatProvider={handleUseGgufServe}
      />
      </Suspense>
      )}
      {compareMounted && (
      <Suspense fallback={null}>
      <LazyCompareModal
        open={compareOpen}
        onClose={closeCompare}
        profiles={profiles}
        current={apiSettings}
      />
      </Suspense>
      )}
      {knowledgeMounted && (
      <Suspense fallback={null}>
      <LazyKnowledgeModal
        open={knowledgeOpen}
        onClose={closeKnowledge}
        trace={kbTrace}
        attachedKbId={activeSession?.kbId ?? null}
        onAttach={handleKnowledgeAttach}
        hasActiveChat={activeId !== null}
      />
      </Suspense>
      )}
      <BrowserPanel
        open={browserPanelOpen}
        onClose={closeBrowserPanel}
      />
      <DiffPanel
        open={diffReview.open}
        files={diffReview.files}
        focusPath={diffReview.focus}
        onQuote={handleDiffQuote}
        onClose={closeDiffReview}
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
        onClose={closePlanPanel}
      />
      {/* Hard-Mode: полноэкранный живой терминал поверх «спящего» UI.
          Значения из state, а не ref.current в JSX: реф обновляется в
          эффекте ПОСЛЕ коммита, и смена корня/бинда доезжала бы устаревшей */}
      {hardMode && hardSkin && (
        <Suspense fallback={null}>
          <LazyHardTerminal
            cwd={projectRoot ?? undefined}
            combo={binds.hard_mode ?? "Ctrl+Shift+H"}
          />
        </Suspense>
      )}
      {/* YouTube-плеер: модальный оверлей с постоянным iframe. Монтируется
          только при включённой интеграции — размонтирование = сброс */}
      {mediaPrefs.youtube && (
        <YouTubeLayer
          closeBind={binds.youtube_toggle ?? "Ctrl+Alt+Y"}
          autoCollapse={mediaPrefs.ytAutoCollapse}
          keepOpen={mediaPrefs.ytKeepOpen}
          draggable={mediaPrefs.ytDraggable}
          size={mediaPrefs.ytSize}
        />
      )}
      <Toasts items={toasts} />
      {/* Скачивание моделей (whisper / voice wake): тематизированное окно */}
      <DownloadProgress />
      {/* Статус Jarvis: слушает / выполняет / выполнил */}
      <VoicePill phase={voicePhase} />
      {onboardingOpen && splashDone && (
        <Onboarding
          theme={theme}
          onTheme={handleOnboardingTheme}
          onHardTheme={handleOnboardingHardTheme}
          hardTheme={
            appearance.official
              ? "official"
              : appearance.fullClaude
                ? "fullClaude"
                : null
          }
          onAccent={handleOnboardingAccent}
          onFinish={(r) => void handleOnboardingFinish(r)}
        />
      )}
      {resetOpen && (
        <Suspense fallback={null}>
        <LazyResetConfirmModal
          busy={resetBusy}
          onConfirm={() => void handleFactoryReset()}
          onCancel={closeResetConfirm}
        />
        </Suspense>
      )}
      {accentEdit && (
        <div
          className="fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-black/60"
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
          onClose={closeSearch}
        />
      )}
      {menu && (menuSession || menuProject || menuNote) && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeContextMenu}
        />
      )}
      {/* Сплэш: поверх всего, убирается после фейда (onGone из Splash).
          Внутри boundary: render-исключение в Splash иначе давало бы белый
          экран первых секунд — ни одна граница его не ловила */}
      {splashVisible && (
        <Splash done={splashDone} onGone={() => setSplashVisible(false)} />
      )}
      </ErrorBoundary>
    </div>
  );
}
