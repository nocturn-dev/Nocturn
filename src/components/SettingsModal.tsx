import { useEffect, useRef, useState } from "react";
import type { Session, Theme } from "../types";
import UsageSection from "./UsageSection";
import {
  PROVIDERS,
  providerFromBaseUrl,
  type ApiProfile,
  mcpListServers,
  mcpSaveServers,
  mcpConnect,
  mcpDisconnect,
  mcpStatus,
  invalidateToolSchemas,
  browserGetConfig,
  browserSetConfig,
  computerGetConfig,
  computerSetConfig,
  imageGenGetConfig,
  imageGenSetConfig,
  pickAudioFile,
  soundImport,
  soundDelete,
  type ImageGenConfig,
  hooksLoad,
  hooksSave,
  hooksTest,
  HOOK_EVENTS,
  type Hook,
  type HookOutcome,
  type ApiSettings,
  type ModelInfo,
  type McpServerCfg,
  type McpServerStatus,
  type BrowserConfig,
  type ComputerConfig,
} from "../api";
import type { PromptPreset } from "../presets";
import { ACCENT_PRESETS, appearanceTitleStyle, type Appearance } from "../appearance";
import type { ThemeProfile } from "../themeProfiles";
import ProviderIcon from "./ProviderIcon";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_LABEL_KEYS,
  comboFromEvent,
  type CustomShortcut,
  type ShortcutAction,
  type ShortcutBinds,
} from "../shortcuts";
import { BUILTIN_SKILLS } from "../skills";
import SubagentsSection from "./SubagentsSection";
import CommandsSection from "./CommandsSection";
import PluginsSection from "./PluginsSection";
import type { SubagentsConfig } from "../subagents";
import type { HardLimits } from "../limits";
import {
  settingsReadAll,
  settingsWriteAll,
  settingsExportWrite,
  settingsImportRead,
  pickSaveFile,
  pickJsonFile,
  collectLocal,
  restoreLocal,
  networkGetConfig,
  networkSetConfig,
  type NetworkConfig,
} from "../api";
import type { Plugin } from "../api";
import { NOTIFY_SOUNDS, playSound, refreshCustomSound, type NotifyPrefs } from "../notify";
import { dayPeriod } from "../time";
import { useLang, useLangState, useLangSetter, type MsgKey } from "../locales";

export interface ApiStatus {
  kind: "idle" | "checking" | "ok" | "error";
  message?: string;
  models?: ModelInfo[];
}

interface SettingsModalProps {
  open: boolean;
  /** Раздел для программного открытия (null/undefined — как есть) */
  initialSection?: Section | null;
  theme: Theme;
  glass: boolean;
  /** Кастомизация оформления (акцент, стиль, масштаб) */
  appearance: Appearance;
  onAppearanceChange: (a: Appearance) => void;
  termShell: string;
  onTermShellChange: (v: string) => void;
  /** Профили внешнего вида: именованные пресеты (Theme + Appearance) */
  themeProfiles: ThemeProfile[];
  onThemeProfilesChange: (list: ThemeProfile[]) => void;
  onApplyThemeProfile: (p: ThemeProfile) => void;
  /** Hard Limit: лимиты расхода на задачу (токены/$) */
  limits: HardLimits;
  onLimitsChange: (l: HardLimits) => void;
  /** Эргономика: сторона сайдбара и стартовые подсказки */
  sidebarSide: "left" | "right";
  onSidebarSideChange: (side: "left" | "right") => void;
  hideStarter: boolean;
  onHideStarterChange: (v: boolean) => void;
  /** Поведение генерации */
  scrollFollow: boolean;
  onScrollFollowChange: (v: boolean) => void;
  streamSmooth: boolean;
  onStreamSmoothChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  askAutoContinue: boolean;
  onAskAutoContinueChange: (v: boolean) => void;
  autoArchive: boolean;
  onAutoArchiveChange: (v: boolean) => void;
  archiveRetention: number;
  onArchiveRetentionChange: (d: number) => void;
  onArchiveNow: () => void;
  closeToTray: boolean;
  onCloseToTrayChange: (v: boolean) => void;
  streamCaret: boolean;
  onStreamCaretChange: (v: boolean) => void;
  /** Показ сообщений пользователя в чате */
  showUserMsgs: boolean;
  onShowUserMsgsChange: (v: boolean) => void;
  groupTurns: boolean;
  onGroupTurnsChange: (v: boolean) => void;
  /** Уведомления о завершении/подтверждении, когда окно не в фокусе */
  notifyPrefs: NotifyPrefs;
  onNotifyPrefsChange: (p: NotifyPrefs) => void;
  /** Все чаты: статистика считается по ним, а не по текущему запуску */
  sessions: Session[];
  /** Конфиг субагентов: роли, параллельность, тумблер */
  subConfig: SubagentsConfig;
  onSubConfigChange: (c: SubagentsConfig) => void;
  /** Установленные плагины */
  plugins: Plugin[];
  onPluginsChange: (p: Plugin[]) => void;
  /** Большое окно настроек по умолчанию (тумблер в «Основном») */
  settingsLarge: boolean;
  onSettingsLargeChange: (v: boolean) => void;
  /** Автооткрытие панели живого просмотра браузера агента */
  browserPanel: boolean;
  onBrowserPanelChange: (v: boolean) => void;
  /** Пользовательские горячие клавиши */
  binds: ShortcutBinds;
  onBindsChange: (b: ShortcutBinds) => void;
  /** Свои хоткеи: комбо → slash-команда */
  customShortcuts: CustomShortcut[];
  onCustomShortcutsChange: (c: CustomShortcut[]) => void;
  /** Доступные slash-команды для кастомных хоткеев */
  availableCommands: { name: string; desc: string; argHint?: string }[];
  /** Тумблер шифрования ключей (API-раздел) */
  onEncryptionToggle: (enable: boolean) => Promise<boolean>;
  /** Призрачный логотип в чате + стекло на ответах ИИ */
  chatMark: boolean;
  onChatMarkChange: (v: boolean) => void;
  msgGlass: boolean;
  onMsgGlassChange: (v: boolean) => void;
  /** Память проектов: контекст предыдущих задач в новых сессиях */
  memoryEnabled: boolean;
  onMemoryChange: (v: boolean) => void;
  apiSettings: ApiSettings;
  apiStatus: ApiStatus;
  /** Профили ключей — живут в profiles.json, управляются из App */
  profiles: ApiProfile[];
  activeProfileId: string;
  onAddProfile: (name: string) => void;
  onApplyProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  promptLibrary: PromptPreset[];
  ollamaModels: string[] | null;
  /** Allowlist активной задачи (M5.2) + её название */
  allowedCommands: string[];
  allowedCommandsTitle: string | null;
  /** Разрешённые команды всех задач — глобальный просмотр на вкладке Agent */
  agentAllowlists: { id: string; title: string; commands: string[] }[];
  onSessionAllowedChange: (id: string, list: string[]) => void;
  onPromptLibraryChange: (list: PromptPreset[]) => void;
  onAllowedCommandsChange: (list: string[]) => void;
  onThemeChange: (theme: Theme) => void;
  onGlassChange: (glass: boolean) => void;
  onApiChange: (settings: ApiSettings) => void;
  onTestConnection: () => void;
  onSaveSettings: () => Promise<void>;
  onDetectOllama: () => void;
  onUseLocalModel: (id: string) => void;
  onClose: () => void;
}

export type Section =
  | "main"
  | "theme"
  | "api"
  | "prompts"
  | "skills"
  | "subagents"
  | "commands"
  | "plugins"
  | "agent"
  | "mcp"
  | "imagegen"
  | "hooks"
  | "shortcuts"
  | "browser"
  | "computer"
  | "memory"
  | "usage"
  | "network"
  | "docs";

/** Навигация настроек: группы как в агентских CLI (Basics / Agent
    capabilities / Data). id: null — раздел-заглушка, будет реализован позже */
const NAV: {
  group: MsgKey;
  items: { id: Section | null; key: MsgKey; icon: string }[];
}[] = [
  {
    group: "nav.basics",
    items: [
      { id: "main", key: "settings.main", icon: "gear" },
      { id: "theme", key: "settings.themes", icon: "palette" },
      { id: "api", key: "settings.api", icon: "box" },
      { id: "browser", key: "settings.browser", icon: "globe" },
      { id: "computer", key: "settings.computer", icon: "monitor" },
      { id: "shortcuts", key: "settings.shortcuts", icon: "keyboard" },
    ],
  },
  {
    group: "nav.agent",
    items: [
      { id: "memory", key: "settings.memory", icon: "brain" },
      { id: "subagents", key: "settings.subagents", icon: "users" },
      { id: "plugins", key: "settings.plugins", icon: "grid" },
      { id: "mcp", key: "settings.mcp", icon: "plug" },
      { id: "imagegen", key: "settings.imagegen", icon: "image" },
      { id: "prompts", key: "settings.prompts", icon: "skill" },
      { id: "skills", key: "settings.skills", icon: "spark" },
      { id: "agent", key: "settings.agent", icon: "terminal" },
      { id: "commands", key: "settings.commands", icon: "command" },
      { id: "hooks", key: "settings.hooks", icon: "anchor" },
    ],
  },
  {
    group: "nav.data",
    items: [
      { id: "network", key: "settings.network", icon: "globe" },
      { id: "usage", key: "settings.usage", icon: "chart" },
    ],
  },
  {
    group: "nav.help",
    items: [{ id: "docs", key: "settings.docs", icon: "book" }],
  },
];

/** Фирменный узор тёмного стиля — плоский 2D-рисунок (fill, currentColor) */
function StylePattern({ id }: { id: Appearance["style"] }) {
  const P = ({
    children,
    vb = "0 0 32 32",
  }: {
    children: React.ReactNode;
    vb?: string;
  }) => (
    <svg width="1em" height="1em" viewBox={vb} fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
  switch (id) {
    case "forest":
      // Ель + малая ель + поляна
      return (
        <P>
          <path d="M10 26 L15 12 L20 26 Z M15 12 L12.4 17 H17.6 Z" />
          <path d="M15 8 L12.8 13 H17.2 Z" opacity="0.8" />
          <path d="M22 26 L25 17 L28 26 Z" opacity="0.7" />
          <ellipse cx="17" cy="27.5" rx="11" ry="1.6" opacity="0.5" />
        </P>
      );
    case "storm":
      // Облако + молния
      return (
        <P>
          <path d="M9 12a6 6 0 0 1 11.5-2A5 5 0 0 1 21 19.8H10A4.5 4.5 0 0 1 9 12z" />
          <path d="M17 17 L11.5 25 H15 L13.5 31 L20 22.5 H16.4 L18.5 17 Z" />
        </P>
      );
    case "midnight":
      // Полумесяц + звёзды
      return (
        <P>
          <path d="M20 4a11 11 0 1 0 7 19.5A12.5 12.5 0 0 1 20 4z" />
          <path d="M8 8l1 2.4L11.4 11.4 9 12.4 8 14.8 7 12.4 4.6 11.4 7 10.4z" opacity="0.9" />
          <circle cx="12" cy="20" r="1.1" opacity="0.7" />
        </P>
      );
    case "abyss":
      // Волны + пузырь
      return (
        <P>
          <path d="M0 18c3-3 6-3 9 0s6 3 9 0 6-3 9 0 5 2.6 5 2.6V32H0z" opacity="0.9" />
          <path d="M0 25c3-2.6 6-2.6 9 0s6 2.6 9 0 6-2.6 9 0 5 2.2 5 2.2V32H0z" opacity="0.6" />
          <circle cx="8" cy="9" r="2" opacity="0.7" />
          <circle cx="14" cy="5" r="1.2" opacity="0.5" />
        </P>
      );
    case "dusk":
      // Горы + серп
      return (
        <P>
          <path d="M2 27 L12 12 L19 23 L23 18 L30 27 Z" opacity="0.85" />
          <path d="M23 4a8 8 0 1 0 5 14A9.4 9.4 0 0 1 23 4z" opacity="0.9" />
        </P>
      );
    case "sepia":
      // Лист с прожилкой
      return (
        <P>
          <path d="M16 3C8 9 6 17 8 24c7 2 15 0 19-8C23 9 20 5 16 3z" />
          <path d="M16 3C14 12 12 19 9 27" stroke="var(--halo-bg)" strokeWidth="1.6" fill="none" />
        </P>
      );
    case "rosewood":
      // Роза: спираль + лист
      return (
        <P>
          <circle cx="14" cy="12" r="9" opacity="0.25" />
          <path d="M14 12a4 4 0 1 1 4 4 6 6 0 1 1-8-1 8.5 8.5 0 0 1 11-1" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M17 22c3 1 5 4 5 8-4 0-7-2-8-5z" opacity="0.8" />
        </P>
      );
    default:
      // Claude — солнце с лучами
      return (
        <P>
          <circle cx="16" cy="16" r="6" />
          <g opacity="0.85">
            <path d="M16 2v5 M16 25v5 M2 16h5 M25 16h5 M6 6l3.5 3.5 M22.5 22.5L26 26 M26 6l-3.5 3.5 M9.5 22.5L6 26" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          </g>
        </P>
      );
  }
}

/** Иконки разделов (14px, stroke — под цвет текста) */
function SectionIcon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0",
  };
  const paths: Record<string, string> = {
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    palette: "M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-2 2c0 1 .5 1.5.5 2.5S13 21 12 21z M7.5 10.5h.01 M12 7h.01 M16.5 10.5h.01",
    box: "M21 8l-9-5-9 5v8l9 5 9-5V8z M3 8l9 5 9-5 M12 13v8",
    globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z",
    monitor: "M8 21h8 M12 17v4 M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
    keyboard: "M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10",
    spark: "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.2 2.2 M16.2 16.2l2.2 2.2 M18.4 5.6l-2.2 2.2 M7.8 16.2l-2.2 2.2",
    brain: "M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-1 5.8V15a3 3 0 0 0 3 3h1v3 M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 1 5.8V15a3 3 0 0 1-3 3h-1v3 M9 3h6",
    users: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M21 21v-2a4 4 0 0 0-3-3.9 M15 3.1a4 4 0 0 1 0 7.8",
    grid: "M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z",
    plug: "M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0V8z M12 18v4",
    skill: "M12 2l2.4 5.9L20 10l-5.6 2.1L12 18l-2.4-5.9L4 10l5.6-2.1L12 2z",
    terminal: "M4 17l6-5-6-5 M12 19h8",
    command: "M15 6a3 3 0 1 1 3 3h-3zM9 6a3 3 0 1 0-3 3h3zM15 18a3 3 0 1 0 3-3h-3zM9 18a3 3 0 1 1-3-3h3zM9 9h6v6H9z",
    anchor: "M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 8v13 M5 12a7 7 0 0 0 14 0 M3 12h4 M17 12h4",
    chart: "M3 21h18 M7 21V9 M12 21V3 M17 21v-8",
    image: "M3 5h18v14H3z M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z",
  };
  return <svg {...common}><path d={paths[name] ?? paths.gear} /></svg>;
}

