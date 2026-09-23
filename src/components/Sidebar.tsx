import { useEffect, useRef, useState } from "react";
import type { Project, Session } from "../types";
import WindowControls from "./WindowControls";
import { pickFolder, listDir, gitStatus, checkpointList, checkpointRestore, checkpointDelete, type CheckpointMeta, type FileEntry, type NoteInfo } from "../api";
import { normalizePath } from "../diff";
import { ACCENT_PRESETS } from "../appearance";
import { useLang } from "../locales";
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
  onAddProject: (name: string) => void;
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
  // Группировка списка задач: плоский / по проектам (запоминается)
  const [groupBy, setGroupBy] = useState<"flat" | "project">(() =>
    localStorage.getItem("haloui-sidebar-group") === "project"
      ? "project"
      : "flat",
  );
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
  const visible = (activeProjectId
    ? sessions.filter((s) => s.projectId === activeProjectId)
    : sessions
  ).filter((s) => !!s.archived === showArchived);
  // Закреплённые задачи всегда сверху
  const sorted = [...visible].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned),
  );
  // Группы для режима «по проектам»: все проекты в порядке списка
  // (включая пустые), в конце — задачи без проекта
  const projectGroups: { project: Project | null; items: Session[] }[] = (() => {
    const groups: { project: Project | null; items: Session[] }[] = [];
    for (const p of projects) {
      groups.push({ project: p, items: sorted.filter((s) => s.projectId === p.id) });
    }
    const rest = sorted.filter(
      (s) => !s.projectId || !projects.some((p) => p.id === s.projectId),
    );
    if (rest.length > 0) groups.push({ project: null, items: rest });
    return groups;
  })();
  // Строка задачи: общий рендер для обоих режимов списка; на ховере —
  // быстрые действия: архив (или вернуть), тег, удалить
  const sessionRow = (s: Session) => (
    <li key={s.id} className="group/row">
      {s.id === renamingId ? (
        <RenameInput
          initial={s.title}
          onCommit={(value) => onRenameCommit(s.id, value)}
          onCancel={onRenameCancel}
        />
      ) : (
        <button
          onClick={() => onSelect(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onSessionMenu(s.id, e.clientX, e.clientY);
          }}
          title={s.tag ? `[${s.tag}] ${s.title}` : s.title}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm transition-all duration-150 ${
            s.id === activeId
              ? "bg-halo-hover-strong text-halo-text"
              : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
          }`}
        >
          {s.pinned && (
            <span className="shrink-0 text-halo-accent/80">
              <PinIcon />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {/* Тег-метка чата */}
          {s.tag && (
            <span className="shrink-0 rounded border border-halo-line px-1 py-px text-[10px] text-halo-muted">
              {s.tag}
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-halo-muted/50 group-hover/row:hidden">
            {relTime(s.createdAt, lang)}
          </span>
          {/* Быстрые действия — только на ховере */}
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
            {s.archived ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchiveSession(s.id, false);
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
                  onArchiveSession(s.id, true);
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
                const tag = window.prompt(t("sidebar.tagPrompt"), s.tag ?? "");
                if (tag !== null) onTagSession(s.id, tag.trim() || undefined);
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
                onDeleteSession(s.id);
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
        className={`absolute top-0 z-30 h-full w-1.5 cursor-col-resize transition-colors hover:bg-halo-accent/40 ${
          side === "left" ? "-right-0.5" : "-left-0.5"
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
          <span className="text-[15px] font-semibold tracking-wide">Nocturn</span>
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
          <kbd className="text-[11px] tracking-wide text-halo-muted/60">
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
          <kbd className="text-[11px] tracking-wide text-halo-muted/60">
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
            <span className="text-[10px] font-semibold">#</span>
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
            {/* Секция проектов: скрывается стрелкой (как в референсе) */}
            {!projectsCollapsed && (
              <div>
                <div className="flex items-center gap-1 px-2 pb-1">
                  <HeaderLabel
                    textKey="sidebar.projects"
                    color={headerColor}
                    onPick={changeHeaderColor}
                  />
                  <button
                    onClick={() => setAddingProject(true)}
                    title={t("projects.add")}
                    className="rounded p-0.5 text-halo-muted transition-colors hover:text-halo-text"
                  >
                    <PlusIcon />
                  </button>
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
                  {projectGroups.filter((g) => g.project).map(({ project, items }) => {
                    const key = project?.id ?? "none";
                    const open = expandedGroups.has(key);
                    const shown = open ? items : items.slice(0, 5);
                    const selected = project?.id === activeProjectId;
                    return (
                      <div key={key}>
                        <button
                          onClick={() => onSelectProject(selected ? null : project!.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onProjectMenu(project!.id, e.clientX, e.clientY);
                          }}
                          title={selected ? t("sidebar.showAll") : t("sidebar.showProject", { name: project!.name })}
                          className={`flex w-full items-center gap-1.5 rounded-md px-2 pb-1 text-left text-sm transition-colors ${
                            selected
                              ? "text-halo-text"
                              : "text-halo-muted/70 hover:text-halo-text"
                          }`}
                        >
                          <span className={`size-1.5 shrink-0 rounded-full ${PROJECT_DOTS[projects.indexOf(project!) % PROJECT_DOTS.length]}`} />
                          <span className="min-w-0 flex-1 truncate">{project?.name}</span>
                          <span className="text-[11px] text-halo-muted/50">{items.length}</span>
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
            {/* Задачи без проекта — всегда на виду */}
            <div>
              <div className="px-2 pb-1">
                <HeaderLabel
                  textKey="sidebar.tasks"
                  color={headerColor}
                  onPick={changeHeaderColor}
                />
              </div>
              {projectGroups.filter((g) => !g.project).length === 0 ? (
                <p className="px-2 py-1 text-xs text-halo-muted/70">
                  {t("sidebar.tasksEmpty")}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {projectGroups
                    .filter((g) => !g.project)
                    .flatMap((g) => g.items)
                    .map(sessionRow)}
                </ul>
              )}
            </div>
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
              className="flex flex-1 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-halo-muted/50 transition-colors hover:text-halo-text"
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

  const load = () => {
    checkpointList(root).then(setItems).catch(() => setItems([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [root]);

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

  return (
    <div className="mb-2 ml-3 border-l border-halo-line pl-3">
      <p className="py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-halo-muted/50">
        {t("cp.title")}
      </p>
      {items.length === 0 && (
        <p className="py-1 text-[11px] text-halo-muted/70">{t("cp.empty")}</p>
      )}
      {status && (
        <p className="py-1 text-[11px] text-emerald-400">{status}</p>
      )}
      <ul>
        {items.map((cp) => (
          <li key={cp.id} className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-halo-hover">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-halo-text" title={cp.label || undefined}>
                {cp.label || t("cp.unlabeled")}
              </p>
              <p className="text-[10px] text-halo-muted/70">
                {new Date(cp.ts).toLocaleString(lang === "ru" ? "ru-RU" : "en-US", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {" · "}
                {t("cp.files", { n: cp.files })}
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
  textKey: string;
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
        className={`text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
          color ? "hover:opacity-80" : "text-halo-muted/50 hover:text-halo-text"
        }`}
      >
        {t(textKey as never)}
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
    <div className="anim-pop absolute left-0 top-6 z-40 w-44 rounded-lg border border-halo-line bg-halo-deep p-2 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-halo-muted/70">
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
          className="flex-1 rounded-md border border-halo-line px-2 py-1 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
        >
          {t("sidebar.headerColorReset")}
        </button>
      </div>
    </div>
  );
}

/** Относительное время: «5м / 3ч / 2д» (компактно, как в IDE-сайдбарах) */
function relTime(ts: number, lang: "ru" | "en" | "zh" | "ja"): string {
  const m = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (m < 60) return lang === "ru" ? `${m}м` : lang === "zh" || lang === "ja" ? `${m} минут` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return lang === "ru" ? `${h}ч` : lang === "zh" || lang === "ja" ? `${h} 小时` : `${h}h`;
  const d = Math.floor(h / 24);
  return lang === "ru" ? `${d}д` : lang === "zh" || lang === "ja" ? `${d} 天` : `${d}d`;
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
function FileTree({
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
        <p className="py-1 text-[11px] text-red-400/80" style={{ paddingLeft: depth * 14 + 30 }}>
          {t("files.error")}
        </p>
      ) : (
        <p className="py-1 text-[11px] text-halo-muted/60" style={{ paddingLeft: depth * 14 + 30 }}>
          …
        </p>
      );
    }
    if (entries.length === 0) {
      return (
        <p className="py-1 text-[11px] text-halo-muted/60" style={{ paddingLeft: depth * 14 + 30 }}>
          {t("files.empty")}
        </p>
      );
    }
    return entries.map((e) => {
      const childPath = `${path.replace(/[\\/]+$/, "")}\\${e.name}`;
      const isOpen = open.has(childPath);
      // Подсветка (M4.3): файл — точное совпадение пути, папка — если
      // внутри неё есть хоть один изменённый файл (по префиксу)
      const norm = normalizePath(childPath);
      const isModified = e.is_dir
        ? Array.from(modifiedFiles).some((p) => p.startsWith(`${norm}\\`))
        : modifiedFiles.has(norm);
      // Git-статус (M5.1): относительный путь внутри корня
      const relNorm = norm.startsWith(`${rootNorm}\\`)
        ? norm.slice(rootNorm.length + 1)
        : norm;
      const gitColor = e.is_dir ? "" : gitColorOf(relNorm);
      return (
        <div key={childPath}>
          <button
            onClick={() => {
              if (e.is_dir) toggle(childPath);
              else {
                navigator.clipboard
                  .writeText(childPath)
                  .catch(() => {});
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
              <span className="ml-auto shrink-0 text-[10px] text-halo-muted/50">
                {formatSize(e.size, lang)}
              </span>
            )}
          </button>
          {e.is_dir && isOpen && renderEntries(childPath, depth + 1)}
        </div>
      );
    });
  };

  return <div>{renderEntries(root, 1)}</div>;
}

/** Инлайн-переименование: Enter/уход фокуса — сохранить, Escape — отменить */
function RenameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
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
        if (e.key === "Enter") finish();
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
