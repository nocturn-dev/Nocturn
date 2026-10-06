import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Project, Session } from "../types";
import WindowControls from "./WindowControls";
import { pickFolder, pickAnyFile, listDir, gitStatus, checkpointList, checkpointRestore, checkpointDelete, checkpointFiles, type CheckpointMeta, type CheckpointFileState, type FileEntry, type NoteInfo } from "../api";
import { normalizePath, pathSep } from "../diff";
import { copyText } from "../clipboard";
import { ACCENT_PRESETS } from "../appearance";
import { useLang, type MsgKey, type Lang, type TFn } from "../locales";
import NocturnMark from "./NocturnMark";

interface SidebarProps {
  sessions: Session[];
  projects: Project[];
  activeProjectId: string | null;
  activeId: string | null;
  renamingId: string | null;
  /** Корневая папка проекта для файлового менеджера (M4.2) */
  projectRoot: string | null;
  /** Нормализованные пути файлов, изменённых агентом в активной задаче (M4.3) */
  modifiedFiles: Set<string>;
  /** Сторона сайдбара (эргономика) и ширина (drag-ресайз) */
  side: "left" | "right";
  width: number;
  onResizeStart: () => void;
  /** Двойной клик по хендлу — сброс ширины */
  onResizeReset: () => void;
  /** Кнопки окна в бренд-строке (когда сайдбар справа) */
  showWindowControls: boolean;
  /** Заметки (M-N1) */
  notes: NoteInfo[];
  activeNoteFile: string | null;
  onOpenNote: (file: string) => void;
  onNewNote: () => void;
  onNoteMenu: (file: string, x: number, y: number) => void;
  /** Добавить проект: имя + опциональный корень (папка/файл-варианты «+») */
  onAddProject: (name: string, root?: string) => void;
  onProjectMenu: (id: string, x: number, y: number) => void;
  onOpenGraph: () => void;
  /** Клик по бренду — свернуть сайдбар */
  onCollapse: () => void;
  /** Свёрнут: ширина 0 с плавной анимацией */
  collapsed: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onSessionMenu: (id: string, x: number, y: number) => void;
  /** Быстрые действия чата на ховере: удалить / архив / тег */
  onDeleteSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onTagSession: (id: string, tag?: string) => void;
  /** Закрепить/открепить чат (быстрая кнопка на строке; pinned — сверху) */
  onTogglePin: (id: string) => void;
  onRenameCommit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  onSelectProject: (id: string | null) => void;
  onProjectRootChange: (root: string | null) => void;
  /** Открыть настройки на разделе плагинов */
  onOpenPlugins: () => void;
  /** Открыть экран «Автоматизации» */
  onOpenAutomations: () => void;
}

const PROJECT_DOTS = ["bg-halo-accent", "bg-sky-400/80", "bg-emerald-400/80", "bg-amber-400/80"];

/** Обработчики строки задачи. Живут в стабильном боксе (см. Sidebar):
 *  колбэки из App приходят инлайн-стрелками, и memo(SessionRow) разбивался
 *  бы новой идентичностью пропсов на каждом рендере */
interface SessionRowHandlers {
  onSelect: (id: string) => void;
  onSessionMenu: (id: string, x: number, y: number) => void;
  onRenameCommit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  onTagSession: (id: string, tag?: string) => void;
  onTogglePin: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onDeleteSession: (id: string) => void;
  setTaggingId: (id: string | null) => void;
}

/** Строка задачи: общий рендер для обоих режимов списка; на ховере —
 *  быстрые действия: архив (или вернуть), тег, удалить.
 *  memo: во время стрима App перерисовывается на каждый флеш дельт
 *  (setSessions → новый массив), и немемоизированные строки перестраивались
 *  десятками на кадр. s у нетронутых сессий сохраняет ссылку (flushDeltas
 *  клонирует только целевую сессию), booleans — примитивы, бокс h стабилен */
