import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Note } from "../vault";
import { buildBacklinks, extractLinks, resolveLinks } from "../vault";
import { useLang } from "../locales";
import { MarkdownLink } from "./cards/MarkdownLink";
import { STATUS_INFO, STATUS_OK, STATUS_WARN, STATUS_WARN_DIM } from "../statusColors";

/**
 * Редактор заметки (M-N1): markdown с превью, вставка [[ссылок]],
 * обратные ссылки. Файл хранится как note-<id>.md, заголовок —
 * первая строка "# ...", поэтому переименование не требует mv.
 */

interface NotesModalProps {
  note: Note | null;
  allNotes: Note[];
  saving: boolean;
  onSave: (file: string, content: string) => void;
  /** Запустить цепочку шагов от этой заметки (M-N3) */
  onRunChain: (file: string, content: string) => void;
  onDelete: (file: string) => void;
  onOpenNote: (file: string) => void;
  onClose: () => void;
}

export default function NotesModal({
  note,
  allNotes,
  saving,
  onSave,
  onRunChain,
  onDelete,
  onOpenNote,
  onClose,
}: NotesModalProps) {
  const { t } = useLang();
  const [draft, setDraft] = useState(note?.content ?? "");
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Таймер подтверждения удаления: снимаем при размонтировании и повторном
  // клике, чтобы колбэк не срабатывал вхолостую после закрытия модалки
  const confirmTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), []);

  // Сброс черновика — только при СМЕНЕ заметки: content в deps нужен
  // линтеру (он приезжает с диска после сейва), но сброс по нему стирал бы
  // несохранённые правки пользователя (например, пока идёт цепочка)
  const lastNoteFileRef = useRef<string | null>(null);
  useEffect(() => {
    const file = note?.file ?? null;
    if (lastNoteFileRef.current === file) return;
    lastNoteFileRef.current = file;
    setDraft(note?.content ?? "");
    setPreview(false);
    setConfirmDelete(false);
  }, [note?.file, note?.content]);

  const links = useMemo(() => resolveLinks(
    { file: note?.file ?? "", title: note?.title ?? "", content: draft, updated: 0 },
    allNotes,
  ), [draft, note?.file, note?.title, allNotes]);

  const backlinks = useMemo(
    () => buildBacklinks(allNotes).get(note?.file ?? "") ?? [],
    [allNotes, note?.file],
  );

  if (!note) return null;
  const dirty = draft !== note.content;

  const insertLink = (targetTitle: string) => {
    const el = textareaRef.current;
    const snippet = `[[${targetTitle}]]`;
    if (!el) {
      setDraft((d) => d + snippet);
      return;
    }
    const pos = el.selectionStart ?? draft.length;
    setDraft(draft.slice(0, pos) + snippet + draft.slice(pos));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos + snippet.length, pos + snippet.length);
    });
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка: заголовок-кнопка (drag-совместимая), переключатель вида, действия */}
        <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-4 py-2.5">
          <span className="text-halo-accent">
            <NoteIcon />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-halo-text">
            {note.title}
            {dirty && <span className="ml-1.5 text-halo-muted">•</span>}
          </h2>
          <div className="flex rounded-lg border border-halo-line p-0.5">
            <button
              onClick={() => setPreview(false)}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                !preview ? "bg-halo-accent/15 text-halo-accent" : "text-halo-muted hover:text-halo-text"
              }`}
            >
              {t("notes.edit")}
            </button>
            <button
              onClick={() => setPreview(true)}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                preview ? "bg-halo-accent/15 text-halo-accent" : "text-halo-muted hover:text-halo-text"
              }`}
            >
              {t("notes.preview")}
            </button>
          </div>
          <button
            onClick={() => onRunChain(note.file, draft)}
            title={t("notes.runChain")}
            className="rounded-md px-2 py-1 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-accent"
          >
            ⛓ {t("notes.runChain")}
          </button>
          <button
            onClick={() => {
              if (confirmDelete) {
                onDelete(note.file);
              } else {
                setConfirmDelete(true);
                window.clearTimeout(confirmTimerRef.current);
                confirmTimerRef.current = window.setTimeout(
                  () => setConfirmDelete(false),
                  3000,
                );
              }
            }}
            title={t("notes.delete")}
            className={`rounded-md px-2 py-1 text-xs transition-colors ${
              confirmDelete
                ? "bg-red-500/20 text-red-400"
                : "text-halo-muted hover:bg-halo-hover hover:text-red-400"
            }`}
          >
            {confirmDelete ? t("notes.deleteSure") : t("notes.delete")}
          </button>
          <button
            onClick={onClose}
            title={t("prompts.cancel")}
            className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Сплит: редактор | живой мини-граф заметки */}
        <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        {/* Тело: редактор или превью */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {preview ? (
            <div className="scroll-slim markdown h-full overflow-y-auto px-5 py-4 text-sm leading-relaxed text-halo-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  // [[вики-ссылки]] в стиле Obsidian: клик открывает заметку,
                  // а если её нет — создаёт,
                  a: ({ href, children }) => {
                    const noteMark = "#note:";
                    if (href?.startsWith(noteMark)) {
                      const title = decodeURIComponent(href.slice(noteMark.length));
                      return (
                        <button
                          onClick={() => onOpenNote(title)}
                          className="text-halo-accent underline underline-offset-2 transition-colors hover:text-halo-accent-deep"
                        >
                          {children}
                        </button>
                      );
                    }
                    // D4: обычный <a> уводил вебвью приложения на внешний URL (фишинг
                    // в доверенном окне) — как в AssistantCard, через системный браузер
                    return <MarkdownLink href={href}>{children}</MarkdownLink>;
                  },
                }}
              >
                {wikiToMarkdown(draft)}
              </ReactMarkdown>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onSave(note.file, draft);
                }
              }}
              placeholder={t("notes.placeholder")}
              className="scroll-slim h-full w-full resize-none bg-transparent px-5 py-4 font-mono text-[0.8125rem] leading-relaxed text-halo-text outline-none placeholder:text-halo-muted/60"
            />
          )}
        </div>

        {/* Подвал: ссылки, backlinks, вставка, сохранение */}
        <div className="shrink-0 border-t border-halo-line px-4 py-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {/* Вставка ссылки на существующую заметку */}
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) insertLink(e.target.value);
              }}
              className="max-w-44 rounded-md border border-halo-line bg-halo-surface px-2 py-1 text-xs text-halo-muted outline-none transition-colors hover:text-halo-text"
            >
              <option value="">{t("notes.insertLink")}</option>
              {allNotes
                .filter((n) => n.file !== note.file)
                .map((n) => (
                  <option key={n.file} value={n.title}>
                    {n.title}
                  </option>
                ))}
            </select>

            {links.resolved.map((l) => (
              <button
                key={l.file}
                onClick={() => {
                  if (dirty) onSave(note.file, draft);
                  onOpenNote(l.file);
                }}
                className="rounded-full border border-halo-line bg-halo-surface/60 px-2 py-0.5 text-[0.6875rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
              >
                → {l.title}
              </button>
            ))}
            {links.dangling.map((title) => (
              <button
                key={title}
                onClick={() => {
                  if (dirty) onSave(note.file, draft);
                  onOpenNote(title);
                }}
                title={`${t("notes.dangling")} · ${t("notes.createHint")}`}
                className="rounded-full border border-dashed border-amber-400/50 px-2 py-0.5 text-[0.6875rem] text-amber-400/90 transition-colors hover:border-amber-400 hover:text-amber-300"
              >
                → {title}?
              </button>
            ))}
            {backlinks.length > 0 && (
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="text-[0.625rem] uppercase tracking-wider text-halo-muted/60">
                  {t("notes.backlinks")}
                </span>
                {backlinks.map((b) => (
                  <button
                    key={b.file}
                    onClick={() => {
                      if (dirty) onSave(note.file, draft);
                      onOpenNote(b.file);
                    }}
                    className="rounded-full border border-halo-line bg-halo-surface/60 px-2 py-0.5 text-[0.6875rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
                  >
                    ← {b.title}
                  </button>
                ))}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[0.625rem] text-halo-muted/60">{t("notes.ctrlEnter")}</span>
            <button
              onClick={() => onSave(note.file, draft)}
              disabled={!dirty || saving}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? t("api.checking") : t("api.save")}
            </button>
          </div>
        </div>
        </div>

          {/* Живой граф: соседи, порядок цепочки, backlinks */}
          <aside className="hidden w-64 shrink-0 flex-col border-l border-halo-line md:flex">
            <p className="border-b border-halo-line/60 px-3 py-2 text-[0.625rem] font-medium uppercase tracking-wider text-halo-muted/60">
              {t("notes.miniGraph")}
            </p>
            <MiniGraph
              title={note.title}
              draft={draft}
              allNotes={allNotes}
              onNavigate={(target) => {
                onSave(note.file, draft);
                onOpenNote(target);
              }}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

/** Мини-граф заметки: центр — текущая, вокруг соседи.
    Справа — исходящие [[ссылки]] с номерами шагов цепочки,
    слева — backlinks, висячие — жёлтым пунктиром. */
function MiniGraph({
  title,
  draft,
  allNotes,
  onNavigate,
}: {
  title: string;
  draft: string;
  allNotes: Note[];
  onNavigate: (target: string) => void;
}) {
  const { t } = useLang();
  const links = extractLinks(draft);
  const byTitle = new Map(allNotes.map((n) => [n.title.toLowerCase(), n]));

  interface Nb {
    key: string;
    label: string;
    kind: "resolved" | "dangling" | "backlink";
    target: string; // заголовок для перехода
    order?: number;
  }
  const backlinks = useMemo(
    () => buildBacklinks(allNotes).get(
      allNotes.find((n) => n.title === title)?.file ?? "",
    ) ?? [],
    [allNotes, title],
  );

  const neighbors: Nb[] = [];
  links.forEach((link, i) => {
    const exists = byTitle.get(link.toLowerCase());
    neighbors.push({
      key: `out-${i}`,
      label: link,
      kind: exists ? "resolved" : "dangling",
      target: link,
      order: i + 1,
    });
  });
  backlinks.forEach((b) => {
    neighbors.push({
      key: `in-${b.file}`,
      label: b.title,
      kind: "backlink",
      target: b.title,
    });
  });

  // Раскладка: исходящие справа, backlinks слева, по дуге
  const R = 92;
  const positioned = neighbors.map((nb) => {
    const side = nb.kind === "backlink" ? -1 : 1;
    const sameSide = neighbors.filter(
      (x) => (x.kind === "backlink" ? -1 : 1) === side,
    );
    const idx = sameSide.indexOf(nb);
    const angle = side * (Math.PI / 2) + ((idx - (sameSide.length - 1) / 2) / Math.max(1, sameSide.length)) * 1.5;
    return { ...nb, x: Math.cos(angle) * R, y: Math.sin(angle) * R };
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <svg className="min-h-0 w-full flex-1" viewBox="-150 -135 300 270">
        {positioned.map((nb) => (
          <line
            key={`l-${nb.key}`}
            x1={0}
            y1={0}
            x2={nb.x * 0.55}
            y2={nb.y * 0.55}
              stroke={nb.kind === "dangling" ? STATUS_WARN_DIM : "var(--halo-line)"}
            strokeWidth={1.2}
          />
        ))}
        {/* Центральный узел */}
        <circle r={13} fill="var(--halo-accent)" stroke="var(--halo-surface)" strokeWidth={2} />
        <text y={-20} textAnchor="middle" fill="var(--halo-text)" fontSize={11} className="select-none">
          {title.length > 16 ? title.slice(0, 15) + "…" : title}
        </text>
        {/* Соседи */}
        {positioned.map((nb) => (
          <g
            key={nb.key}
            transform={`translate(${nb.x},${nb.y})`}
            className="cursor-pointer"
            onClick={() => onNavigate(nb.target)}
          >
            <circle
              r={8}
              fill={
                nb.kind === "resolved"
                  ? STATUS_OK
                  : nb.kind === "backlink"
                    ? STATUS_INFO
                    : "transparent"
              }
              stroke={nb.kind === "dangling" ? STATUS_WARN : "var(--halo-surface)"}
              strokeWidth={1.6}
              strokeDasharray={nb.kind === "dangling" ? "3 2" : undefined}
            />
            {nb.order !== undefined && (
              <text y={3.5} textAnchor="middle" fill="#0e0f0d" fontSize={9} fontWeight={700}>
                {nb.order}
              </text>
            )}
            <text
              y={20}
              textAnchor="middle"
              fill="var(--halo-muted)"
              fontSize={9.5}
              className="select-none"
            >
              {nb.label.length > 14 ? nb.label.slice(0, 13) + "…" : nb.label}
            </text>
            <title>{t("notes.miniGraphOpen")}</title>
          </g>
        ))}
      </svg>
      <div className="space-y-1 border-t border-halo-line/60 px-3 py-2 text-[0.625rem] text-halo-muted/70">
        <p>
          <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: STATUS_OK }} />
          {t("notes.mgOut")}
        </p>
        <p>
          <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: STATUS_INFO }} />
          {t("notes.mgBack")}
        </p>
        <p>
          <span
            className="mr-1 inline-block size-2 rounded-full border border-dashed align-middle"
            style={{ borderColor: STATUS_WARN }}
          />
          {t("notes.mgDangling")}
        </p>
      </div>
    </div>
  );
}

/** [[вики-ссылки]] → markdown-ссылки с маркером #note: для рендера превью */
function wikiToMarkdown(text: string): string {
  return text.replace(/\[\[([^\[\]\n]+?)\]\]/g, (_m, title: string) =>
    `[${title}](#note:${encodeURIComponent(title.trim())})`,
  );
}

function NoteIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8m8 3H8m8 3h-5" />
    </svg>
  );
}
