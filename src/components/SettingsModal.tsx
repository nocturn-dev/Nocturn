import { useEffect, useMemo, useRef, useState } from "react";
import { useDelayedUnmount, withViewTransition } from "../motion";
import { flushSync } from "react-dom";
import type { Session, Theme, UsageEvent } from "../types";
import { ReflectSection } from "./settings/ReflectSection";
import { WebSearchSection } from "./settings/WebSearchSection";
import { ProfileSection } from "./settings/ProfileSection";
import { RestSection, type GameId } from "./settings/RestSection";
import { SETTINGS_SEARCH_INDEX } from "./settings/searchIndex";
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
  onImportSessions: (sessions: Session[]) => void;
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
  /** Подсветка кода во время стрима (тумблер рядом с «Плавной печатью») */
  highlightLive: boolean;
  onHighlightLiveChange: (v: boolean) => void;
  /** Множитель скорости плавной печати (0.5 / 1 / 2) */
  printSpeed: number;
  onPrintSpeedChange: (v: number) => void;
  /** Hard-Mode: терминальный скин */
  hardMode: boolean;
  onHardModeChange: (v: boolean) => void;
  /** Git-автокоммит перед правками агента (opt-in) */
  gitAutocommit: boolean;
  onGitAutocommitChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  /** Вид ленты по умолчанию: normal | thinking | verbose */
  transcriptView: "normal" | "thinking" | "verbose";
  onTranscriptViewChange: (v: "normal" | "thinking" | "verbose") => void;
  askAutoContinue: boolean;
  onAskAutoContinueChange: (v: boolean) => void;
  autoArchive: boolean;
  onAutoArchiveChange: (v: boolean) => void;
  archiveRetention: number;
  onArchiveRetentionChange: (d: number) => void;
  onArchiveNow: () => void;
  onExportChats: () => void;
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
  /** Журнал отправок для «Обзора» (Reflect) */
  usageLog: UsageEvent[];
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
      { id: "profile", key: "settings.profile", icon: "users" },
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
      { id: "websearch", key: "settings.websearch", icon: "globe" },
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
      { id: "reflect", key: "settings.reflect", icon: "chart" },
    ],
  },
  {
    group: "nav.rest",
    items: [{ id: "rest", key: "settings.rest", icon: "gamepad" }],
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
  onImportSessions,
  sidebarSide,
  onSidebarSideChange,
  hideStarter,
  onHideStarterChange,
  scrollFollow,
  onScrollFollowChange,
  streamSmooth,
  highlightLive,
  hardMode,
  gitAutocommit,
  onGitAutocommitChange,
  onHardModeChange,
  printSpeed,
  showReasoning,
  transcriptView,
  askAutoContinue,
  autoArchive,
  archiveRetention,
  onStreamSmoothChange,
  onHighlightLiveChange,
  onPrintSpeedChange,
  onShowReasoningChange,
  onTranscriptViewChange,
  onAskAutoContinueChange,
  onAutoArchiveChange,
  onArchiveRetentionChange,
  onArchiveNow,
  onExportChats,
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
  usageLog,
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
  // Поиск по настройкам: запрос + область (везде / только кастомизация).
  // Непустой запрос заменяет навигацию списком результатов (клик — открыть
  // секцию). Матч по локализованным подписям — работает во всех языках
  // Активная мини-игра во вкладке «Отдых»: Esc закрывает игру, потом модалку
  const [restGame, setRestGame] = useState<GameId | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchScope, setSearchScope] = useState<"all" | "custom">("all");
  // Пункт, к которому надо проскроллиться после перехода в секцию (label)
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const contentPaneRef = useRef<HTMLDivElement>(null);
  const searchResults = useMemo(() => {
    const query = searchQ.trim().toLowerCase();
    if (query === "") return null;
    const out: { section: Section; label: string; sectionTitle: string }[] = [];
    const seen = new Set<string>();
    // Сами разделы — тоже результаты (по названию)
    for (const g of NAV) {
      for (const item of g.items) {
        if (item.id === null) continue;
        if (searchScope === "custom" && item.id !== "theme") continue;
        const title = t(item.key);
        if (title.toLowerCase().includes(query)) {
          const id = `s:${item.id}`;
          if (!seen.has(id)) {
            seen.add(id);
            out.push({ section: item.id, label: title, sectionTitle: t("settings.title") });
          }
        }
      }
    }
    // Строки настроек внутри секций
    for (const group of SETTINGS_SEARCH_INDEX) {
      if (searchScope === "custom" && group.section !== "theme") continue;
      const navItem = NAV.flatMap((x) => x.items).find((i) => i.id === group.section);
      if (!navItem) continue;
      const sectionTitle = t(navItem.key);
      for (const key of group.keys) {
        // Ключи индекса типизированы MsgKey: протухший ключ не собирается
        const label = t(key);
        if (label.toLowerCase().includes(query) && !seen.has(`${key}`)) {
          seen.add(`${key}`);
          out.push({ section: group.section, label, sectionTitle });
        }
      }
    }
    return out.slice(0, 40);
  }, [searchQ, searchScope, t]);
  // Плавный морф размера через View Transitions API: снапшоты старого/нового
  // состояния анимируются на композиторе — анимировать width/height напрямую
  // нельзя (reflow всего контента каждый кадр = дёрганье). Без VT (старый
  // WebKitGTK) и при reduce-motion — мгновенная смена размера
  const setExpandedSmooth = (next: boolean) => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => unknown;
    };
    if (!doc.startViewTransition || reduce) {
      setExpanded(next);
      return;
    }
    doc.startViewTransition(() => {
      flushSync(() => setExpanded(next));
    });
  };

  // Плавное закрытие: при open=false модалка доигрывает anim-pop-out и
  // только потом размонтируется (общий хук движения — src/motion.ts)
  const renderOpen = useDelayedUnmount(open, 170);
  const closing = !open && renderOpen;

  // Сброс на первый раздел при открытии — но программное открытие
  // (initialSection, например «Плагины» из сайдбара) имеет приоритет
  useEffect(() => {
    if (open) setSection(initialSection ?? "main");
  }, [open, initialSection]);

  // Скролл к найденному пункту: после рендера секции ищем в контенте
  // элемент с этим текстом (самый короткий совпавший), прокручиваем к нему
  // и подсвечиваем. Работает для обеих областей и внутри текущей секции
  useEffect(() => {
    if (!pendingItem) return;
    const pane = contentPaneRef.current;
    const label = pendingItem.trim().toLowerCase();
    const timer = window.setTimeout(() => {
      if (!pane) return;
      let best: HTMLElement | null = null;
      let bestLen = Number.MAX_SAFE_INTEGER;
      const els = pane.querySelectorAll("*");
      for (const el of Array.from(els) as HTMLElement[]) {
        if (el.children.length > 3) continue;
        const txt = el.textContent?.trim().toLowerCase() ?? "";
        if (txt.includes(label) && txt.length < bestLen) {
          best = el;
          bestLen = txt.length;
        }
      }
      if (best) {
        best.scrollIntoView({ block: "center", behavior: "smooth" });
        best.classList.add("search-hit");
        window.setTimeout(() => best.classList.remove("search-hit"), 1800);
      }
      setPendingItem(null);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [pendingItem]);

  // Закрытие по Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // D11: не гасим модалку, пока фокус в поле ввода — черновик длинного
        // текста (промт роли, заметка, форма автоматизации) терялся без спроса
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        // Сначала — мини-игра «Отдыха», потом сама модалка
        setRestGame((g) => {
          if (g !== null) return null;
          onClose();
          return g;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open && !renderOpen) return null;

  return (
    <div
      // S3: backdrop-blur на оверлее поверх glass-pane-контента давал вложенный
      // фильтр — на WKWebView известный источник фризов; затемнения достаточно
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 ${
        closing ? "anim-fade-out" : "anim-fade"
      }`}
      onClick={onClose}
    >
      <div
        className={`glass-pane settings-vt flex overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl ${
          closing ? "anim-pop-out" : "anim-pop"
        } ${
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
                onClick={() => setExpandedSmooth(!expanded)}
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
          {/* Поиск по настройкам: область «везде» / «только кастомизация» */}
          <div className="px-1 pb-2">
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder={t("settings.searchPh")}
              className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
            />
            <div className="mt-1.5 flex gap-1">
              {(
                [
                  ["all", "settings.searchAll"],
                  ["custom", "settings.searchCustom"],
                ] as const
              ).map(([id, key]) => (
                <button
                  key={id}
                  onClick={() => setSearchScope(id)}
                  className={`rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                    searchScope === id
                      ? "border-halo-accent/50 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
          {searchResults !== null ? (
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto pr-0.5">
              {searchResults.length === 0 && (
                <p className="px-2.5 py-3 text-xs text-halo-muted">{t("settings.searchEmpty")}</p>
              )}
              {searchResults.map((r, i) => (
                <button
                  key={`${r.section}-${i}`}
                  onClick={() => {
                    withViewTransition(() => goto(r.section));
                    setPendingItem(r.label);
                    setSearchQ("");
                  }}
                  className="mb-0.5 flex w-full flex-col rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-halo-hover"
                >
                  <span className="truncate text-xs text-halo-text">{r.label}</span>
                  <span className="truncate text-[10px] text-halo-muted/60">{r.sectionTitle}</span>
                </button>
              ))}
            </div>
          ) : (
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
          )}
        </div>

        {/* Содержимое раздела */}
        <div ref={contentPaneRef} className="scroll-slim flex-1 overflow-y-auto p-5">
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
          {section === "profile" && <ProfileSection />}
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
              highlightLive={highlightLive}
              onHighlightLiveChange={onHighlightLiveChange}
              printSpeed={printSpeed}
              hardMode={hardMode}
              gitAutocommit={gitAutocommit}
              onGitAutocommitChange={onGitAutocommitChange}
              onHardModeChange={onHardModeChange}
              onPrintSpeedChange={onPrintSpeedChange}
              showReasoning={showReasoning}
              onShowReasoningChange={onShowReasoningChange}
              transcriptView={transcriptView}
              onTranscriptViewChange={onTranscriptViewChange}
              askAutoContinue={askAutoContinue}
              onAskAutoContinueChange={onAskAutoContinueChange}
              autoArchive={autoArchive}
              onAutoArchiveChange={onAutoArchiveChange}
              archiveRetention={archiveRetention}
              onArchiveRetentionChange={onArchiveRetentionChange}
              onArchiveNow={onArchiveNow}
              onExportChats={onExportChats}
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
              onImportSessions={onImportSessions}
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
          {section === "reflect" && (
            <ReflectSection sessions={sessions} usage={usageLog} apiSettings={apiSettings} />
          )}
          {section === "network" && <NetworkSection />}
          {section === "rest" && (
            <RestSection game={restGame} onGameChange={setRestGame} />
          )}
          {section === "docs" && <DocsSection />}
          {section === "mcp" && <McpSection />}
          {section === "imagegen" && <ImageGenSection />}
          {section === "websearch" && <WebSearchSection />}
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