const SessionRow = memo(function SessionRow({
  s,
  active,
  renaming,
  tagging,
  h,
  t,
  lang,
}: {
  s: Session;
  active: boolean;
  renaming: boolean;
  tagging: boolean;
  h: SessionRowHandlers;
  t: TFn;
  lang: Lang;
}) {
  return (
    <li className="group/row">
      {renaming ? (
        <RenameInput
          initial={s.title}
          onCommit={(value) => h.onRenameCommit(s.id, value)}
          onCancel={h.onRenameCancel}
        />
      ) : tagging ? (
        // FIX: тег вводится инлайн в строке списка (как переименование);
        // allowEmpty — пустой ввод снимает тег
        <RenameInput
          initial={s.tag ?? ""}
          placeholder={t("sidebar.tagPrompt")}
          allowEmpty
          onCommit={(value) => {
            h.onTagSession(s.id, value || undefined);
            h.setTaggingId(null);
          }}
          onCancel={() => h.setTaggingId(null)}
        />
      ) : (
        <button
          onClick={() => h.onSelect(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            h.onSessionMenu(s.id, e.clientX, e.clientY);
          }}
          title={s.tag ? `[${s.tag}] ${s.title}` : s.title}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm transition duration-150 ${
            active
              ? "bg-halo-hover-strong text-halo-text"
              : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
          }`}
        >
          {s.pinned && (
            <span className="shrink-0 text-halo-accent/80">
              <PinIcon />
            </span>
          )}
          {/* Ветка edit-and-resend: оригинал в списке рядом, возврат кликом */}
          {s.branchedFrom && (
            <span title={t("branch.badge")} className="shrink-0 text-halo-accent/80">
              ↳
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {/* Тег-метка чата */}
          {s.tag && (
            <span className="shrink-0 rounded border border-halo-line px-1 py-px text-[0.625rem] text-halo-muted">
              {s.tag}
            </span>
          )}
          <span className="shrink-0 text-[0.6875rem] tabular-nums text-halo-muted/50 group-hover/row:hidden">
            {relTime(s.createdAt, lang)}
          </span>
          {/* Быстрые действия — только на ховере. Закрепление — первое:
              pinned-строки всплывают наверх списка (и в проектах, и в задачах) */}
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                h.onTogglePin(s.id);
              }}
              title={s.pinned ? t("menu.unpin") : t("menu.pin")}
              className={`rounded p-0.5 transition-colors hover:text-halo-text ${
                s.pinned
                  ? "text-halo-accent"
                  : "text-halo-muted opacity-0 group-hover/row:opacity-100"
              }`}
            >
              <PinIcon />
            </span>
            {s.archived ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  h.onArchiveSession(s.id, false);
                }}
                title={t("sidebar.unarchive")}
                className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
              >
                <ArchiveIcon />
              </span>
            ) : (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  h.onArchiveSession(s.id, true);
                }}
                title={t("sidebar.archive")}
                className="rounded p-0.5 text-halo-muted opacity-0 transition-colors hover:text-halo-text group-hover/row:opacity-100"
              >
                <ArchiveIcon />
              </span>
            )}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                // FIX: было window.prompt — в Tauri WebView возвращал null
                // (недоступен), тег молча не ставился
                h.setTaggingId(s.id);
              }}
              title={t("sidebar.tag")}
              className={`rounded p-0.5 transition-colors hover:text-halo-text ${
                s.tag ? "text-halo-accent/80" : "text-halo-muted opacity-0 group-hover/row:opacity-100"
              }`}
            >
              <TagIcon />
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                h.onDeleteSession(s.id);
              }}
              title={t("menu.delete")}
              className="rounded p-0.5 text-halo-muted opacity-0 transition-colors hover:text-red-400 group-hover/row:opacity-100"
            >
              <XSmallIcon />
            </span>
          </span>
        </button>
      )}
    </li>
  );
});

export default function Sidebar({
  sessions,
  projects,
  activeProjectId,
  activeId,
  renamingId,
  projectRoot,
  modifiedFiles,
  side,
  width,
  onResizeStart,
  onResizeReset,
  showWindowControls,
  onCollapse,
  collapsed,
  notes,
  activeNoteFile,
  onOpenNote,
  onNewNote,
  onNoteMenu,
  onAddProject,
  onProjectMenu,
  onOpenGraph,
  onNewChat,
  onSelect,
  onOpenSettings,
  onOpenSearch,
  onSessionMenu,
  onDeleteSession,
  onArchiveSession,
  onTagSession,
  onTogglePin,
  onRenameCommit,
  onRenameCancel,
  onSelectProject,
  onProjectRootChange,
  onOpenPlugins,
  onOpenAutomations,
}: SidebarProps) {
  const { t, lang } = useLang();
  const [filesOpen, setFilesOpen] = useState(false);
  const [cpOpen, setCpOpen] = useState(false);
  // Цвет заголовков секций: "" — как в теме, иначе hex (6 пресетов тем + свой)
  const [headerColor, setHeaderColor] = useState(
    () => localStorage.getItem("haloui-header-color") ?? "",
  );
  const changeHeaderColor = (hex: string) => {
    setHeaderColor(hex);
    localStorage.setItem("haloui-header-color", hex);
  };
  const [addingProject, setAddingProject] = useState(false);
  // FIX: инлайн-ввод тега вместо window.prompt — в Tauri WebView prompt
  // недоступен, и быстрая расстановка тегов молча не работала
  const [taggingId, setTaggingId] = useState<string | null>(null);
  // Группировка списка задач: плоский / по проектам (запоминается).
  // Дефолт — по проектам (ZCode-вид: проект → его диалоги), 29.09
  const [groupBy, setGroupBy] = useState<"flat" | "project">(() =>
    localStorage.getItem("haloui-sidebar-group") === "flat" ? "flat" : "project",
  );
  // Меню «+»: проект / файл / папка
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  /** Базовое имя пути: C:\HaloUI → «HaloUI», C:\proj\app.ts → «app.ts» */
  const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  /** Родительский каталог файла (корень проекта, открытого из файла) */
  const parentDir = (p: string) => {
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i > 0 ? p.slice(0, i) : p;
  };
  /** «+» → Папка: проект с корнем в выбранной папке, имя = имя папки */
  const addFromPicker = async (kind: "folder" | "file") => {
    if (kind === "folder") {
      const root = await pickFolder();
      if (root) onAddProject(baseName(root), root);
      return;
    }
    const file = await pickAnyFile();
    if (file) onAddProject(baseName(file), parentDir(file));
  };
  const changeGroupBy = (v: "flat" | "project") => {
    setGroupBy(v);
    localStorage.setItem("haloui-sidebar-group", v);
  };
  // Архив: тумблер «обычные / архивированные» чаты (не запоминается)
  const [showArchived, setShowArchived] = useState(false);
  // Секция проектов свёрнута (режим «Проекты», кнопка-стрелка у пилюль)
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => localStorage.getItem("haloui-sidebar-projects") === "1",
  );
  const toggleProjectsCollapsed = () => {
    setProjectsCollapsed((v) => {
      localStorage.setItem("haloui-sidebar-projects", v ? "0" : "1");
      return !v;
    });
  };
  // Раскрытые группы «Показать ещё»
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  // Фильтр/сортировка/группировка — useMemo: без него это выполнялось
  // на каждый рендер App (т.е. на каждый токен стрима)
  const visible = useMemo(
    () =>
      (activeProjectId
        ? sessions.filter((s) => s.projectId === activeProjectId)
        : sessions
      ).filter((s) => !!s.archived === showArchived),
    [sessions, activeProjectId, showArchived],
  );
  // Закреплённые задачи всегда сверху
  const sorted = useMemo(
    () => [...visible].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
    [visible],
  );
  // Группы для режима «по проектам»: все проекты в порядке списка
  // (включая пустые), в конце — задачи без проекта
  const projectGroups: { project: Project | null; items: Session[] }[] =
    useMemo(() => {
      const groups: { project: Project | null; items: Session[] }[] = [];
      for (const p of projects) {
        groups.push({ project: p, items: sorted.filter((s) => s.projectId === p.id) });
      }
      const rest = sorted.filter(
        (s) => !s.projectId || !projects.some((p) => p.id === s.projectId),
      );
      if (rest.length > 0) groups.push({ project: null, items: rest });
      return groups;
    }, [sorted, projects]);
  // Стабильный бокс обработчиков строки: identity не меняется между
  // рендерами (поля обновляются эффектом), иначе memo(SessionRow) разбивался
  // бы инлайн-стрелками App. Обработчикам свежесть критична (замыкания над
  // стейтом App) — эффект без deps обновляет поля после каждого рендера.
  // Инициализация через useRef({...}), а не записью в ref в теле рендера —
  // запись в ref во время рендера вне модели React Compiler (аудит А4-5)
  const rowHandlersRef = useRef<SessionRowHandlers>({
    onSelect,
    onSessionMenu,
    onRenameCommit,
    onRenameCancel,
    onTagSession,
    onTogglePin,
    onArchiveSession,
    onDeleteSession,
    // setTaggingId из useState стабилен — первым рендером и остаётся
    setTaggingId,
  });
  useEffect(() => {
    // Только колбэки из пропсов: setState-функции стабильны, их в refresh
    // не включаем (правило exhaustive-deps справедливо — смысла нет)
    Object.assign(rowHandlersRef.current, {
      onSelect,
      onSessionMenu,
      onRenameCommit,
      onRenameCancel,
      onTagSession,
      onTogglePin,
      onArchiveSession,
      onDeleteSession,
    });
  });

  const rowHandlers = rowHandlersRef.current;
  const sessionRow = (s: Session) => (
    <SessionRow
      key={s.id}
      s={s}
      active={s.id === activeId}
      renaming={s.id === renamingId}
      tagging={s.id === taggingId}
      h={rowHandlers}
      t={t}
      lang={lang}
    />
  );

  return (
    <aside
      className="relative h-full shrink-0 overflow-hidden bg-halo-deep transition-[width,opacity] duration-200 ease-out"
      style={{ width: collapsed ? 0 : width }}
    >
      {/* Фиксированная ширина внутри: контент не переформатовывается
          при сужении, а аккуратно обрезается и гаснет */}
      <div
        className="relative flex h-full flex-col transition-opacity duration-150 ease-out"
        style={{ width, opacity: collapsed ? 0 : 1 }}
      >
      {/* Хендл ресайза на внутренней грани; двойной клик — сброс */}
      {!collapsed && (
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          onResizeStart();
        }}
        onDoubleClick={onResizeReset}
        title={t("sidebar.resizeHint")}
        className={`absolute top-0 z-[var(--halo-z-panel-raised)] h-full w-2.5 cursor-col-resize transition-colors hover:bg-halo-accent/40 ${
          side === "left" ? "-right-1" : "-left-1"
        }`}
      />
      )}
      {/* Бренд + drag-регион окна; контролы — когда сайдбар справа */}
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 px-5"
      >
        <button
          onClick={onCollapse}
          title={t("sidebar.collapse")}
          className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 text-halo-text transition-colors hover:bg-halo-hover"
        >
          <span className="text-halo-accent">
            <BrandMark />
          </span>
          <span className="text-[0.9375rem] font-semibold tracking-wide">Nocturn</span>
        </button>
        <span data-tauri-drag-region className="h-full flex-1" />
        {showWindowControls && <WindowControls />}
      </div>

      {/* Действия: новая задача и поиск (с биндами) + служебные разделы */}
      <div className="space-y-0.5 px-3">
        <button
          onClick={onNewChat}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-halo-text transition-colors hover:bg-halo-hover"
        >
          <span className="shrink-0 text-halo-muted transition-colors group-hover:text-halo-accent">
            <PlusIcon />
          </span>
          <span className="flex-1 text-left">{t("sidebar.newTask")}</span>
          <kbd className="text-[0.6875rem] tracking-wide text-halo-muted/60">
            Ctrl+N
          </kbd>
        </button>
        <button
          onClick={onOpenSearch}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-halo-text transition-colors hover:bg-halo-hover"
        >
          <span className="shrink-0 text-halo-muted transition-colors group-hover:text-halo-accent">
            <SearchIcon />
          </span>
          <span className="flex-1 text-left">{t("sidebar.search")}</span>
          <kbd className="text-[0.6875rem] tracking-wide text-halo-muted/60">
            Ctrl+K
          </kbd>
        </button>
        {/* Автоматизации: запланированные задачи агента */}
        <button
          onClick={onOpenAutomations}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-halo-text transition-colors hover:bg-halo-hover"
        >
          <span className="shrink-0 text-halo-muted transition-colors group-hover:text-halo-accent">
            <ZapIcon />
          </span>
          <span className="flex-1 text-left">{t("sidebar.automations")}</span>
        </button>
        <button
          onClick={onOpenPlugins}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-halo-text transition-colors hover:bg-halo-hover"
        >
          <span className="shrink-0 text-halo-muted transition-colors group-hover:text-halo-accent">
            <GridIcon />
          </span>
          <span className="flex-1 text-left">{t("sidebar.plugins")}</span>
        </button>
      </div>

      {/* Разделительная черта (как у «Настройки») — с воздухом с обеих сторон */}
      <div className="mx-4 mt-4 border-t border-halo-line" />

      <nav className="scroll-slim flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
        {/* Переключатель группировки + справа: архив и сворачивание проектов */}
        <div className="flex items-center gap-1 px-2 pt-4 pb-2">
          <button
            onClick={() => changeGroupBy("flat")}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              groupBy === "flat"
                ? "border-halo-line bg-halo-hover-strong text-halo-text"
                : "border-transparent text-halo-muted/70 hover:text-halo-text"
            }`}
          >
            <span className="text-[0.625rem] font-semibold">#</span>
            {t("sidebar.tasks")}
          </button>
          <button
            onClick={() => changeGroupBy("project")}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              groupBy === "project"
                ? "border-halo-line bg-halo-hover-strong text-halo-text"
                : "border-transparent text-halo-muted/70 hover:text-halo-text"
            }`}
          >
            <span className="text-halo-muted/70">
              <FolderIcon />
            </span>
            {t("sidebar.projects")}
          </button>
          <span className="flex-1" />
          {/* Свернуть/развернуть секцию проектов (только в режиме «Проекты») */}
          {groupBy === "project" && !showArchived && (
            <button
              onClick={toggleProjectsCollapsed}
              title={projectsCollapsed ? t("sidebar.showProjects") : t("sidebar.hideProjects")}
              className={`rounded p-1 transition-transform hover:text-halo-text ${
                projectsCollapsed ? "text-halo-muted/70 -rotate-90" : "text-halo-muted"
              }`}
            >
              <ChevronSmallIcon className="" />
            </button>
          )}
          {/* Архив: переключение «обычные / архивированные» */}
          <button
            onClick={() => setShowArchived((v) => !v)}
            title={t(showArchived ? "sidebar.backToChats" : "sidebar.showArchive")}
            className={`rounded p-1 transition-colors ${
              showArchived ? "text-halo-accent" : "text-halo-muted/70 hover:text-halo-text"
            }`}
          >
            <ArchiveIcon />
          </button>
        </div>
        {showArchived ? (
          sorted.length === 0 ? (
            <p className="px-2 py-2 text-xs text-halo-muted/70">
              {t("sidebar.archiveEmpty")}
            </p>
          ) : (
            <ul className="space-y-0.5">{sorted.map(sessionRow)}</ul>
          )
        ) : groupBy === "project" ? (
          <div className="space-y-3">
            {/* Секция проектов: ТОЛЬКО проекты со своими диалогами — сессии
                без проекта живут во вкладке «Задачи» (фидбек 29.09) */}
            {!projectsCollapsed && (
              <div>
                <div className="relative flex items-center gap-1 px-2 pb-1">
                  <HeaderLabel
                    textKey="sidebar.projects"
                    color={headerColor}
                    onPick={changeHeaderColor}
                  />
                  <button
                    onClick={() => setAddMenuOpen((v) => !v)}
                    title={t("projects.add")}
                    className="cursor-pointer rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
                  >
                    <PlusIcon />
                  </button>
                  {/* Меню добавления: проект / файл / папку (фидбек 29.09) */}
                  {addMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-[var(--halo-z-panel-top)]"
                        onClick={() => setAddMenuOpen(false)}
                      />
                      {/* Лестница z вместо raw z-50: raw завязывал меню в
                          ничью с ambient-front (50, позже в DOM) — сцена
                          рисовала частицы поверх меню (аудит A6-6) */}
                      <div className="absolute right-1 top-7 z-[var(--halo-z-panel-top)] w-44 rounded-lg border border-halo-line bg-halo-raised py-1 shadow-xl">
                        <button
                          onClick={() => {
                            setAddMenuOpen(false);
                            setAddingProject(true);
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-halo-text transition-colors hover:bg-halo-hover"
                        >
                          {t("projects.addProject")}
                        </button>
                        <button
                          onClick={() => {
                            setAddMenuOpen(false);
                            void addFromPicker("folder");
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-halo-text transition-colors hover:bg-halo-hover"
                        >
                          {t("projects.addFolder")}
                        </button>
                        <button
                          onClick={() => {
                            setAddMenuOpen(false);
                            void addFromPicker("file");
                          }}
                          className="w-full px-3 py-1.5 text-left text-xs text-halo-text transition-colors hover:bg-halo-hover"
                        >
                          {t("projects.addFile")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {addingProject && (
                  <div className="mb-2">
                    <RenameInput
                      initial=""
                      placeholder={t("projects.namePh")}
                      onCommit={(name) => {
                        if (name.trim()) onAddProject(name.trim());
                        setAddingProject(false);
                      }}
                      onCancel={() => setAddingProject(false)}
                    />
                  </div>
                )}
                {projects.length === 0 && !addingProject && (
                  <p className="px-2 pb-2 text-xs text-halo-muted/70">
                    {t("sidebar.projectsEmpty")}
                  </p>
                )}
                <div className="space-y-2.5">
                  {/* flatMap-сужение вместо filter+non-null assertions: в
                      колбэке map project гарантированно Project */}
                  {projectGroups
                    .flatMap(({ project, items }) =>
                      project ? [{ project, items }] : [],
                    )
                    .map(({ project, items }) => {
                    const key = project.id ?? "none";
                    const open = expandedGroups.has(key);
                    const shown = open ? items : items.slice(0, 5);
                    const selected = project.id === activeProjectId;
                    return (
                      <div key={key}>
                        <button
                          onClick={() => onSelectProject(selected ? null : project.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onProjectMenu(project.id, e.clientX, e.clientY);
                          }}
                          title={selected ? t("sidebar.showAll") : t("sidebar.showProject", { name: project.name })}
                          className={`flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 pb-1 text-left text-sm transition-colors ${
                            selected
                              ? "text-halo-text"
                              : "text-halo-muted/70 hover:text-halo-text"
                          }`}
                        >
                          <span className={`size-1.5 shrink-0 rounded-full ${PROJECT_DOTS[projects.indexOf(project) % PROJECT_DOTS.length]}`} />
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <span className="text-[0.6875rem] text-halo-muted/50">{items.length}</span>
                        </button>
                        <ul className="ml-1 space-y-0.5 border-l border-halo-line/70 pl-1.5">
                          {shown.map(sessionRow)}
                        </ul>
                        {items.length > 5 && (
                          <button
                            onClick={() =>
                              setExpandedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                            className="px-2 pt-1 text-xs text-halo-muted/70 transition-colors hover:text-halo-text"
                          >
                            {open ? t("sidebar.showLess") : t("sidebar.showMore", { n: items.length - 5 })}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Сессии без проекта — только во вкладке «Задачи»; во вкладке
                «Проекты» их намеренно нет (фидбек 29.09) */}
          </div>
        ) : (
          sorted.length === 0 ? (
            <p className="px-2 py-2 text-xs text-halo-muted/70">
              {activeProjectId
                ? t("sidebar.tasksEmptyProject")
                : t("sidebar.tasksEmpty")}
            </p>
          ) : (
            <ul className="space-y-0.5">{sorted.map(sessionRow)}</ul>
          )
        )}

        {/* Файлы: выбор папки проекта и дерево (M4.2) */}
        <div className="mt-5">
          <div className="flex items-center gap-1 px-2 pb-1">
            <button
              onClick={() => setFilesOpen((v) => !v)}
              style={headerColor ? { color: headerColor } : undefined}
              className="flex flex-1 items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-halo-muted/50 transition-colors hover:text-halo-text"
            >
              <ChevronSmallIcon className={filesOpen ? "" : "-rotate-90"} />
              {t("files.section")}
            </button>
            {filesOpen && projectRoot && (
              <button
                onClick={() => setCpOpen((v) => !v)}
                title={t("cp.title")}
                className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
              >
                <ClockIcon />
              </button>
            )}
            {filesOpen && projectRoot && (
              <button
                onClick={async () => {
                  const picked = await pickFolder().catch(() => null);
                  if (picked) onProjectRootChange(picked);
                }}
                title={t("files.change")}
                className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
              >
                <FolderPlusIcon />
              </button>
            )}
          </div>

          {filesOpen && !projectRoot && (
            <button
              onClick={async () => {
                const picked = await pickFolder().catch(() => null);
                if (picked) onProjectRootChange(picked);
              }}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-halo-line px-3 py-2.5 text-sm text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
            >
              <FolderIcon />
              {t("files.pick")}
            </button>
          )}
          {filesOpen && projectRoot && (
            <div>
              <button
                onClick={() => onProjectRootChange(null)}
                title={t("files.close")}
                className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-halo-text transition-colors hover:bg-halo-hover"
              >
                <span className="shrink-0 text-halo-accent/80">
                  <FolderIcon />
                </span>
                <span className="flex-1 truncate font-medium">
                  {projectRoot.split(/[\\/]/).filter(Boolean).pop() || projectRoot}
                </span>
                <span className="text-halo-muted/70" title={projectRoot}>
                  <XSmallIcon />
                </span>
              </button>
              <FileTree root={projectRoot} modifiedFiles={modifiedFiles} />
              {cpOpen && <Checkpoints root={projectRoot} />}
            </div>
          )}
        </div>

        {/* Заметки (M-N1) */}
        <div className="mt-5">
          <div className="flex items-center gap-1 px-2 pb-1">
            <HeaderLabel
              textKey="notes.section"
              color={headerColor}
              onPick={changeHeaderColor}
            />
            <button
              onClick={onOpenGraph}
              disabled={notes.length === 0}
              title={t("notes.graph")}
              className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-halo-muted"
            >
              <GraphIcon />
            </button>
            <button
              onClick={onNewNote}
              title={t("notes.new")}
              className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
            >
              <PlusIcon />
            </button>
          </div>
          {notes.length === 0 ? (
            <p className="px-2 py-1 text-xs text-halo-muted/60">{t("notes.empty")}</p>
          ) : (
            <ul className="space-y-0.5">
              {notes.map((n) => (
                <li key={n.file}>
                  {n.file === renamingId ? (
                    <RenameInput
                      initial={n.title}
                      onCommit={(value) => onRenameCommit(n.file, value)}
                      onCancel={onRenameCancel}
                    />
                  ) : (
                  <button
                    onClick={() => onOpenNote(n.file)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onNoteMenu(n.file, e.clientX, e.clientY);
                    }}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                      n.file === activeNoteFile
                        ? "bg-halo-hover-strong text-halo-text"
                        : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
                    }`}
                  >
                    <span className="shrink-0 text-halo-muted/70">
                      <FileIcon />
                    </span>
                    <span className="truncate">{n.title}</span>
                  </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      {/* Настройки */}
      <div className="border-t border-halo-line p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <GearIcon />
          {t("sidebar.settings")}
        </button>
      </div>
      </div>
    </aside>
  );
}