export default function SettingsModal({
  open,
  initialSection,
  theme,
  glass,
  appearance,
  onAppearanceChange,
  termShell,
  onTermShellChange,
  themeProfiles,
  onThemeProfilesChange,
  onApplyThemeProfile,
  limits,
  onLimitsChange,
  sidebarSide,
  onSidebarSideChange,
  hideStarter,
  onHideStarterChange,
  scrollFollow,
  onScrollFollowChange,
  streamSmooth,
  showReasoning,
  askAutoContinue,
  autoArchive,
  archiveRetention,
  onStreamSmoothChange,
  onShowReasoningChange,
  onAskAutoContinueChange,
  onAutoArchiveChange,
  onArchiveRetentionChange,
  onArchiveNow,
  closeToTray,
  onCloseToTrayChange,
  streamCaret,
  onStreamCaretChange,
  showUserMsgs,
  onShowUserMsgsChange,
  groupTurns,
  onGroupTurnsChange,
  notifyPrefs,
  onNotifyPrefsChange,
  subConfig,
  onSubConfigChange,
  plugins,
  onPluginsChange,
  sessions,
  settingsLarge,
  onSettingsLargeChange,
  browserPanel,
  onBrowserPanelChange,
  binds,
  onBindsChange,
  customShortcuts,
  onCustomShortcutsChange,
  availableCommands,
  onEncryptionToggle,
  chatMark,
  onChatMarkChange,
  msgGlass,
  onMsgGlassChange,
  memoryEnabled,
  onMemoryChange,
  apiSettings,
  apiStatus,
  profiles,
  activeProfileId,
  onAddProfile,
  onApplyProfile,
  onDeleteProfile,
  promptLibrary,
  ollamaModels,
  allowedCommands,
  allowedCommandsTitle,
  agentAllowlists,
  onSessionAllowedChange,
  onPromptLibraryChange,
  onAllowedCommandsChange,
  onThemeChange,
  onGlassChange,
  onApiChange,
  onTestConnection,
  onSaveSettings,
  onDetectOllama,
  onUseLocalModel,
  onClose,
}: SettingsModalProps) {
  const { t } = useLang();
  const [section, setSection] = useState<Section>("main");
  // История навигации: назад — по шагам, куда пользователь заходил
  const [navStack, setNavStack] = useState<Section[]>([]);
  const sectionTitle = (s: Section) => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.id === s);
    return item ? t(item.key) : t("settings.title");
  };
  const goto = (s: Section) => {
    if (s !== section) {
      setNavStack((prev) => (section !== "main" ? [...prev, section] : prev));
      setSection(s);
    }
  };
  const goBack = () => {
    const prev = navStack[navStack.length - 1] ?? "main";
    setNavStack((p) => p.slice(0, -1));
    setSection(prev);
  };
  // Развёрнутое окно (на весь экран) — для широких разделов вроде статистики
  const [expanded, setExpanded] = useState(false);

  // Сброс на первый раздел при открытии — но программное открытие
  // (initialSection, например «Плагины» из сайдбара) имеет приоритет
  useEffect(() => {
    if (open) setSection(initialSection ?? "main");
  }, [open, initialSection]);

  // Закрытие по Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`glass-pane anim-pop flex overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl ${
          expanded
            ? "h-[88vh] w-[92vw] max-w-none"
            : settingsLarge
              ? "h-[min(820px,92vh)] w-[min(1200px,94vw)]"
              : "h-[500px] w-full max-w-xl"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Навигация по разделам: группы «Basics / Agent / Data» */}
        <div className="flex w-48 shrink-0 flex-col border-r border-halo-line p-3">
          <div className="flex items-center justify-between px-2 pb-3">
            <h2 className="text-sm font-semibold text-halo-text">{t("settings.title")}</h2>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? t("settings.collapseWin") : t("settings.expandWin")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                {expanded ? <CollapseWinIcon /> : <ExpandWinIcon />}
              </button>
              <button
                onClick={onClose}
                title={t("common.close")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                <XIcon />
              </button>
            </div>
          </div>
          <nav className="scroll-slim min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
            {NAV.map((g) => (
              <div key={g.group}>
                <p className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-wider text-halo-muted/50">
                  {t(g.group)}
                </p>
                <div className="space-y-0.5">
                  {g.items.map((s) => {
                    const active = s.id !== null && section === s.id;
                    const cls = `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? "bg-halo-hover-strong text-halo-text"
                        : s.id === null
                          ? "cursor-default text-halo-muted/40"
                          : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                    }`;
                    return s.id === null ? (
                      <button
                        key={s.key}
                        disabled
                        title={t("settings.soon")}
                        className={cls}
                      >
                        <SectionIcon name={s.icon} />
                        {t(s.key)}
                      </button>
                    ) : (
                      <button
                        key={s.id}
                        onClick={() => goto(s.id as Section)}
                        className={cls}
                      >
                        <SectionIcon name={s.icon} />
                        {t(s.key)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </div>

        {/* Содержимое раздела */}
        <div className="scroll-slim flex-1 overflow-y-auto p-5">
          {/* Крошки навигации: назад — на шаг, откуда пользователь пришёл */}
          {section !== "main" && (
            <div className="mb-4 flex items-center gap-1.5 text-xs">
              <button
                onClick={goBack}
                title={t("settings.back")}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                <span className="text-sm leading-none">←</span>
                {navStack.length > 0 ? sectionTitle(navStack[navStack.length - 1]) : t("settings.title")}
              </button>
              <span className="text-halo-muted/40">/</span>
              <span className="font-medium text-halo-text">{sectionTitle(section)}</span>
            </div>
          )}
          {section === "main" && (
            <MainSection
              sidebarSide={sidebarSide}
              onSidebarSideChange={onSidebarSideChange}
              hideStarter={hideStarter}
              onHideStarterChange={onHideStarterChange}
              scrollFollow={scrollFollow}
              onScrollFollowChange={onScrollFollowChange}
              streamSmooth={streamSmooth}
              onStreamSmoothChange={onStreamSmoothChange}
              showReasoning={showReasoning}
              onShowReasoningChange={onShowReasoningChange}
              askAutoContinue={askAutoContinue}
              onAskAutoContinueChange={onAskAutoContinueChange}
              autoArchive={autoArchive}
              onAutoArchiveChange={onAutoArchiveChange}
              archiveRetention={archiveRetention}
              onArchiveRetentionChange={onArchiveRetentionChange}
              onArchiveNow={onArchiveNow}
              closeToTray={closeToTray}
              onCloseToTrayChange={onCloseToTrayChange}
              streamCaret={streamCaret}
              onStreamCaretChange={onStreamCaretChange}
              showUserMsgs={showUserMsgs}
              onShowUserMsgsChange={onShowUserMsgsChange}
              groupTurns={groupTurns}
              onGroupTurnsChange={onGroupTurnsChange}
              settingsLarge={settingsLarge}
              onSettingsLargeChange={onSettingsLargeChange}
              browserPanel={browserPanel}
              onBrowserPanelChange={onBrowserPanelChange}
              notifyPrefs={notifyPrefs}
              onNotifyPrefsChange={onNotifyPrefsChange}
              limits={limits}
              onLimitsChange={onLimitsChange}
            />
          )}
          {section === "theme" && (
            <ThemeSection
              theme={theme}
              glass={glass}
              appearance={appearance}
              onAppearanceChange={onAppearanceChange}
              termShell={termShell}
              onTermShellChange={onTermShellChange}
              themeProfiles={themeProfiles}
              onThemeProfilesChange={onThemeProfilesChange}
              onApplyThemeProfile={onApplyThemeProfile}
              onThemeChange={onThemeChange}
              onGlassChange={onGlassChange}
              chatMark={chatMark}
              onChatMarkChange={onChatMarkChange}
              msgGlass={msgGlass}
              onMsgGlassChange={onMsgGlassChange}
            />
          )}
          {section === "api" && (
            <ApiSection
              settings={apiSettings}
              status={apiStatus}
              profiles={profiles}
              activeProfileId={activeProfileId}
              onAddProfile={onAddProfile}
              onApplyProfile={onApplyProfile}
              onDeleteProfile={onDeleteProfile}
              onEncryptionToggle={onEncryptionToggle}
              ollamaModels={ollamaModels}
              onChange={onApiChange}
              onTest={onTestConnection}
              onSave={onSaveSettings}
              onDetectOllama={onDetectOllama}
              onUseLocalModel={onUseLocalModel}
            />
          )}
          {section === "prompts" && (
            <PromptsSection
              library={promptLibrary}
              onChangeLibrary={onPromptLibraryChange}
            />
          )}
          {section === "agent" && (
            <AgentSection
              commands={allowedCommands}
              sessionTitle={allowedCommandsTitle}
              onChange={onAllowedCommandsChange}
              allowlists={agentAllowlists}
              onSessionChange={onSessionAllowedChange}
            />
          )}
          {section === "memory" && (
            <MemorySection
              enabled={memoryEnabled}
              onChange={onMemoryChange}
            />
          )}
          {section === "usage" && <UsageSection sessions={sessions} />}
          {section === "network" && <NetworkSection />}
          {section === "docs" && <DocsSection />}
          {section === "mcp" && <McpSection />}
          {section === "imagegen" && <ImageGenSection />}
          {section === "hooks" && <HooksSection />}
          {section === "shortcuts" && (
            <ShortcutsSection
              binds={binds}
              onChange={onBindsChange}
              custom={customShortcuts}
              onCustomChange={onCustomShortcutsChange}
              availableCommands={availableCommands}
            />
          )}
          {section === "skills" && (
            <SkillsSection
              extra={plugins.filter((p) => p.enabled).flatMap((p) => p.skills ?? [])}
            />
          )}
          {section === "subagents" && (
            <SubagentsSection
              config={subConfig}
              onChange={onSubConfigChange}
              pluginIds={new Set(plugins.filter((p) => p.enabled).flatMap((p) => p.roles ?? []).map((r) => r.id))}
            />
          )}
          {section === "commands" && <CommandsSection />}
          {section === "plugins" && (
            <PluginsSection plugins={plugins} onChange={onPluginsChange} />
          )}
          {section === "browser" && <BrowserUseSection />}
          {section === "computer" && <ComputerUseSection />}
        </div>
      </div>
    </div>
  );
}

/** Hard Limit: лимиты токенов/расходов на одну задачу агента (пусто = без лимита) */
function HardLimitSection({
  limits,
  onChange,
}: {
  limits: HardLimits;
  onChange: (l: HardLimits) => void;
}) {
  const { t } = useLang();
  const fields: { key: keyof HardLimits; label: string }[] = [
    { key: "maxTokens", label: t("limits.maxTokens") },
    { key: "usdPer1M", label: t("limits.usdPer1M") },
    { key: "maxUsd", label: t("limits.maxUsd") },
  ];
  const setField = (k: keyof HardLimits, v: string) => {
    const n = Number(v);
    onChange({ ...limits, [k]: v.trim() === "" || !Number.isFinite(n) ? null : n });
  };
  return (
    <div className="mt-5 rounded-xl border border-halo-line px-3.5 py-3">
      <p className="text-sm text-halo-text">{t("limits.title")}</p>
      <p className="mt-0.5 text-xs text-halo-muted">{t("limits.hint")}</p>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        {fields.map((f) => (
          <label key={f.key} className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-xs text-halo-muted" title={f.label}>
              {f.label}
            </span>
            <input
              type="number"
              min={0}
              value={limits[f.key] ?? ""}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder="—"
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function MainSection({
  sidebarSide,
  onSidebarSideChange,
  hideStarter,
  onHideStarterChange,
  scrollFollow,
  onScrollFollowChange,
  streamSmooth,
  showReasoning,
  askAutoContinue,
  autoArchive,
  archiveRetention,
  onStreamSmoothChange,
  onShowReasoningChange,
  onAskAutoContinueChange,
  onAutoArchiveChange,
  onArchiveRetentionChange,
  onArchiveNow,
  closeToTray,
  onCloseToTrayChange,
  streamCaret,
  onStreamCaretChange,
  showUserMsgs,
  onShowUserMsgsChange,
  groupTurns,
  onGroupTurnsChange,
  notifyPrefs,
  onNotifyPrefsChange,
  settingsLarge,
  onSettingsLargeChange,
  browserPanel,
  onBrowserPanelChange,
  limits,
  onLimitsChange,
}: {
  sidebarSide: "left" | "right";
  onSidebarSideChange: (side: "left" | "right") => void;
  hideStarter: boolean;
  onHideStarterChange: (v: boolean) => void;
  /** Поведение генерации */
  scrollFollow: boolean;
  onScrollFollowChange: (v: boolean) => void;
  streamSmooth: boolean;
  onStreamSmoothChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  askAutoContinue: boolean;
  onAskAutoContinueChange: (v: boolean) => void;
  autoArchive: boolean;
  onAutoArchiveChange: (v: boolean) => void;
  archiveRetention: number;
  onArchiveRetentionChange: (d: number) => void;
  onArchiveNow: () => void;
  closeToTray: boolean;
  onCloseToTrayChange: (v: boolean) => void;
  streamCaret: boolean;
  onStreamCaretChange: (v: boolean) => void;
  showUserMsgs: boolean;
  onShowUserMsgsChange: (v: boolean) => void;
  /** Весь ход агента — одной карточкой */
  groupTurns: boolean;
  onGroupTurnsChange: (v: boolean) => void;
  /** Уведомления о завершении/подтверждении, когда окно не в фокусе */
  notifyPrefs: NotifyPrefs;
  onNotifyPrefsChange: (p: NotifyPrefs) => void;
  settingsLarge: boolean;
  onSettingsLargeChange: (v: boolean) => void;
  /** Автооткрытие панели живого просмотра браузера агента */
  browserPanel: boolean;
  onBrowserPanelChange: (v: boolean) => void;
  /** Hard Limit: лимиты расхода на задачу (токены/$) */
  limits: HardLimits;
  onLimitsChange: (l: HardLimits) => void;
}) {
  const { t } = useLang();
  return (
    <div className="space-y-1">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.main")}</h3>
      <Row label={t("main.version")} value={t("main.versionVal")} />
      <Row
        label={t("main.language")}
        desc={t("main.languageDesc")}
        value=""
        extra={<LangSwitch />}
      />
      <ToggleRow
        label={t("main.sidebarSide")}
        desc={t("main.sidebarSideDesc")}
        on={sidebarSide === "right"}
        onChange={(v) => onSidebarSideChange(v ? "right" : "left")}
      />
      <ToggleRow
        label={t("main.hideStarter")}
        desc={t("main.hideStarterDesc")}
        on={hideStarter}
        onChange={onHideStarterChange}
      />
      <ToggleRow
        label={t("main.scrollFollow")}
        desc={t("main.scrollFollowDesc")}
        on={scrollFollow}
        onChange={onScrollFollowChange}
      />
      <ToggleRow
        label={t("main.streamSmooth")}
        desc={t("main.streamSmoothDesc")}
        on={streamSmooth}
        onChange={onStreamSmoothChange}
      />
      <ToggleRow
        label={t("main.streamCaret")}
        desc={t("main.streamCaretDesc")}
        on={streamCaret}
        onChange={onStreamCaretChange}
      />
      <ToggleRow
        label={t("main.showUserMsgs")}
        desc={t("main.showUserMsgsDesc")}
        on={showUserMsgs}
        onChange={onShowUserMsgsChange}
      />
      <ToggleRow
        label={t("main.groupTurns")}
        desc={t("main.groupTurnsDesc")}
        on={groupTurns}
        onChange={onGroupTurnsChange}
      />
      <ToggleRow
        label={t("main.showReasoning")}
        desc={t("main.showReasoningDesc")}
        on={showReasoning}
        onChange={onShowReasoningChange}
      />
      <ToggleRow
        label={t("main.askAutoContinue")}
        desc={t("main.askAutoContinueDesc")}
        on={askAutoContinue}
        onChange={onAskAutoContinueChange}
      />
      <ToggleRow
        label={t("main.autoArchive")}
        desc={t("main.autoArchiveDesc")}
        on={autoArchive}
        onChange={onAutoArchiveChange}
      />
      <ToggleRow
        label={t("main.closeToTray")}
        desc={t("main.closeToTrayDesc")}
        on={closeToTray}
        onChange={onCloseToTrayChange}
      />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
        <span className="text-xs text-halo-muted">{t("main.archiveAfter")}:</span>
        {[3, 7, 30].map((d) => (
          <button
            key={d}
            onClick={() => onArchiveRetentionChange(d)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              archiveRetention === d
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {d}
          </button>
        ))}
        <button
          onClick={onArchiveNow}
          className="ml-auto rounded-md border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("main.archiveNow")}
        </button>
      </div>
      <ToggleRow
        label={t("main.settingsLarge")}
        desc={t("main.settingsLargeDesc")}
        on={settingsLarge}
        onChange={onSettingsLargeChange}
      />
      <ToggleRow
        label={t("main.browserPanel")}
        desc={t("main.browserPanelDesc")}
        on={browserPanel}
        onChange={onBrowserPanelChange}
      />

      {/* Уведомления, когда пользователь не в приложении */}
      <ToggleRow
        label={t("main.notifyDone")}
        desc={t("main.notifyDoneDesc")}
        on={notifyPrefs.enabled}
        onChange={(v) => onNotifyPrefsChange({ ...notifyPrefs, enabled: v })}
      />
      {notifyPrefs.enabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
          <span className="text-xs text-halo-muted">{t("main.notifySound")}:</span>
          {NOTIFY_SOUNDS.map((snd) => (
            <button
              key={snd.id}
              onClick={() => {
                onNotifyPrefsChange({ ...notifyPrefs, sound: snd.id });
                playSound(snd.id); // прослушка при выборе
              }}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                notifyPrefs.sound === snd.id
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(snd.labelKey as never)}
            </button>
          ))}
          {/* Своя мелодия: импорт файла, прослушка, удаление */}
          <button
            onClick={async () => {
              try {
                const src = await pickAudioFile();
                if (!src) return;
                const res = await soundImport(src); // "имя|расширение"
                const [name] = res.split("|");
                onNotifyPrefsChange({ ...notifyPrefs, sound: "custom", customName: name });
                void refreshCustomSound().then(() => playSound("custom"));
              } catch {
                // отмена/ошибка выбора — просто ничего не меняем
              }
            }}
            title={t("main.notifyCustomImport")}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              notifyPrefs.sound === "custom"
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            + {notifyPrefs.customName || t("main.notifyCustomImport")}
          </button>
          {notifyPrefs.customName && (
            <button
              onClick={async () => {
                await soundDelete();
                onNotifyPrefsChange({
                  ...notifyPrefs,
                  sound: "chime",
                  customName: undefined,
                });
              }}
              title={t("main.notifyCustomClear")}
              className="rounded-md px-1.5 py-1 text-xs text-halo-muted transition-colors hover:text-red-400"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Hard Limit: прерывание задачи при превышении лимитов расхода */}
      <HardLimitSection limits={limits} onChange={onLimitsChange} />

      {/* Экспорт/импорт всех настроек одним файлом */}
      <div className="rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("main.exportTitle")}</p>
        <p className="mt-0.5 text-xs text-halo-muted">{t("main.exportHint")}</p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={async () => {
              try {
                const path = await pickSaveFile("nocturn-settings.json");
                if (!path) return;
                const files = await settingsReadAll();
                await settingsExportWrite(
                  path,
                  JSON.stringify({ version: 1, files, local: collectLocal() }, null, 2),
                );
              } catch (e) {
                window.alert(String(e));
              }
            }}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("main.exportBtn")}
          </button>
          <button
            onClick={async () => {
              try {
                const path = await pickJsonFile();
                if (!path) return;
                if (!window.confirm(t("main.importConfirm"))) return;
                const data = await settingsImportRead(path);
                let n = 0;
                if (data.files && Object.keys(data.files).length > 0) {
                  n = await settingsWriteAll(data.files);
                }
                if (data.local) restoreLocal(data.local);
                window.alert(t("main.importDone", { n }));
                location.reload();
              } catch (e) {
                window.alert(String(e));
              }
            }}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
          >
            {t("main.importBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Раздел «MCP»: управление серверами внешних инструментов (M2-MCP) */
function McpSection() {
  const { t } = useLang();
  const [servers, setServers] = useState<McpServerCfg[]>([]);
  // Ref-зеркало актуального массива: next считаем из него, а не из снапшота
  // state — иначе два быстрых клика подряд перезапишут результат первого
  const serversRef = useRef<McpServerCfg[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * Разбор JSON-конфига в формате Claude Desktop / ZCode:
   * {"mcpServers": {"name": {command, args, env}}} или {"name": {…}}.
   * Неизвестные поля (type, timeout, protocolVersion…) игнорируются.
   */
  const parseImportText = (raw: string): McpServerCfg[] | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    let map: unknown = (parsed as Record<string, unknown>).mcpServers ?? parsed;
    if (typeof map !== "object" || map === null) return null;
    const out: McpServerCfg[] = [];
    for (const [srvName, rawCfg] of Object.entries(map as Record<string, unknown>)) {
      if (typeof rawCfg !== "object" || rawCfg === null) continue;
      const cfg = rawCfg as Record<string, unknown>;
      if (typeof cfg.command !== "string" || !cfg.command.trim()) continue;
      const env: Record<string, string> = {};
      if (typeof cfg.env === "object" && cfg.env !== null) {
        for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      out.push({
        name: srvName,
        command: cfg.command,
        args: Array.isArray(cfg.args)
          ? cfg.args.filter((a): a is string => typeof a === "string")
          : [],
        env,
        enabled: true,
      });
    }
    return out;
  };

  const doImport = async () => {
    const imported = parseImportText(importText);
    if (!imported || imported.length === 0) {
      setImportMsg({ ok: false, text: t("mcp.importFail") });
      return;
    }
    // Merge по имени: существующие обновляются (enabled сохраняется), новые добавляются
    const byName = new Map(serversRef.current.map((s) => [s.name, s]));
    for (const s of imported) {
      const existing = byName.get(s.name);
      byName.set(s.name, existing ? { ...s, enabled: existing.enabled } : s);
    }
    const next = [...byName.values()];
    await persist(next);
    setImportMsg({ ok: true, text: t("mcp.importOk", { n: imported.length }) });
    setImportText("");
  };

  // Загрузка конфига и статусов при открытии вкладки
  useEffect(() => {
    mcpListServers()
      .then((list) => {
        serversRef.current = list;
        setServers(list);
      })
      .catch(() => {});
    mcpStatus()
      .then(setStatuses)
      .catch(() => {});
  }, []);

  const statusOf = (name: string): McpServerStatus | undefined =>
    statuses.find((s) => s.name === name);

  const refreshStatuses = () => {
    mcpStatus()
      .then(setStatuses)
      .catch(() => {});
  };

  /** Сохранить конфиг и синхронизировать набор схем инструментов */
  const persist = async (next: McpServerCfg[]) => {
    serversRef.current = next;
    setServers(next);
    try {
      await mcpSaveServers(next);
      invalidateToolSchemas();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const addServer = async () => {
    const n = name.trim();
    const cmd = command.trim();
    if (!n || !cmd) return;
    const argList = args
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    await persist([
      ...serversRef.current,
      { name: n, command: cmd, args: argList, env: {}, enabled: true },
    ]);
    setName("");
    setCommand("");
    setArgs("");
  };

  const toggleEnabled = async (idx: number) => {
    const next = serversRef.current.map((s, i) =>
      i === idx ? { ...s, enabled: !s.enabled } : s,
    );
    await persist(next);
    // Выключили включённый сервер — отключаем соединение
    const srv = servers[idx];
    if (srv.enabled && statusOf(srv.name)?.connected) {
      await mcpDisconnect(srv.name).catch(() => {});
      refreshStatuses();
    }
  };

  const removeServer = async (idx: number) => {
    const srv = servers[idx];
    if (statusOf(srv.name)?.connected) {
      setBusy(srv.name);
      await mcpDisconnect(srv.name).catch(() => {});
      setBusy(null);
      refreshStatuses();
    }
    await persist(serversRef.current.filter((_, i) => i !== idx));
  };

  const connect = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await mcpConnect(name);
      refreshStatuses();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (name: string) => {
    setBusy(name);
    await mcpDisconnect(name).catch(() => {});
    setBusy(null);
    refreshStatuses();
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.mcp")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("mcp.desc")}
      </p>

      <div className="space-y-2">
        {servers.length === 0 && (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-xs leading-relaxed text-halo-muted">
            {t("mcp.empty")}
          </p>
        )}
        {servers.map((s, i) => {
          const st = statusOf(s.name);
          const connected = st?.connected ?? false;
          return (
            <div
              key={s.name}
              className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                {/* Статус-точка */}
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    connected
                      ? "bg-emerald-400"
                      : s.enabled
                        ? "bg-amber-400/70"
                        : "bg-halo-muted/40"
                  }`}
                  title={
                    connected
                      ? t("mcp.connected")
                      : s.enabled
                        ? t("mcp.disconnected")
                        : t("mcp.off")
                  }
                />
                <span className="min-w-0 truncate text-sm font-medium text-halo-text">
                  {s.name}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-halo-muted">
                  {s.command} {s.args.join(" ")}
                </code>
                <button
                  onClick={() => void toggleEnabled(i)}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    s.enabled
                      ? "border-emerald-400/40 text-emerald-400"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {s.enabled ? t("mcp.enabled") : t("mcp.off")}
                </button>
                {connected ? (
                  <button
                    onClick={() => void disconnect(s.name)}
                    disabled={busy === s.name}
                    className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text disabled:opacity-40"
                  >
                    {t("mcp.disconnect")}
                  </button>
                ) : (
                  <button
                    onClick={() => void connect(s.name)}
                    disabled={busy === s.name || !s.enabled}
                    className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === s.name ? "…" : t("mcp.connect")}
                  </button>
                )}
                <button
                  onClick={() => void removeServer(i)}
                  title={t("mcp.delete")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
              {/* Обнаруженные инструменты */}
              {st && st.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 pl-4">
                  {st.tools.map((tool) => (
                    <span
                      key={tool.name}
                      title={tool.description}
                      className="rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[10px] text-halo-muted"
                    >
                      mcp__{s.name}__{tool.name}
                    </span>
                  ))}
                  <span className="px-1 text-[10px] text-halo-muted/60">
                    {st.tools.length} {t("mcp.tools")}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-relaxed text-red-400">
          {error}
        </p>
      )}

      {/* Форма добавления */}
      <div className="mt-4 space-y-2 rounded-xl border border-halo-line p-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.name")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={t("mcp.command")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <input
          type="text"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder={t("mcp.args")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="flex justify-end">
          <button
            onClick={() => void addServer()}
            disabled={!name.trim() || !command.trim()}
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("mcp.add")}
          </button>
        </div>
      </div>

      {/* Импорт конфига в формате Claude Desktop / ZCode */}
      <div className="mt-3 rounded-xl border border-halo-line p-3">
        <button
          onClick={() => setImportOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 text-xs font-medium text-halo-muted transition-colors hover:text-halo-text"
        >
          <span className={`transition-transform ${importOpen ? "rotate-90" : ""}`}>›</span>
          {t("mcp.import")}
        </button>
        {importOpen && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] leading-relaxed text-halo-muted">
              {t("mcp.importHint")}
            </p>
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportMsg(null);
              }}
              rows={5}
              placeholder={t("mcp.importPh")}
              className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/50 focus:border-halo-accent/60"
            />
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[11px] ${importMsg?.ok ? "text-emerald-400" : "text-red-400"}`}
              >
                {importMsg?.text}
              </span>
              <button
                onClick={() => void doImport()}
                disabled={!importText.trim()}
                className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("mcp.importBtn")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Стилизованный дропдаун: нативный <select> рисует системный попап,
    который выбивается из тёмной темы — здесь свой список на div-ах */
function Dropdown({
  value,
  options,
  onSelect,
  className = "",
}: {
  value: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Гасим событие, чтобы оно не дошло до window-обработчика модалки
        // и не закрыло всё окно настроек
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-left text-xs text-halo-text outline-none transition-colors hover:border-halo-muted/50"
      >
        <span className="min-w-0 truncate">{current?.label ?? ""}</span>
        <span className={`shrink-0 text-[10px] text-halo-muted transition-transform ${open ? "rotate-180" : ""}`}>
          ▼
        </span>
      </button>
      {open && (
        <div className="anim-pop absolute right-0 z-30 mt-1 max-h-64 min-w-full overflow-y-auto rounded-lg border border-halo-line bg-halo-deep py-1 shadow-xl scroll-slim">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                onSelect(o.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ${
                o.value === value
                  ? "bg-halo-hover text-halo-text"
                  : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
              }`}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && (
                <span className="shrink-0 text-halo-accent">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Раздел «Горячие клавиши»: перебиндивание действий + свои хоткеи на slash-команды */
function ShortcutsSection({
  binds,
  onChange,
  custom,
  onCustomChange,
  availableCommands,
}: {
  binds: ShortcutBinds;
  onChange: (b: ShortcutBinds) => void;
  custom: CustomShortcut[];
  onCustomChange: (c: CustomShortcut[]) => void;
  availableCommands: { name: string; desc: string; argHint?: string }[];
}) {
  const { t } = useLang();
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // Форма своего хоткея
  const [addOpen, setAddOpen] = useState(false);
  const [cmdName, setCmdName] = useState("");
  const [cmdArg, setCmdArg] = useState("");
  const [customCombo, setCustomCombo] = useState("");

  // Запись комбинации: и для встроенных действий, и для нового хоткея.
  // recording === "@new" — пишем комбо для добавляемого хоткея.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const clash =
        SHORTCUT_ACTIONS.find((a) => a !== recording && binds[a] === combo) ??
        custom.find((c) => c.id !== recording && c.combo === combo);
      if (clash) {
        setConflict(combo);
        return;
      }
      if (recording === "@new") {
        setCustomCombo(combo);
      } else if ((SHORTCUT_ACTIONS as readonly string[]).includes(recording)) {
        onChange({ ...binds, [recording as ShortcutAction]: combo });
      } else {
        onCustomChange(
          custom.map((c) => (c.id === recording ? { ...c, combo } : c)),
        );
      }
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, binds, custom, onChange, onCustomChange]);

  const addCustom = () => {
    const name = cmdName.trim().replace(/^\//, "");
    if (!name || !customCombo) return;
    onCustomChange([
      ...custom,
      {
        id: `sc-${Date.now().toString(36)}`,
        combo: customCombo,
        command: cmdArg.trim() ? `/${name} ${cmdArg.trim()}` : `/${name}`,
      },
    ]);
    setCmdName("");
    setCmdArg("");
    setCustomCombo("");
    setAddOpen(false);
  };

  const comboButton = (target: string, current: string) => (
    <button
      onClick={() => {
        setRecording(recording === target ? null : target);
        setConflict(null);
      }}
      className={`shrink-0 rounded-md border px-3 py-1 font-mono text-xs transition-colors ${
        recording === target
          ? "animate-pulse border-halo-accent text-halo-accent"
          : current
            ? "border-halo-line text-halo-muted hover:border-halo-accent/50 hover:text-halo-text"
            : "border-dashed border-halo-line text-halo-muted/60 hover:text-halo-text"
      }`}
    >
      {recording === target ? t("sc.press") : current || t("sc.unbound")}
    </button>
  );

  const selectedCmd = availableCommands.find((c) => c.name === cmdName);

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.shortcuts")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("sc.desc")}
      </p>

      <div className="space-y-1.5">
        {SHORTCUT_ACTIONS.map((action) => {
          const current = binds[action] ?? "";
          return (
            <div
              key={action}
              className="flex items-center gap-3 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-halo-text">
                {t(SHORTCUT_LABEL_KEYS[action] as MsgKey)}
              </span>
              {comboButton(action, current)}
              {current && (
                <button
                  onClick={() => onChange({ ...binds, [action]: "" })}
                  title={t("sc.clear")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Свои хоткеи: комбо → slash-команда */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-halo-muted">{t("sc.custom")}</p>
          {!addOpen && (
            <button
              onClick={() => setAddOpen(true)}
              className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
            >
              + {t("sc.addCustom")}
            </button>
          )}
        </div>

        {custom.length === 0 && !addOpen && (
          <p className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-4 text-center text-xs text-halo-muted">
            {t("sc.customEmpty")}
          </p>
        )}
        <div className="space-y-1.5">
          {custom.map((cs) => {
            const cmd = availableCommands.find(
              (c) => c.name === cs.command.replace(/^\//, "").split(/\s+/)[0],
            );
            return (
              <div
                key={cs.id}
                className="flex items-center gap-3 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
              >
                <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[11px] text-halo-accent">
                  /{cs.command.replace(/^\//, "").split(/\s+/)[0]}
                </code>
                <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                  {cs.command.includes(" ") && cs.command.split(/\s+/).slice(1).join(" ")}
                  {cmd ? "" : ` — ${t("sc.unknownCmd")}`}
                </span>
                {comboButton(cs.id, cs.combo)}
                <button
                  onClick={() => onCustomChange(custom.filter((c) => c.id !== cs.id))}
                  title={t("sc.clear")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
            );
          })}
        </div>

        {addOpen && (
          <div className="mt-2 space-y-2.5 rounded-xl border border-halo-line p-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                  {t("sc.cmdLabel")}
                </label>
              <Dropdown
                value={cmdName}
                options={[
                  { value: "", label: "—" },
                  ...availableCommands.map((c) => ({
                    value: c.name,
                    label: `/${c.name} — ${c.desc}`,
                  })),
                ]}
                onSelect={setCmdName}
                className="w-full"
              />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                  {t("sc.argLabel")}
                </label>
                <input
                  type="text"
                  value={cmdArg}
                  onChange={(e) => setCmdArg(e.target.value)}
                  disabled={!selectedCmd?.argHint}
                  placeholder={selectedCmd?.argHint || t("sc.noArg")}
                  className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-40"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("sc.comboLabel")}
              </label>
              <div className="flex items-center gap-2">
                {comboButton("@new", customCombo)}
                <span className="text-[11px] text-halo-muted/70">{t("sc.comboHint")}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAddOpen(false)}
                className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("prompts.cancel")}
              </button>
              <button
                onClick={addCustom}
                disabled={!cmdName || !customCombo}
                className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("sc.addCustom")}
              </button>
            </div>
          </div>
        )}
      </div>

      {conflict && (
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
          {t("sc.conflict", { combo: conflict })}
        </p>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-halo-muted/60">
        {t("sc.hint")}
      </p>
    </div>
  );
}

/** Раздел «Скилы»: каталог встроенных скилов (вызов — «&» в поле ввода) */
function SkillsSection({
  extra = [],
}: {
  extra?: { id: string; name: string; desc?: { ru: string; en: string }; prompt: string }[];
}) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.skills")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("skills.desc")}
      </p>
      <div className="space-y-1.5">
        {BUILTIN_SKILLS.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
          >
            <button
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className="flex w-full items-center gap-2 text-left"
            >
              <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-halo-accent">
                &{s.id}
              </code>
              <span className="shrink-0 text-sm font-medium text-halo-text">
                {s.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {lang === "ru" ? s.desc?.ru ?? "" : s.desc?.en ?? ""}
              </span>
              <span
                className={`shrink-0 text-halo-muted transition-transform ${open === s.id ? "rotate-90" : ""}`}
              >
                ›
              </span>
            </button>
            {open === s.id && (
              <pre className="scroll-slim mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-halo-deep/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-halo-muted">
                {s.prompt}
              </pre>
            )}
          </div>
        ))}
        {extra.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border border-halo-line/60 bg-halo-surface/30 px-3 py-2"
          >
            <button
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className="flex w-full items-center gap-2 text-left"
            >
              <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-halo-muted">
                &{s.id}
              </code>
              <span className="shrink-0 text-sm font-medium text-halo-text">
                {s.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {lang === "ru" ? s.desc?.ru ?? "" : s.desc?.en ?? ""}
              </span>
              <span className="shrink-0 text-[10px] text-halo-muted/50">
                {t("skills.fromPlugin")}
              </span>
            </button>
            {open === s.id && (
              <pre className="scroll-slim mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-halo-deep/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-halo-muted">
                {s.prompt}
              </pre>
            )}
          </div>
        ))}
      </div>
      {extra.length > 0 && (
        <p className="mt-2 text-[10px] leading-relaxed text-halo-muted/60">
          {t("skills.fromPluginHint")}
        </p>
      )}
    </div>
  );
}

/** Раздел «Хуки»: shell-команды на событиях агента */
const HOOK_EVENT_KEYS = {
  PreToolUse: "hook.event.PreToolUse",
  PostToolUse: "hook.event.PostToolUse",
  UserPromptSubmit: "hook.event.UserPromptSubmit",
  Stop: "hook.event.Stop",
  SessionStart: "hook.event.SessionStart",
} as const;

function HooksSection() {
  const { t } = useLang();
  const addPreset = async (
    preset:
      | "blockDelete"
      | "beepStop"
      | "blockShell"
      | "blockMcp"
      | "worklog"
      | "gitAdd",
  ) => {
    const presets = {
      // Запрет удаления файлов агентом
      blockDelete: {
        event: "PreToolUse",
        matcher: "fs_delete",
        command: 'echo {"decision":"block","reason":"Удаление файлов запрещено хуком"}',
      },
      // Звук по завершении ответа модели
      beepStop: {
        event: "Stop",
        matcher: "",
        command: "powershell -NoProfile -c [console]::beep(880,250)",
      },
      // Запрет shell-команд (агент без терминала)
      blockShell: {
        event: "PreToolUse",
        matcher: "shell_run",
        command: 'echo {"decision":"block","reason":"Выполнение shell-команд запрещено хуком"}',
      },
      // Запрет MCP-инструментов
      blockMcp: {
        event: "PreToolUse",
        matcher: "mcp__",
        command: 'echo {"decision":"block","reason":"MCP-инструменты отключены хуком"}',
      },
      // Журнал сессий: строка в worklog.txt на старте сессии
      worklog: {
        event: "SessionStart",
        matcher: "",
        command:
          "powershell -NoProfile -c \"Add-Content -Path '$env:USERPROFILE\\nocturn-worklog.txt' -Value (\\\"{0:yyyy-MM-dd HH:mm} session started\\\" -f (Get-Date))\"",
      },
      // Git: авто-индексация файла после правки агентом
      gitAdd: {
        event: "PostToolUse",
        matcher: "fs_write",
        command:
          "powershell -NoProfile -c \"$j=[Console]::In.ReadToEnd()|ConvertFrom-Json; if ($j.arguments.path) { git add $j.arguments.path }\"",
      },
    } as const;
    const p = presets[preset];
    await persist([
      ...hooksRef.current,
      {
        id: `hook-${Date.now().toString(36)}`,
        event: p.event,
        matcher: p.matcher,
        command: p.command,
        timeout: 15,
        enabled: true,
      },
    ]);
  };

  const eventLabel = (ev: string) =>
    t(HOOK_EVENT_KEYS[ev as keyof typeof HOOK_EVENT_KEYS] ?? "hook.event.Stop");
  const [hooks, setHooks] = useState<Hook[]>([]);
  // Ref-зеркало актуального массива: next считаем из него, а не из снапшота
  // state — иначе два быстрых клика подряд перезапишут результат первого
  const hooksRef = useRef<Hook[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Форма добавления
  const [event, setEvent] = useState<string>("PreToolUse");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(30);
  // Тест: id хука → исход
  const [testOut, setTestOut] = useState<Record<string, HookOutcome>>({});
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    hooksLoad()
      .then((f) => {
        hooksRef.current = f.hooks ?? [];
        setHooks(f.hooks ?? []);
      })
      .catch(() => {});
  }, []);

  const persist = async (next: Hook[]) => {
    hooksRef.current = next;
    setHooks(next);
    try {
      await hooksSave({ hooks: next });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const update = async (id: string, patch: Partial<Hook>) => {
    await persist(hooksRef.current.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  };

  const addHook = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    await persist([
      ...hooksRef.current,
      {
        id: `hook-${Date.now().toString(36)}`,
        event,
        matcher: matcher.trim(),
        command: cmd,
        timeout: Math.max(1, timeoutSec || 30),
        enabled: true,
      },
    ]);
    setCommand("");
    setMatcher("");
    setShowAdd(false);
  };

  const runTest = async (h: Hook) => {
    setTestBusy(h.id);
    try {
      const payload = ["PreToolUse", "PostToolUse"].includes(h.event)
        ? { event: h.event, tool: h.matcher || "fs_write", arguments: { path: "demo.txt" } }
        : { event: h.event };
      const out = await hooksTest(h, payload);
      setTestOut((prev) => ({ ...prev, [h.id]: out }));
    } catch (e) {
      setTestOut((prev) => ({
        ...prev,
        [h.id]: {
          id: h.id,
          ran: true,
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: String(e),
          blocked: false,
          reason: "",
          additionalContext: "",
        },
      }));
    } finally {
      setTestBusy(null);
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.hooks")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">{t("hook.desc")}</p>

      {/* Готовые пресеты */}
      {hooks.length === 0 && !showAdd && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-halo-line px-3 py-2.5">
          <span className="text-[11px] text-halo-muted">{t("hook.presets")}:</span>
          {(
            [
              ["blockDelete", "hook.preset.blockDelete"],
              ["blockShell", "hook.preset.blockShell"],
              ["blockMcp", "hook.preset.blockMcp"],
              ["beepStop", "hook.preset.beepStop"],
              ["worklog", "hook.preset.worklog"],
              ["gitAdd", "hook.preset.gitAdd"],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              onClick={() => void addPreset(id)}
              className="rounded-md border border-halo-line px-2 py-1 text-[11px] text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {hooks.length === 0 && !showAdd && (
          <div className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-6 text-center">
            <p className="text-xs text-halo-muted">{t("hook.empty")}</p>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-3 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
            >
              + {t("hook.new")}
            </button>
          </div>
        )}
        {hooks.map((h) => {
          const out = testOut[h.id];
          return (
            <div
              key={h.id}
              className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[10px] text-halo-accent">
                  {eventLabel(h.event)}
                </span>
                {h.matcher && (
                  <code className="shrink-0 font-mono text-[10px] text-halo-muted">
                    {h.matcher}
                  </code>
                )}
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-halo-muted">
                  {h.command}
                </code>
                <span className="shrink-0 text-[10px] text-halo-muted/60">
                  {h.timeout}s
                </span>
                <button
                  onClick={() => void update(h.id, { enabled: !h.enabled })}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    h.enabled
                      ? "border-emerald-400/40 text-emerald-400"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {h.enabled ? t("hook.on") : t("hook.off")}
                </button>
                <button
                  onClick={() => void runTest(h)}
                  disabled={testBusy === h.id}
                  title={t("hook.test")}
                  className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent disabled:opacity-40"
                >
                  {testBusy === h.id ? "…" : t("hook.test")}
                </button>
                <button
                  onClick={() => void persist(hooksRef.current.filter((x) => x.id !== h.id))}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
              {/* Редактирование команды inline */}
              <input
                type="text"
                value={h.command}
                onChange={(e) => void update(h.id, { command: e.target.value })}
                spellCheck={false}
                className="mt-2 w-full rounded-md border border-transparent bg-halo-surface px-2 py-1.5 font-mono text-xs text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
              {out && (
                <div
                  className={`mt-2 space-y-1 rounded-md px-2 py-1.5 font-mono text-[10px] leading-relaxed ${
                    out.blocked
                      ? "bg-red-400/10 text-red-400"
                      : "bg-emerald-400/10 text-emerald-400"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      {t("hook.exit")}: {out.exitCode ?? "—"}
                      {out.timedOut ? ` · ${t("hook.timeoutHit")}` : ""}
                      {out.blocked ? ` · ${t("hook.blockedLabel")}` : ""}
                    </span>
                    {/* Стрелочка назад: скрыть результат теста */}
                    <button
                      onClick={() =>
                        setTestOut((prev) => {
                          const next = { ...prev };
                          delete next[h.id];
                          return next;
                        })
                      }
                      title={t("hook.back")}
                      className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-halo-hover"
                    >
                      ←
                    </button>
                  </div>
                  {out.stdout && <pre className="whitespace-pre-wrap">{out.stdout}</pre>}
                  {out.stderr && <pre className="whitespace-pre-wrap">{out.stderr}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs leading-relaxed text-red-400">
          {error}
        </p>
      )}

      {/* Форма добавления */}
      {showAdd && (
        <div className="mt-4 space-y-3 rounded-xl border border-halo-line p-3">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("hook.eventLabel")}
              </label>
              <Dropdown
                value={event}
                options={HOOK_EVENTS.map((ev) => ({ value: ev, label: eventLabel(ev) }))}
                onSelect={setEvent}
                className="w-full"
              />
            </div>
            <div className="w-28">
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("hook.timeout")}
              </label>
              <input
                type="number"
                min={1}
                max={600}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 text-xs text-halo-text outline-none focus:border-halo-accent/60"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
              {t("hook.matcherLabel")}
            </label>
            <input
              type="text"
              value={matcher}
              onChange={(e) => setMatcher(e.target.value)}
              placeholder={t("hook.matcher")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-halo-muted/70">
              {t("hook.matcherHint")}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
              {t("hook.commandLabel")}
            </label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("hook.command")}
              spellCheck={false}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-halo-muted/70">{t("hook.hint")}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("prompts.cancel")}
            </button>
            <button
              onClick={() => void addHook()}
              disabled={!command.trim()}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("hook.add")}
            </button>
          </div>
        </div>
      )}
      {!showAdd && hooks.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowAdd(true)}
            className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
          >
            + {t("hook.new")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Раздел «Browser Use»: тумблеры и путь к браузеру */
function BrowserUseSection() {  const { t } = useLang();
  const [cfg, setCfg] = useState<BrowserConfig>({
    enabled: true,
    headless: true,
    executable: "",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    browserGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: BrowserConfig) => {
    setCfg(next);
    try {
      await browserSetConfig(next);
      invalidateToolSchemas();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.browser")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("bu.desc")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("bu.enabled")}
          on={cfg.enabled}
          onChange={(v) => void apply({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            <ToggleRow
              label={t("bu.headless")}
              on={cfg.headless}
              onChange={(v) => void apply({ ...cfg, headless: v })}
            />
            <div className="rounded-lg px-2.5 py-2.5">
              <p className="text-xs text-halo-muted">{t("bu.headlessDesc")}</p>
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("bu.executable")}
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cfg.executable}
                  onChange={(e) => setCfg({ ...cfg, executable: e.target.value })}
                  placeholder={t("bu.executablePh")}
                  className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
                <button
                  onClick={() => void apply(cfg)}
                  className="shrink-0 rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
                >
                  {saved ? "✓" : t("bu.save")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-halo-muted/70">
        {t("bu.note")}
      </p>
    </div>
  );
}

/** Раздел «Генерация изображений»: опциональный инструмент агента (BYOK) */
function ImageGenSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<ImageGenConfig>({
    enabled: false,
    base_url: "",
    api_key: "",
    model: "",
    size: "",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    imageGenGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: ImageGenConfig) => {
    setCfg(next);
    try {
      await imageGenSetConfig(next);
      invalidateToolSchemas(); // инструмент появляется/исчезает у модели сразу
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.imagegen")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("ig.desc")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("ig.enabled")}
          on={cfg.enabled}
          onChange={(v) => void apply({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.baseUrl")}
              </span>
              <input
                type="text"
                value={cfg.base_url}
                onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                API key
              </span>
              <input
                type="password"
                value={cfg.api_key}
                onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.model")}
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cfg.model}
                  onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
                  placeholder="dall-e-3 / flux-… / gemini-2.5-flash-image"
                  className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
                <button
                  onClick={() => void apply(cfg)}
                  className="shrink-0 rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
                >
                  {saved ? "✓" : t("bu.save")}
                </button>
              </div>
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.size")}
              </span>
              <input
                type="text"
                value={cfg.size}
                onChange={(e) => setCfg({ ...cfg, size: e.target.value })}
                placeholder="1024x1024"
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-halo-muted/70">
        {t("ig.note")}
      </p>
    </div>
  );
}

/** Раздел «Computer Use»: скриншоты экрана + мышь/клавиатура */
function ComputerUseSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<ComputerConfig>({ enabled: true });

  useEffect(() => {
    computerGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: ComputerConfig) => {
    setCfg(next);
    try {
      await computerSetConfig(next);
      invalidateToolSchemas();
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.computer")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("cu.desc")}
      </p>

      <ToggleRow
        label={t("cu.enabled")}
        on={cfg.enabled}
        onChange={(v) => void apply({ ...cfg, enabled: v })}
      />

      <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300/90">
        ⚠ {t("cu.note")}
      </p>
    </div>
  );
}

/** Раздел «Документация»: что такое HaloUI и как пользоваться основными блоками */
/** Раздел «Сеть»: прокси, исключения, свой корневой сертификат.
    Самодостаточный: сам читает и пишет network.json (нужен перезапуск). */
function NetworkSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<NetworkConfig>({
    proxy: "",
    no_proxy: "",
    ca_path: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [savedField, setSavedField] = useState<string | null>(null);
  useEffect(() => {
    void networkGetConfig()
      .then(setCfg)
      .finally(() => setLoaded(true));
  }, []);
  const saveField = async (key: keyof NetworkConfig) => {
    try {
      await networkSetConfig(cfg);
      setSavedField(key);
      window.setTimeout(() => setSavedField(null), 2500);
    } catch (e) {
      setSavedField(null);
      window.alert(String(e));
    }
  };
  if (!loaded) return null;
  const placeholders: Record<keyof NetworkConfig, string> = {
    proxy: t("network.proxyPh"),
    no_proxy: t("network.noProxyPh"),
    ca_path: t("network.caPh"),
  };
  const row = (
    titleKey: MsgKey,
    hintKey: MsgKey,
    key: keyof NetworkConfig,
  ) => (
    <div className="rounded-xl border border-halo-line bg-halo-surface/30 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-halo-text">{t(titleKey)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t(hintKey)}
          </p>
          <input
            type="text"
            value={cfg[key]}
            onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
            placeholder={placeholders[key]}
            className="mt-2 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/50 focus:border-halo-accent/60"
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            onClick={() => saveField(key)}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
          >
            {t("network.save")}
          </button>
          {savedField === key && (
            <span className="text-[10px] text-emerald-400">
              {t("network.saved")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.network")}
      </h3>
      <div className="space-y-2.5">
        {row("network.proxyTitle", "network.proxyHint", "proxy")}
        {row("network.noProxyTitle", "network.noProxyHint", "no_proxy")}
        {row("network.caTitle", "network.caHint", "ca_path")}
      </div>
    </div>
  );
}

function DocsSection() {
  const { t } = useLang();
  const blocks: { title: MsgKey; body: MsgKey }[] = [
    { title: "docs.chat.title", body: "docs.chat.body" },
    { title: "docs.agent.title", body: "docs.agent.body" },
    { title: "docs.terminal.title", body: "docs.terminal.body" },
    { title: "docs.notes.title", body: "docs.notes.body" },
    { title: "docs.customize.title", body: "docs.customize.body" },
    { title: "docs.keys.title", body: "docs.keys.body" },
  ];
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.docs")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("docs.intro")}
      </p>
      <div className="space-y-2.5">
        {blocks.map((b) => (
          <div
            key={b.title}
            className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5"
          >
            <p className="text-xs font-medium text-halo-text">{t(b.title)}</p>
            <p className="mt-1 text-xs leading-relaxed text-halo-muted">
              {t(b.body)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Компактный сегмент-переключатель языка (RU / EN) */
function LangSwitch() {
  const lang = useLangState();
  const setLang = useLangSetter();
  const langs = [
    { id: "ru", label: "Русский" },
    { id: "en", label: "English" },
    { id: "zh", label: "中文" },
    { id: "ja", label: "日本語" },
  ] as const;
  return (
    <div className="flex flex-wrap rounded-lg border border-halo-line p-0.5">
      {langs.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => setLang(id)}
          className={`rounded-md px-2 py-1 text-xs transition-all duration-150 ${
            lang === id
              ? "bg-halo-accent/15 font-medium text-halo-accent"
              : "text-halo-muted hover:text-halo-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Row({ 
  label,
  desc,
  value,
  extra,
}: {
  label: string;
  desc?: string;
  value: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-2.5 text-sm">
      <span className="min-w-0">
        <span className="text-halo-text">{label}</span>
        {desc && (
          <span className="mt-0.5 block text-xs leading-relaxed text-halo-muted">
            {desc}
          </span>
        )}
      </span>
      {extra ?? <span className="text-halo-muted">{value}</span>}
    </div>
  );
}

export function ToggleRow({
  label,
  desc,
  disabled,
  defaultOn,
  on,
  onChange,
}: {
  label: string;
  /** Пояснение под названием строки (мелким приглушённым шрифтом) */
  desc?: string;
  disabled?: boolean;
  defaultOn?: boolean;
  /** Контролируемый режим: значение извне */
  on?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const [inner, setInner] = useState(!!defaultOn);
  const value = on ?? inner;
  const toggle = () => {
    if (disabled) return;
    if (onChange) onChange(!value);
    else setInner((v) => !v);
  };
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-2.5 text-sm">
      <span className="min-w-0">
        <span className={disabled ? "text-halo-muted" : "text-halo-text"}>
          {label}
        </span>
        {desc && (
          <span className="mt-0.5 block text-xs leading-relaxed text-halo-muted">
            {desc}
          </span>
        )}
      </span>
      <button
        onClick={toggle}
        disabled={disabled}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          value ? "bg-halo-accent" : "bg-halo-line"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
            value ? "left-4.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** Раздел «Память»: долгосрочный контекст проектов */
function MemorySection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.memory")}
      </h3>
      <div className="flex items-center justify-between rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3.5">
        <div className="min-w-0 pr-4">
          <p className="text-sm font-medium text-halo-text">{t("memory.toggle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-halo-muted">
            {t("memory.desc")}
          </p>
        </div>
        <button
          onClick={() => onChange(!enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              enabled ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3">
        <p className="text-xs font-medium text-halo-text">{t("memory.howTitle")}</p>
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-halo-muted">
          <li>· {t("memory.how1")}</li>
          <li>· {t("memory.how2")}</li>
          <li>· {t("memory.how3")}</li>
        </ul>
      </div>
      <p className="mt-3 text-xs text-halo-muted/70">{t("memory.note")}</p>
    </div>
  );
}

/** Названия шеллов консоли: не переводятся */
const SHELL_LABELS: Record<"powershell" | "cmd" | "gitbash", string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  gitbash: "Git Bash",
};

function ThemeSection({
  theme,
  glass,
  appearance,
  onAppearanceChange,
  termShell,
  onTermShellChange,
  themeProfiles,
  onThemeProfilesChange,
  onApplyThemeProfile,
  onThemeChange,
  onGlassChange,
  chatMark,
  onChatMarkChange,
  msgGlass,
  onMsgGlassChange,
}: {
  theme: Theme;
  glass: boolean;
  appearance: Appearance;
  onAppearanceChange: (a: Appearance) => void;
  termShell: string;
  onTermShellChange: (v: string) => void;
  /** Профили внешнего вида: лента чипов + сохранение текущего */
  themeProfiles: ThemeProfile[];
  onThemeProfilesChange: (list: ThemeProfile[]) => void;
  onApplyThemeProfile: (p: ThemeProfile) => void;
  onThemeChange: (t: Theme) => void;
  onGlassChange: (v: boolean) => void;
  chatMark: boolean;
  onChatMarkChange: (v: boolean) => void;
  msgGlass: boolean;
  onMsgGlassChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  // Инлайн-ввод имени нового профиля (окно prompt недоступно в sandbox)
  const [profileSaveOpen, setProfileSaveOpen] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  // Стандартное приветствие по времени суток — подсказка в поле «своё
  // приветствие» (период считается так же, как в ChatArea, src/time.ts)
  const p = dayPeriod();
  const defaultGreetingKey =
    p === "morning"
      ? "chat.greetingMorning"
      : p === "afternoon"
        ? "chat.greetingAfternoon"
        : p === "evening"
          ? "chat.greetingEvening"
          : "chat.greetingNight";
  const darkStyles: { id: Appearance["style"]; key: string }[] = [
    { id: "claude", key: "themes.styleClaude" },
    { id: "midnight", key: "themes.styleMidnight" },
    { id: "sepia", key: "themes.styleSepia" },
    { id: "abyss", key: "themes.styleAbyss" },
    { id: "storm", key: "themes.styleStorm" },
    { id: "dusk", key: "themes.styleDusk" },
    { id: "forest", key: "themes.styleForest" },
    { id: "rosewood", key: "themes.styleRosewood" },
  ];
  // Активный профиль: theme и appearance полностью совпадают с текущими
  const activeProfileId =
    themeProfiles.find(
      (pr) =>
        pr.theme === theme &&
        JSON.stringify(pr.appearance) === JSON.stringify(appearance),
    )?.id ?? null;
  // Сохранить текущие Theme + Appearance как новый профиль
  const saveThemeProfile = () => {
    const name = profileNameDraft.trim();
    if (!name) return;
    onThemeProfilesChange([
      ...themeProfiles,
      { id: `tp-${Date.now()}`, name, theme, appearance },
    ]);
    setProfileNameDraft("");
    setProfileSaveOpen(false);
  };

  return (
    // Компактная ширина по центру: контент не липнет к краям большого окна
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">{t("settings.themes")}</h3>

      {/* Профили внешнего вида: переключение пресета одним кликом */}
      <div className="mb-4 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-halo-text">{t("themes.profiles")}</p>
          <button
            onClick={() => {
              setProfileSaveOpen((v) => !v);
              setProfileNameDraft("");
            }}
            title={t("themes.profileSave")}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              profileSaveOpen
                ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                : "border-halo-line text-halo-muted hover:text-halo-text"
            }`}
          >
            {t("themes.profileSave")}
          </button>
        </div>
        {profileSaveOpen && (
          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={profileNameDraft}
              onChange={(e) => setProfileNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveThemeProfile();
                if (e.key === "Escape") setProfileSaveOpen(false);
              }}
              placeholder={t("themes.profileNamePh")}
              className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <button
              onClick={saveThemeProfile}
              disabled={!profileNameDraft.trim()}
              title={t("themes.profileSave")}
              className="shrink-0 rounded-md border border-halo-line px-2 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:opacity-40"
            >
              ✓
            </button>
          </div>
        )}
        {themeProfiles.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {themeProfiles.map((pr) => (
              <span key={pr.id} className="relative inline-flex items-center">
                <button
                  onClick={() => onApplyThemeProfile(pr)}
                  title={t("themes.profileApply")}
                  className={`rounded-md border py-1 pl-2.5 pr-6 text-xs transition-colors ${
                    activeProfileId === pr.id
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {pr.name}
                </button>
                <button
                  onClick={() =>
                    onThemeProfilesChange(themeProfiles.filter((x) => x.id !== pr.id))
                  }
                  title={t("themes.profileDelete")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-0.5 text-[10px] leading-none text-halo-muted/70 transition-colors hover:text-red-400"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Светлая/тёмная: компактные карточки в один ряд */}
      <div className="grid grid-cols-2 gap-3">
        <ThemeCard
          name={t("themes.dark")}
          selected={theme === "dark"}
          onSelect={() => onThemeChange("dark")}
          bg="#262624"
          panel="#1f1e1d"
          text="#e8e6dc"
        />
        <ThemeCard
          name={t("themes.light")}
          selected={theme === "light"}
          onSelect={() => onThemeChange("light")}
          bg="#faf9f5"
          panel="#f2efe9"
          text="#262524"
        />
      </div>

      {/* Стиль тёмной темы: выпадающий список с живым превью выбранного */}
      <div className="mb-2 mt-4 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-halo-muted">{t("themes.style")}</p>
        <div className="flex items-center gap-2">
          {(() => {
            const preview = appearanceTitleStyle(appearance.style, "dark");
            return (
              <span
                className="flex h-6 w-10 items-center justify-center overflow-hidden rounded-md border border-halo-line"
                style={{ background: preview.bg }}
                aria-hidden
              >
                <span className="text-[22px] leading-none" style={{ color: preview.text, opacity: 0.6 }}>
                  <StylePattern id={appearance.style} />
                </span>
              </span>
            );
          })()}
          <Dropdown
            value={appearance.style}
            options={darkStyles.map((s) => ({ value: s.id, label: t(s.key as MsgKey) }))}
            onSelect={(v) => onAppearanceChange({ ...appearance, style: v as Appearance["style"] })}
            className="w-44"
          />
        </div>
      </div>

      {/* Акцентный цвет */}
      <p className="mb-2 mt-4 text-xs font-medium text-halo-muted">
        {t("themes.accent")}
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-halo-line p-2.5">
        {ACCENT_PRESETS.map((p) => (
          <button
            key={p.hex}
            onClick={() => onAppearanceChange({ ...appearance, accent: p.hex })}
            title={p.hex}
            className={`size-7 rounded-full border-2 transition-transform hover:scale-110 ${
              appearance.accent.toLowerCase() === p.hex.toLowerCase()
                ? "border-halo-text"
                : "border-transparent"
            }`}
            style={{ background: p.hex }}
          />
        ))}
        <label
          className="ml-1 flex cursor-pointer items-center gap-2 rounded-full border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text"
          title={t("themes.accentCustom")}
        >
          <input
            type="color"
            value={appearance.accent}
            onChange={(e) => onAppearanceChange({ ...appearance, accent: e.target.value })}
            className="size-4 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          {t("themes.accentCustom")}
        </label>
      </div>

      {/* Масштаб интерфейса */}
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.scale")}</p>
          <p className="text-[10px] text-halo-muted/60">{t("themes.scaleHint")}</p>
        </div>
        <input
          type="range"
          min={90}
          max={115}
          step={1}
          value={appearance.scale}
          onChange={(e) => onAppearanceChange({ ...appearance, scale: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-12 shrink-0 text-right text-xs text-halo-muted">{appearance.scale}%</span>
      </div>

      {/* Знак приложения: новая широкая N или классическая */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.markStyle")}
          </p>
          <p className="text-[10px] leading-relaxed text-halo-muted/60">
            {t("themes.markStyleHint")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(["bold", "classic"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onAppearanceChange({ ...appearance, markStyle: v })}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                appearance.markStyle === v
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {t(v === "bold" ? "themes.markBold" : "themes.markClassic")}
            </button>
          ))}
        </div>
      </div>

      {/* Оболочка терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-nowrap text-sm text-halo-text">
            {t("themes.termShell")}
          </p>
          <p className="text-[10px] leading-relaxed text-halo-muted/60">
            {t("themes.termShellHint")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {(["auto", "powershell", "cmd", "gitbash"] as const).map((sh) => (
            <button
              key={sh}
              onClick={() => onTermShellChange(sh)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                termShell === sh
                  ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                  : "border-halo-line text-halo-muted hover:text-halo-text"
              }`}
            >
              {sh === "auto" ? t("themes.shellAuto") : SHELL_LABELS[sh]}
            </button>
          ))}
        </div>
      </div>

      {/* Шрифт терминала */}
      <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
        <div className="shrink-0">
          <p className="whitespace-nowrap text-sm text-halo-text">{t("themes.termFont")}</p>
          <p className="text-[10px] text-halo-muted/60">{t("themes.termFontHint")}</p>
        </div>
        <input
          type="range"
          min={10}
          max={16}
          step={0.5}
          value={appearance.termFont}
          onChange={(e) => onAppearanceChange({ ...appearance, termFont: Number(e.target.value) })}
          className="min-w-0 flex-1"
        />
        <span className="w-14 shrink-0 text-right font-mono text-xs text-halo-muted">
          {appearance.termFont}px
        </span>
      </div>

      {glass && (
        <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-halo-line px-3.5 py-3">
          <div className="shrink-0">
            <p className="whitespace-nowrap text-sm text-halo-text">
              {t("themes.glassBlur")}
            </p>
            <p className="text-[10px] text-halo-muted/60">{t("themes.glassBlurHint")}</p>
          </div>
          <input
            type="range"
            min={4}
            max={20}
            step={1}
            value={appearance.glassBlur}
            onChange={(e) =>
              onAppearanceChange({ ...appearance, glassBlur: Number(e.target.value) })
            }
            className="min-w-0 flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs text-halo-muted">
            {appearance.glassBlur}px
          </span>
        </div>
      )}

      {/* Отдельное стекло на сайдбаре */}
      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.sidebarGlass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.sidebarGlassDesc")}
          </p>
        </div>
        <button
          onClick={() =>
            onAppearanceChange({ ...appearance, sidebarGlass: !appearance.sidebarGlass })
          }
          title={t("themes.sidebarGlass")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            appearance.sidebarGlass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              appearance.sidebarGlass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.glass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.glassDesc")}
          </p>
        </div>
        <button
          onClick={() => onGlassChange(!glass)}
          title={glass ? t("themes.glassOff") : t("themes.glassOn")}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            glass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              glass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      {/* Своё приветствие: текст на пустом экране чата вместо стандартного */}
      <div className="mt-2.5 rounded-xl border border-halo-line px-3.5 py-3">
        <p className="text-sm text-halo-text">{t("settings.customGreeting")}</p>
        <p className="mt-0.5 text-xs text-halo-muted">
          {t("settings.customGreetingHint")}
        </p>
        <input
          type="text"
          value={appearance.customGreeting ?? ""}
          onChange={(e) =>
            onAppearanceChange({ ...appearance, customGreeting: e.target.value })
          }
          placeholder={t(defaultGreetingKey as MsgKey)}
          className="mt-2.5 w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.chatMark")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.chatMarkDesc")}
          </p>
        </div>
        <button
          onClick={() => onChatMarkChange(!chatMark)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            chatMark ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              chatMark ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-2.5 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div>
          <p className="text-sm text-halo-text">{t("themes.msgGlass")}</p>
          <p className="mt-0.5 text-xs text-halo-muted">
            {t("themes.msgGlassDesc")}
          </p>
        </div>
        <button
          onClick={() => onMsgGlassChange(!msgGlass)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            msgGlass ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              msgGlass ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <p className="mt-3 text-xs text-halo-muted/70">
        {t("themes.note")}
      </p>
    </div>
  );
}

function ThemeCard({
  name,
  selected,
  onSelect,
  bg,
  panel,
  text,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  bg: string;
  panel: string;
  text: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={`rounded-xl border p-2.5 text-left transition-colors ${
        selected
          ? "border-halo-accent"
          : "border-halo-line hover:border-halo-muted/50"
      }`}
    >
      {/* Мини-превью темы */}
      <div
        className="flex h-20 gap-1.5 rounded-lg p-1.5"
        style={{ background: bg }}
      >
        <div className="w-1/3 rounded" style={{ background: panel }} />
        <div className="flex-1 space-y-1.5">
          <div className="h-1.5 w-4/5 rounded" style={{ background: text, opacity: 0.75 }} />
          <div className="h-1.5 w-3/5 rounded" style={{ background: text, opacity: 0.35 }} />
          <div className="mt-2 h-4 w-2/5 rounded-md" style={{ background: "#d97757" }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-0.5">
        <span className="text-sm text-halo-text">{name}</span>
        {selected && (
          <span className="text-halo-accent">
            <CheckIcon />
          </span>
        )}
      </div>
    </button>
  );
}

/** Редактор allowlist (M5.2): команды, разрешённые «Всегда для задачи»,
    плюс глобальный просмотр разрешений всех задач */
function AgentSection({
  commands,
  sessionTitle,
  onChange,
  allowlists,
  onSessionChange,
}: {
  commands: string[];
  sessionTitle: string | null;
  onChange: (list: string[]) => void;
  allowlists: { id: string; title: string; commands: string[] }[];
  onSessionChange: (id: string, list: string[]) => void;
}) {
  const { t } = useLang();
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.agent")}
      </h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">
        {t("agent.allowlistDesc")}
      </p>
      {sessionTitle && (
        <p className="mb-3 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2 text-xs text-halo-muted">
          {t("agent.allowlistOf", { title: sessionTitle })}
        </p>
      )}

      <div className="space-y-2">
        {commands.length === 0 ? (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-xs leading-relaxed text-halo-muted">
            {t("agent.allowlistEmpty")}
          </p>
        ) : (
          commands.map((c, i) => (
            <div
              key={`${i}-${c}`}
              className="group flex items-start gap-2.5 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <code className="scroll-slim min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-halo-text">
                {c}
              </code>
              <button
                onClick={() => onChange(commands.filter((_, j) => j !== i))}
                title={t("prompts.delete")}
                className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </div>
          ))
        )}
      </div>

      {commands.length > 1 && (
        <button
          onClick={() => onChange([])}
          className="mt-3 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:border-red-400/50 hover:bg-red-400/10 hover:text-red-400"
        >
          {t("agent.allowlistClear")}
        </button>
      )}

      {/* Глобальный просмотр: разрешения всех задач */}
      <p className="mb-2 mt-5 text-xs font-medium text-halo-muted">
        {t("agent.allowlistAllTitle")}
      </p>
      {allowlists.length === 0 ? (
        <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-xs leading-relaxed text-halo-muted">
          {t("agent.allowlistAllEmpty")}
        </p>
      ) : (
        <div className="space-y-2.5">
          {allowlists.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-halo-text">
                  {entry.title}
                </span>
                <button
                  onClick={() => onSessionChange(entry.id, [])}
                  className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-red-400/50 hover:text-red-400"
                >
                  {t("agent.allowlistClear")}
                </button>
              </div>
              <div className="space-y-1.5">
                {entry.commands.map((c, i) => (
                  <div
                    key={`${i}-${c}`}
                    className="flex items-start gap-2 rounded-md bg-halo-surface/60 px-2.5 py-1.5"
                  >
                    <code className="scroll-slim min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-halo-muted">
                      {c}
                    </code>
                    <button
                      onClick={() =>
                        onSessionChange(
                          entry.id,
                          entry.commands.filter((_, j) => j !== i),
                        )
                      }
                      title={t("prompts.delete")}
                      className="shrink-0 rounded p-0.5 text-halo-muted/60 transition-colors hover:text-red-400"
                    >
                      <MiniTrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Библиотека системных промтов: свои роли для быстрых вызовов */function PromptsSection({
  library,
  onChangeLibrary,
}: {
  library: PromptPreset[];
  onChangeLibrary: (list: PromptPreset[]) => void;
}) {
  const { t } = useLang();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");

  const add = () => {
    if (!name.trim() || !text.trim()) return;
    onChangeLibrary([
      ...library,
      { id: crypto.randomUUID(), name: name.trim(), text: text.trim() },
    ]);
    setName("");
    setText("");
  };

  const startEdit = (p: PromptPreset) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditText(p.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const n = editName.trim();
    const t = editText.trim();
    if (!n || !t) return;
    onChangeLibrary(
      library.map((p) =>
        p.id === editingId ? { ...p, name: n, text: t } : p,
      ),
    );
    setEditingId(null);
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.prompts")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("prompts.desc")}
      </p>

      <div className="mb-4 space-y-2">
        {library.length === 0 && (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-center text-xs text-halo-muted">
            {t("prompts.empty")}
          </p>
        )}
        {library.map((p) =>
          editingId === p.id ? (
            <div
              key={p.id}
              className="space-y-2 rounded-lg border border-halo-accent/50 bg-halo-surface/50 p-2.5"
            >
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t("prompts.namePh")}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={6}
                className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm leading-relaxed text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={commitEdit}
                  disabled={!editName.trim() || !editText.trim()}
                  className="rounded-lg bg-halo-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("prompts.save")}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="rounded-lg border border-halo-line px-3 py-1.5 text-sm text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                >
                  {t("prompts.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div
              key={p.id}
              className="group flex items-start gap-2.5 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-halo-text">{p.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-halo-muted">
                  {p.text}
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-0.5">
                <button
                  onClick={() => startEdit(p)}
                  title={t("prompts.edit")}
                  className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
                >
                  <MiniPencilIcon />
                </button>
                <button
                  onClick={() =>
                    onChangeLibrary(library.filter((x) => x.id !== p.id))
                  }
                  title={t("prompts.deleteTitle")}
                  className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
            </div>
          ),
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-halo-line p-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("prompts.namePh")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={t("prompts.textPh")}
          className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2.5 text-sm leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="flex justify-end">
          <button
            onClick={add}
            disabled={!name.trim() || !text.trim()}
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("prompts.add")}
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniPencilIcon() {
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
    >
      <path d="M17 3a2.85 2.83 4 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

export function MiniTrashIcon() {
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
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function ApiSection({
  settings,
  status,
  profiles,
  activeProfileId,
  onAddProfile,
  onApplyProfile,
  onDeleteProfile,
  onEncryptionToggle,
  ollamaModels,
  onChange,
  onTest,
  onSave,
  onDetectOllama,
  onUseLocalModel,
}: {
  settings: ApiSettings;
  status: ApiStatus;
  profiles: ApiProfile[];
  activeProfileId: string;
  onAddProfile: (name: string) => void;
  onApplyProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onEncryptionToggle: (enable: boolean) => Promise<boolean>;
  ollamaModels: string[] | null;
  onChange: (s: ApiSettings) => void;
  onTest: () => void;
  onSave: () => Promise<void>;
  onDetectOllama: () => void;
  onUseLocalModel: (id: string) => void;
}) {
  const { t } = useLang();
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [profName, setProfName] = useState("");
  const [profSaved, setProfSaved] = useState(false);
  const [encBusy, setEncBusy] = useState(false);
  const [encError, setEncError] = useState(false);

  const addProfile = () => {
    onAddProfile(profName);
    setProfName("");
    setProfSaved(true);
    window.setTimeout(() => setProfSaved(false), 2000);
  };
  const lastTestedRef = useRef<string | null>(null);

  const canTest =
    settings.api_key.trim() !== "" && settings.base_url.trim() !== "";
  const testKey = `${settings.api_key.trim()}|${settings.base_url.trim()}`;
  const models: ModelInfo[] = status.models ?? [];
  const filtered = modelQuery.trim()
    ? models.filter((m) => m.id.toLowerCase().includes(modelQuery.toLowerCase()))
    : models;

  // Автопроверка: при открытии раздела — сразу, при смене ключа/URL — с задержкой
  useEffect(() => {
    if (!canTest) return;
    if (lastTestedRef.current === testKey) return;
    const delay = lastTestedRef.current === null ? 0 : 700;
    const t = window.setTimeout(() => {
      lastTestedRef.current = testKey;
      onTest();
    }, delay);
    return () => window.clearTimeout(t);
  }, [testKey, canTest, onTest]);

  const handleSave = async () => {
    await onSave();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">{t("settings.api")}</h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("api.desc")}
      </p>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-halo-muted">
          {t("api.key")}
        </span>
        <input
          type="password"
          value={settings.api_key}
          onChange={(e) => onChange({ ...settings, api_key: e.target.value })}
          placeholder={t("api.keyPh")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </label>

      {/* Провайдер: клик подставляет Base URL, остаётся вписать только ключ */}
      <div className="mb-4">
        <span className="mb-1.5 block text-xs font-medium text-halo-muted">
          {t("api.provider")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => {
            const active = settings.provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() =>
                  onChange({ ...settings, base_url: p.baseUrl, provider: p.id })
                }
                title={p.baseUrl}
                className={`rounded-full border px-2.5 py-1 text-xs transition-all duration-150 ${
                  active
                    ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                    : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
                }`}
              >
                {p.label}
                {p.kind === "anthropic" && (
                  <span className="ml-1 text-[9px] opacity-70">native</span>
                )}
              </button>
            );
          })}
          <button
            onClick={() =>
              onChange({ ...settings, provider: "custom" })
            }
            title={t("api.providerCustom")}
            className={`rounded-full border px-2.5 py-1 text-xs transition-all duration-150 ${
              settings.provider === "custom"
                ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
            }`}
          >
            {t("api.providerCustom")}
          </button>
        </div>
      </div>

      {/* Шифрование ключей: мастер-ключ в Credential Manager */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-halo-line px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <p className="text-sm text-halo-text">{t("api.encKeys")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t("api.encKeysDesc")}
          </p>
        </div>
        <button
          onClick={async () => {
            setEncBusy(true);
            const ok = await onEncryptionToggle(!settings.encrypt_keys);
            setEncBusy(false);
            if (!ok) setEncError(true);
            else setEncError(false);
          }}
          disabled={encBusy}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            settings.encrypt_keys ? "bg-halo-accent" : "bg-halo-line"
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
              settings.encrypt_keys ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      {encError && (
        <p className="mb-3 text-xs text-red-400">{t("api.encError")}</p>
      )}

      {/* Профили ключей: сохранить текущую связку и переключаться кликом */}
      <div className="mb-4 rounded-xl border border-halo-line p-3">
        <p className="text-sm font-medium text-halo-text">{t("api.profiles")}</p>
        <p className="mb-2 text-xs leading-relaxed text-halo-muted">
          {t("api.profilesSub")}
        </p>
        {profiles.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {profiles.map((p) => {
              const active = activeProfileId === p.id;
              return (
                <span
                  key={p.id}
                  className={`flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs transition-all duration-150 ${
                    active
                      ? "border-halo-accent bg-halo-accent/15 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:border-halo-muted/60 hover:text-halo-text"
                  }`}
                >
                  <button
                    onClick={() => onApplyProfile(p.id)}
                    title={`${p.base_url} · ${p.model || "?"}`}
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => onDeleteProfile(p.id)}
                    title={p.name}
                    className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-red-400/20 hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="mb-2 text-xs text-halo-muted/70">
            {t("api.profilesEmpty")}
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={profName}
            onChange={(e) => setProfName(e.target.value)}
            placeholder={t("api.profileName")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <button
            onClick={addProfile}
            disabled={!canTest}
            title={canTest ? undefined : t("api.key")}
            className="shrink-0 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {profSaved ? `✓ ${t("api.profileSaved")}` : t("api.profileAdd")}
          </button>
        </div>
      </div>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs font-medium text-halo-muted">
          {t("api.baseUrl")}
        </span>
        <input
          type="text"
          value={settings.base_url}
          onChange={(e) =>
            onChange({
              ...settings,
              base_url: e.target.value,
              provider: providerFromBaseUrl(e.target.value),
            })
          }
          placeholder="https://openrouter.ai/api/v1"
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
      </label>

      {/* Выбор модели: список после автопроверки, иначе ручной ввод */}
      {models.length > 0 && !manual ? (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-halo-muted">
              {t("api.found", { n: models.length })}
            </span>
            <button
              onClick={() => setManual(true)}
              className="text-xs text-halo-accent transition-colors hover:text-halo-accent-deep"
            >
              {t("api.manual")}
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-halo-line bg-halo-surface px-3 py-2">
            <span className="text-halo-muted">
              <MiniSearchIcon />
            </span>
            <input
              type="text"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={t("api.filterPh")}
              className="flex-1 bg-transparent text-sm text-halo-text outline-none placeholder:text-halo-muted/60"
            />
          </div>
          {/* Выбранная модель — всегда на виду */}
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-halo-accent/40 bg-halo-accent/10 px-3 py-2">
            <span className="text-halo-accent">
              <MiniCheckIcon />
            </span>
            <span className="text-xs text-halo-muted">{t("api.selected")}</span>
            <ProviderIcon modelId={settings.model} size={14} />
            <span className="truncate font-mono text-xs text-halo-text">
              {settings.model || t("api.selectedNone")}
            </span>
          </div>
          <div className="scroll-slim max-h-56 overflow-y-auto rounded-lg border border-halo-line bg-halo-surface/50">
            {filtered.slice(0, 120).map((m) => {
              const selected = m.id === settings.model;
              return (
                <button
                  key={m.id}
                  onClick={() => onChange({ ...settings, model: m.id })}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                  }`}
                >
                  {/* Логотип провайдера (буквенный фолбэк, если бренда нет) */}
                  <ProviderIcon modelId={m.id} size={18} />
                  <span className="truncate font-mono">{m.id}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {m.vision && (
                      <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[9px] font-medium text-sky-400">
                        vision
                      </span>
                    )}
                    {!m.vision && m.text && (
                      <span className="rounded bg-halo-muted/15 px-1.5 py-0.5 text-[9px] font-medium text-halo-muted">
                        text
                      </span>
                    )}
                    {m.id.endsWith(":free") ? (
                      <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                        free
                      </span>
                    ) : (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
                        paid
                      </span>
                    )}
                    {selected && <MiniCheckIcon />}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-center text-xs text-halo-muted">
                {t("common.nothingFound")}
              </p>
            )}
          </div>
        </div>
      ) : (
        <label className="mb-4 block">
          <span className="mb-1 flex items-center justify-between text-xs font-medium text-halo-muted">
            {t("api.model")}
            {models.length > 0 && (
              <button
                onClick={() => setManual(false)}
                className="text-halo-accent transition-colors hover:text-halo-accent-deep"
              >
                {t("api.fromList")}
              </button>
            )}
          </span>
          <input
            type="text"
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
            placeholder={t("api.modelManualPh")}
            className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        </label>
      )}

      {/* Локальные модели (Ollama) */}
      <div className="mb-4 rounded-xl border border-halo-line p-3">
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`size-2 rounded-full ${
              ollamaModels !== null
                ? "bg-emerald-400"
                : "bg-halo-muted/40"
            }`}
          />
          <span className="text-sm font-medium text-halo-text">
            {t("ollama.title")}
          </span>
          <span className="flex-1" />
          <button
            onClick={onDetectOllama}
            className="rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            {t("ollama.again")}
          </button>
        </div>
        {ollamaModels === null ? (
          <p className="text-xs leading-relaxed text-halo-muted">
            {t("ollama.missing", { url: "http://localhost:11434" })}
          </p>
        ) : ollamaModels.length === 0 ? (
          <p className="text-xs leading-relaxed text-halo-muted">
            {t("ollama.noModels")}
          </p>
        ) : (
          <div className="scroll-slim max-h-40 overflow-y-auto">
            {ollamaModels.map((id) => {
              const selected =
                settings.model === id &&
                settings.base_url.includes("localhost");
              return (
                <button
                  key={id}
                  onClick={() => onUseLocalModel(id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-halo-accent/15 text-halo-accent"
                      : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                  }`}
                >
                  <span className="truncate font-mono">{id}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">
                      {t("ollama.badge")}
                    </span>
                    {selected && <MiniCheckIcon />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Статус проверки */}
      {status.kind === "checking" && (
        <p className="mb-3 flex items-center gap-2 text-xs text-halo-muted">
          <span className="typing-dot size-1.5 rounded-full bg-halo-accent" />
          {t("api.checking")}
        </p>
      )}
      {status.kind === "ok" && (
        <p className="mb-3 flex items-center gap-2 text-xs text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          {status.message}
        </p>
      )}
      {status.kind === "error" && (
        <p className="mb-3 flex items-start gap-2 text-xs text-red-400">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-red-400" />
          {status.message}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            lastTestedRef.current = null;
            onTest();
          }}
          disabled={!canTest || status.kind === "checking"}
          className="rounded-lg border border-halo-line px-3.5 py-2 text-sm text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("api.refresh")}
        </button>
        <button
          onClick={handleSave}
          className="rounded-lg bg-halo-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
        >
          {saved ? t("api.saved") : t("api.save")}
        </button>
      </div>
    </div>
  );
}

function MiniCheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function MiniSearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Разворот окна настроек на весь экран */
function ExpandWinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M8 21H5a2 2 0 0 1-2-2v-3 M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function CollapseWinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3 M16 3v3a2 2 0 0 0 2 2h3 M8 21v-3a2 2 0 0 0-2-2H3 M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
