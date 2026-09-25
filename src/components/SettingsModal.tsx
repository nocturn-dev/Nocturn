import { useEffect, useState } from "react";
import type { Session, Theme } from "../types";
import UsageSection from "./UsageSection";
import SubagentsSection from "./SubagentsSection";
import CommandsSection from "./CommandsSection";
import PluginsSection from "./PluginsSection";
import {
  type Plugin,
  type ApiSettings,
  type ApiProfile,
} from "../api";
import { useLang, type MsgKey } from "../locales";
import { MainSection } from "./settings/MainSection";
import { McpSection } from "./settings/McpSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { SkillsSection } from "./settings/SkillsSection";
import { HooksSection } from "./settings/HooksSection";
import { BrowserUseSection } from "./settings/BrowserUseSection";
import { ImageGenSection } from "./settings/ImageGenSection";
import { ComputerUseSection } from "./settings/ComputerUseSection";
import { NetworkSection } from "./settings/NetworkSection";
import { DocsSection } from "./settings/DocsSection";
import { MemorySection } from "./settings/MemorySection";
import { ThemeSection } from "./settings/ThemeSection";
import { AgentSection, PromptsSection } from "./settings/AgentSection";
import { ApiSection } from "./settings/ApiSection";
import { SectionIcon, ExpandWinIcon, CollapseWinIcon, XIcon } from "./settings/parts";
import type { Section, ApiStatus } from "./settings/types";
import type { Appearance } from "../appearance";
import type { ThemeProfile } from "../themeProfiles";
import type { NotifyPrefs } from "../notify";
import type { HardLimits } from "../limits";
import type { ShortcutBinds, CustomShortcut } from "../shortcuts";
import type { PromptPreset } from "../presets";
import type { SubagentsConfig } from "../subagents";
export type { Section } from "./settings/types";

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
      if (e.key === "Escape") {
        // D11: не гасим модалку, пока фокус в поле ввода — черновик длинного
        // текста (промт роли, заметка, форма автоматизации) терялся без спроса
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        onClose();
      }
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
                {navStack.length > 0
                  ? sectionTitle(navStack[navStack.length - 1] ?? section)
                  : t("settings.title")}
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