/**
 * История чекпоинтов проекта: снимки файлов, создаваемые автоматически
 * перед первой правкой агента в прогоне. Восстановление перезаписывает
 * файлы содержимым из снимка.
 */
function Checkpoints({ root }: { root: string }) {
  const { t, lang } = useLang();
  const [items, setItems] = useState<CheckpointMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Opt-in git-журнал (блок 12 шаг 4): каждый чекпоинт дополнительно
  // коммитится в отдельный index-dir ботовым автором
  const [gitOn, setGitOn] = useState(
    () => localStorage.getItem("haloui-checkpoints-git") === "1",
  );
  const toggleGit = () => {
    const next = !gitOn;
    setGitOn(next);
    localStorage.setItem("haloui-checkpoints-git", next ? "1" : "0");
  };
  // Таймлайн: раскрытые снимки + ленивые состояния файлов (before/current
  // из checkpoint_files — base64, сравнение строковое). Кэш по id
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [fileStates, setFileStates] = useState<
    Record<string, CheckpointFileState[] | "err">
  >({});
  const [filesLoading, setFilesLoading] = useState(false);

  const load = () => {
    checkpointList(root).then(setItems).catch(() => setItems([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [root]);

  const toggleFiles = async (cp: CheckpointMeta) => {
    const next = new Set(openFiles);
    if (next.has(cp.id)) {
      next.delete(cp.id);
      setOpenFiles(next);
      return;
    }
    next.add(cp.id);
    setOpenFiles(next);
    if (!fileStates[cp.id]) {
      setFilesLoading(true);
      try {
        const st = await checkpointFiles(root, cp.id);
        setFileStates((m) => ({ ...m, [cp.id]: st }));
      } catch {
        setFileStates((m) => ({ ...m, [cp.id]: "err" }));
      }
      setFilesLoading(false);
    }
  };

  const restore = async (cp: CheckpointMeta) => {
    if (!window.confirm(t("cp.confirmRestore"))) return;
    setBusy(cp.id);
    setStatus(null);
    try {
      const n = await checkpointRestore(root, cp.id);
      setStatus(t("cp.restored", { n }));
    } catch {
      setStatus(t("files.error"));
    }
    setBusy(null);
  };

  const remove = async (cp: CheckpointMeta) => {
    setBusy(cp.id);
    try {
      await checkpointDelete(root, cp.id);
      setItems((prev) => prev.filter((x) => x.id !== cp.id));
    } catch {
      // не критично — просто перечитаем список
      load();
    }
    setBusy(null);
  };

  /** Статус файла снимка: before/current — base64 из checkpoint_files;
   *  current null = файла больше нет (или он больше капы чтения) */
  const fileStateChip = (f: CheckpointFileState) => {
    if (f.current === null) {
      return (
        <span className="shrink-0 text-[0.5625rem] text-red-400">
          {t("cp.stateDeleted")}
        </span>
      );
    }
    if (f.current === f.before) {
      return (
        <span className="shrink-0 text-[0.5625rem] text-halo-muted/50">
          {t("cp.stateUnchanged")}
        </span>
      );
    }
    return (
      <span className="shrink-0 text-[0.5625rem] text-halo-accent">
        {t("cp.stateModified")}
      </span>
    );
  };

  return (
    <div className="mb-2 ml-3 border-l border-halo-line pl-3">
      <p className="py-1 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-halo-muted/50">
        {t("cp.title")}
      </p>
      {items.length === 0 && (
        <p className="py-1 text-[0.6875rem] text-halo-muted/70">{t("cp.empty")}</p>
      )}
      <button
        onClick={toggleGit}
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-halo-hover"
      >
        <span className="min-w-0">
          <span className="block text-[0.6875rem] text-halo-text">{t("cp.gitJournal")}</span>
          <span className="block text-[0.625rem] leading-snug text-halo-muted/70">
            {t("cp.gitJournalHint")}
          </span>
        </span>
        <span
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            gitOn ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-3 rounded-full bg-halo-on-accent transition-transform duration-200 ${
              gitOn ? "translate-x-3" : "translate-x-0"
            }`}
          />
        </span>
      </button>
      {status && (
        <p className="py-1 text-[0.6875rem] text-emerald-400">{status}</p>
      )}
      <ul>
        {items.map((cp, i) => (
          <li key={cp.id} className="group relative rounded-md px-1 py-1 hover:bg-halo-hover">
            {/* Таймлайн: точка на линии истории; последняя — горит акцентом */}
            <span
              className={`absolute top-3.5 size-1.5 rounded-full ${
                i === 0 ? "bg-halo-accent" : "bg-halo-line"
              }`}
              style={{ left: "-1.0625rem" }}
            />
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-halo-text" title={cp.label || undefined}>
                  {cp.label || t("cp.unlabeled")}
                </p>
                <p className="text-[0.625rem] text-halo-muted/70">
                  {new Date(cp.ts).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {t("cp.files", { n: cp.files })}
                  {cp.git && (
                    <>
                      {" · "}
                      <span className="font-mono" title="git">
                        {cp.git.slice(0, 7)}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={() => void restore(cp)}
                disabled={busy === cp.id}
                title={t("cp.restore")}
                className="rounded p-1 text-halo-muted opacity-0 transition group-hover:opacity-100 hover:text-halo-text disabled:opacity-30"
              >
                <RestoreIcon />
              </button>
              <button
                onClick={() => void remove(cp)}
                disabled={busy === cp.id}
                title={t("cp.delete")}
                className="rounded p-1 text-halo-muted opacity-0 transition group-hover:opacity-100 hover:text-red-400 disabled:opacity-30"
              >
                <XSmallIcon />
              </button>
            </div>
            {/* Файлы снимка: что чекпоинт держал и что с ними стало с тех пор */}
            {cp.files > 0 && (
              <button
                onClick={() => void toggleFiles(cp)}
                className="mt-0.5 text-[0.5625rem] text-halo-muted/70 transition-colors hover:text-halo-text"
              >
                {openFiles.has(cp.id) ? "▾ " : "▸ "}
                {t("cp.showFiles")}
              </button>
            )}
            {openFiles.has(cp.id) && (
              <div className="mt-1 space-y-0.5 rounded-md border border-halo-line/60 bg-halo-deep/40 px-2 py-1.5">
                {fileStates[cp.id] === "err" && (
                  <p className="text-[0.5625rem] text-red-400">{t("files.error")}</p>
                )}
                {filesLoading && !fileStates[cp.id] && (
                  <p className="text-[0.5625rem] text-halo-muted/70">{t("cp.filesLoading")}</p>
                )}
                {Array.isArray(fileStates[cp.id]) && (
                  <>
                    {(fileStates[cp.id] as CheckpointFileState[])
                      .slice(0, 30)
                      .map((f) => (
                        <p key={f.rel} className="flex items-baseline gap-1.5 text-[0.5625rem]">
                          <span className="min-w-0 flex-1 truncate font-mono text-halo-text/80" title={f.rel}>
                            {f.rel}
                          </span>
                          {fileStateChip(f)}
                        </p>
                      ))}
                    {Array.isArray(fileStates[cp.id]) &&
                      (fileStates[cp.id] as CheckpointFileState[]).length > 30 && (
                        <p className="text-[0.5625rem] text-halo-muted/60">
                          {t("cp.moreFiles", {
                            n: (fileStates[cp.id] as CheckpointFileState[]).length - 30,
                          })}
                        </p>
                      )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Клик по заголовку секции — палитра цвета: 6 пресетов тем + свой */
function HeaderLabel({
  textKey,
  color,
  onPick,
}: {
  textKey: MsgKey;
  color: string;
  onPick: (hex: string) => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative flex-1">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t("sidebar.headerColorTitle")}
        style={color ? { color } : undefined}
        className={`text-[0.6875rem] font-medium uppercase tracking-[0.14em] transition-colors ${
          color ? "hover:opacity-80" : "text-halo-muted/50 hover:text-halo-text"
        }`}
      >
        {t(textKey)}
      </button>
      {open && (
        <ColorPalette
          current={color}
          onPick={(hex) => {
            onPick(hex);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function ColorPalette({
  current,
  onPick,
  onClose,
}: {
  current: string;
  onPick: (hex: string) => void;
  onClose: () => void;
}) {
  const { t } = useLang();
  return (
    <div className="anim-pop absolute left-0 top-6 z-[var(--halo-z-panel-top)] w-44 rounded-lg border border-halo-line bg-halo-deep p-2 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[0.625rem] uppercase tracking-wider text-halo-muted/70">
          {t("sidebar.headerColorTitle")}
        </p>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-halo-muted hover:text-halo-text"
        >
          <XSmallIcon />
        </button>
      </div>
      <div className="mb-2 grid grid-cols-6 gap-1.5">
        {ACCENT_PRESETS.map((a) => (
          <button
            key={a.hex}
            onClick={() => onPick(a.hex)}
            style={{ backgroundColor: a.hex }}
            title={a.hex}
            className={`size-5 rounded-full border transition-transform hover:scale-110 ${
              current === a.hex ? "border-halo-text" : "border-transparent"
            }`}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={current || "#8a8f98"}
          onChange={(e) => onPick(e.target.value)}
          title={t("sidebar.headerColorCustom")}
          className="h-6 w-8 cursor-pointer rounded border border-halo-line bg-transparent"
        />
        <button
          onClick={() => onPick("")}
          className="flex-1 rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("sidebar.headerColorReset")}
        </button>
      </div>
    </div>
  );
}

/** Относительное время: «5м / 3ч / 2д» (компактно, как в IDE-сайдбарах).
 *  D14: zh/ja раньше показывали русские слова («5 минут») — родные единицы */
function relTime(ts: number, lang: "ru" | "en" | "zh" | "ja"): string {
  const m = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (lang === "zh") {
    if (m < 60) return `${m} 分`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 时`;
    return `${Math.floor(h / 24)} 天`;
  }
  if (lang === "ja") {
    if (m < 60) return `${m} 分`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 時間`;
    return `${Math.floor(h / 24)} 日`;
  }
  if (m < 60) return lang === "ru" ? `${m}м` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === "ru" ? `${h}ч` : `${h}h`;
  return lang === "ru" ? `${Math.floor(h / 24)}д` : `${Math.floor(h / 24)}d`;
}

/** D14: соединение сегментов пути в нормализованной форме (разделитель
 *  платформы — как в normalizePath, без хвостовых слэшей базового сегмента) */
function joinNorm(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, "")}${pathSep()}${name}`;
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.6 2.9 21 11.3a2 2 0 0 1 0 2.8l-6.9 6.9a2 2 0 0 1-2.8 0L2.9 12.6A2 2 0 0 1 2.3 11V4.3a2 2 0 0 1 2-2H11a2 2 0 0 1 1.6.6z" />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Формат размера: B/KB/MB (RU: Б/КБ/МБ), компактно для дерева */function formatSize(size: number, lang: "ru" | "en" | "zh" | "ja"): string {
  const u = lang === "ru" ? ["Б", "КБ", "МБ"] : ["B", "KB", "MB"];
  if (size < 1024) return `${size} ${u[0]}`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} ${u[1]}`;
  return `${(size / (1024 * 1024)).toFixed(1)} ${u[2]}`;
}

/**
 * Дерево файлов проекта (M4.2): ленивая загрузка папок через list_dir,
 * раскрытие по клику, клик по файлу копирует абсолютный путь.
 * Файлы, изменённые агентом в активной задаче, помечаются точкой (M4.3).
 */
// F6: memo — во время стрима App перерисовывается на каждый флэш дельт,
// а пропсы FileTree стабильны (root + мемоизированный modifiedFiles):
// без memo дерево файлов рекурсивно перестраивалось 60 раз/сек
const FileTree = memo(function FileTree({
  root,
  modifiedFiles,
}: {
  root: string;
  modifiedFiles: Set<string>;
}) {
  const { lang, t } = useLang();
  const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
  // Кэш содержимого папок: path → entries | "error" | "loading"
  const [cache, setCache] = useState<Map<string, FileEntry[] | "error" | "loading">>(
    () => new Map(),
  );

  const load = (path: string) => {
    if (cache.has(path)) return;
    setCache((prev) => {
      const next = new Map(prev);
      next.set(path, "loading"); // плейсхолдер, чтобы не грузить повторно
      return next;
    });
    listDir(path)
      .then((entries) =>
        setCache((prev) => new Map(prev).set(path, entries)),
      )
      .catch(() => setCache((prev) => new Map(prev).set(path, "error")));
  };

  // Первая загрузка корня и перезагрузка при смене папки
  useEffect(() => {
    load(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Git-статус для подсветки (M5.1): относительный путь → код porcelain.
  // null — не git-repo, подсветки нет
  const [gitMap, setGitMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    setGitMap(null);
    void gitStatus(root).then((entries) => {
      if (!alive) return;
      if (!entries) return;
      const m = new Map<string, string>();
      for (const e of entries) m.set(normalizePath(e.path), e.code);
      setGitMap(m);
    });
    return () => {
      alive = false;
    };
  }, [root]);

  const rootNorm = normalizePath(root);
  /** Цвет имени по git-коду: удалённые красным, остальные изменённые — зелёным */
  const gitColorOf = (relNorm: string): string => {
    const code = gitMap?.get(relNorm);
    if (!code) return "";
    return code.includes("D") ? "text-red-400" : "text-emerald-400";
  };

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      load(path);
    }
    setOpen(next);
  };

  const renderEntries = (path: string, depth: number): React.ReactNode => {
    const entries = cache.get(path);
    if (!entries || entries === "error" || entries === "loading") {
      return entries === "error" ? (
        <p className="py-1 text-[0.6875rem] text-red-400/80" style={{ paddingLeft: depth * 14 + 30 }}>
          {t("files.error")}
        </p>
      ) : (
        <p className="py-1 text-[0.6875rem] text-halo-muted/60" style={{ paddingLeft: depth * 14 + 30 }}>
          …
        </p>
      );
    }
    if (entries.length === 0) {
      return (
        <p className="py-1 text-[0.6875rem] text-halo-muted/60" style={{ paddingLeft: depth * 14 + 30 }}>
          {t("files.empty")}
        </p>
      );
    }
    const rows = entries.map((e) => {
      // D14: соединение через утилиту joinNorm (см. ниже) — явный бэкслэш
      // в шаблоне держал соглашение normalizePath только неявно
      const childPath = joinNorm(path, e.name);
      const isOpen = open.has(childPath);
      // Подсветка (M4.3): файл — точное совпадение пути, папка — если
      // внутри неё есть хоть один изменённый файл (по префиксу)
      const norm = normalizePath(childPath);
      const isModified = e.is_dir
        ? Array.from(modifiedFiles).some((p) => p.startsWith(`${norm}${pathSep()}`))
        : modifiedFiles.has(norm);
      // Git-статус (M5.1): относительный путь внутри корня
      const relNorm = norm.startsWith(`${rootNorm}${pathSep()}`)
        ? norm.slice(rootNorm.length + 1)
        : norm;
      const gitColor = e.is_dir ? "" : gitColorOf(relNorm);
      return (
        <div key={childPath}>
          <button
            onClick={() => {
              if (e.is_dir) toggle(childPath);
              else {
                void copyText(childPath);
              }
            }}
            title={
              e.is_dir
                ? e.name
                : `${childPath} · ${t("files.copied")}${isModified ? ` · ${t("files.modified")}` : ""}`
            }
            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
            style={{ paddingLeft: depth * 14 + 8 }}
          >
            {e.is_dir ? (
              <>
                <ChevronSmallIcon
                  className={`shrink-0 transition-transform duration-150 ${isOpen ? "" : "-rotate-90"}`}
                />
                <span className="shrink-0 text-halo-accent/70">
                  <FolderIcon />
                </span>
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <span className="shrink-0 text-halo-muted/70">
                  <FileIcon />
                </span>
              </>
            )}
            <span
              className={`truncate ${
                isModified
                  ? "font-medium text-emerald-400"
                  : gitColor || ""
              }`}
            >
              {e.name}
            </span>
            {isModified && (
              <span
                className="ml-1 size-1.5 shrink-0 rounded-full bg-emerald-400"
                title={t("files.modified")}
              />
            )}
            {!e.is_dir && !isModified && e.size > 0 && (
              <span className="ml-auto shrink-0 text-[0.625rem] text-halo-muted/50">
                {formatSize(e.size, lang)}
              </span>
            )}
          </button>
          {e.is_dir && isOpen && renderEntries(childPath, depth + 1)}
        </div>
      );
    });
    // Аудит: list_dir обрезает ответ до 500 записей молча — бекенд ставит
    // флаг на последней записи, здесь честный маркер вместо тишины
    const last = entries[entries.length - 1];
    if (last?.truncated) {
      rows.push(
        <div
          key="…truncated"
          className="px-2 py-1 text-[0.625rem] text-halo-muted/50"
        >
          {t("sidebar.filesMore")}
        </div>,
      );
    }
    return rows;
  };

  return <div>{renderEntries(root, 1)}</div>;
});

/** Инлайн-переименование: Enter/уход фокуса — сохранить, Escape — отменить */
function RenameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
  allowEmpty,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /** Разрешить коммит пустой строки (снятие тега); по умолчанию пустое = отмена */
  allowEmpty?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    const trimmed = value.trim();
    // FIX: ветка allowEmpty — пустой ввод коммитится (тег снимается),
    // если изначально тег был
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else if (allowEmpty && trimmed === "" && initial !== "") onCommit("");
    else onCancel();
  };

  return (
    <input
      autoFocus
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        // isComposing: энтер подтверждения IME не должен коммитить
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish();
        if (e.key === "Escape") {
          finished.current = true;
          onCancel();
        }
      }}
      className="w-full rounded-md border border-halo-accent/50 bg-halo-surface px-2 py-1.5 text-sm text-halo-text outline-none"
    />
  );
}

function BrandMark() {
  return <NocturnMark size={16} />;
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
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

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

function ChevronSmallIcon({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-150 ${className ?? ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function FolderIcon() {
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
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function FolderPlusIcon() {
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
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="19" cy="5" r="2.4" />
      <circle cx="12" cy="17" r="2.4" />
      <path d="M7 7.2 10.5 15M17 7 13.5 15M7.4 6H16.6" />
    </svg>
  );
}

function XSmallIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
