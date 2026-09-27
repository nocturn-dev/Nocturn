/**
 * Базы знаний (RAG): управление локальными индексами документов и
 * привязка базы к активному чату. Всё локально — SQLite FTS5 в appdata
 * (см. src-tauri/src/kb.rs); в контекст модели уходит только выжимка
 * найденных фрагментов, сами файлы никуда не уходят.
 */

import { useCallback, useEffect, useState } from "react";
import { useDelayedUnmount } from "../motion";
import {
  kbAddDocument,
  kbCreate,
  kbDelete,
  kbDocuments,
  kbList,
  kbRemoveDocument,
  pickDocFiles,
  type KbDoc,
  type KbMeta,
} from "../api";
import { useLang } from "../locales";

interface KnowledgeModalProps {
  open: boolean;
  onClose: () => void;
  /** База, привязанная к активному чату (null — не привязана) */
  attachedKbId: string | null;
  /** Привязать/отвязать базу к активному чату */
  onAttach: (kbId: string | null) => void;
  /** Есть ли активный чат: без него привязывать не к чему */
  hasActiveChat: boolean;
}

export default function KnowledgeModal({
  open,
  onClose,
  attachedKbId,
  onAttach,
  hasActiveChat,
}: KnowledgeModalProps) {
  const { t } = useLang();
  const show = useDelayedUnmount(open, 170);
  const [bases, setBases] = useState<KbMeta[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void kbList()
      .then((list) => {
        setBases(list);
        // Выбранная база могла исчезнуть — падаем на первую
        setSelId((cur) =>
          cur && list.some((b) => b.id === cur) ? cur : (list[0]?.id ?? null),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!selId) {
      setDocs([]);
      return;
    }
    void kbDocuments(selId)
      .then(setDocs)
      .catch(() => {});
  }, [selId]);

  const create = () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    void kbCreate(n)
      .then((id) => {
        setName("");
        refresh();
        setSelId(id);
      })
      .catch((e) => window.alert(String(e)))
      .finally(() => setBusy(false));
  };

  const removeBase = (id: string) => {
    if (busy || !window.confirm(t("kb.deleteConfirm"))) return;
    if (attachedKbId === id) onAttach(null);
    setBusy(true);
    void kbDelete(id)
      .then(() => {
        refresh();
        if (selId === id) setSelId(null);
      })
      .catch((e) => window.alert(String(e)))
      .finally(() => setBusy(false));
  };

  const addDocs = () => {
    if (!selId || busy) return;
    setBusy(true);
    void pickDocFiles()
      .then(async (paths) => {
        for (const p of paths) {
          try {
            await kbAddDocument(selId, p);
          } catch (e) {
            // Часть файлов может не распарситься — остальные индексируем
            window.alert(`${p}\n${e}`);
          }
        }
        refresh();
        return kbDocuments(selId)
          .then(setDocs)
          .catch(() => {});
      })
      .finally(() => setBusy(false));
  };

  const removeDoc = (docId: number) => {
    if (!selId || busy) return;
    setBusy(true);
    void kbRemoveDocument(selId, docId)
      .then(() =>
        kbDocuments(selId)
          .then(setDocs)
          .catch(() => {}),
      )
      .catch((e) => window.alert(String(e)))
      .finally(() => setBusy(false));
  };

  if (!show) return null;

  const attached = selId !== null && attachedKbId === selId;

  return (
    <div
      className={`fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm ${open ? "anim-fade" : "anim-fade-out"}`}
      onClick={onClose}
    >
      <div
        className={`glass-pane mx-auto my-8 w-full max-w-4xl rounded-2xl border border-halo-line bg-halo-deep p-6 shadow-2xl ${open ? "anim-pop" : "anim-pop-out"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="mb-1 flex items-start justify-between">
          <h1 className="text-2xl font-bold text-halo-text">{t("kb.title")}</h1>
          <button
            onClick={onClose}
            title={t("common.close")}
            className="rounded-md p-1.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-halo-muted">{t("kb.hint")}</p>

        <div className="flex flex-col gap-4 md:flex-row">
          {/* Список баз + создание */}
          <div className="w-full shrink-0 md:w-64">
            <div className="mb-2 flex gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
                }}
                placeholder={t("kb.namePh")}
                className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
              <button
                onClick={create}
                disabled={busy || name.trim() === ""}
                title={t("kb.create")}
                className="rounded-lg bg-halo-accent px-2.5 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:opacity-40"
              >
                +
              </button>
            </div>
            <div className="scroll-slim max-h-72 space-y-1 overflow-y-auto">
              {bases.length === 0 && (
                <p className="rounded-lg border border-dashed border-halo-line px-3 py-4 text-center text-xs text-halo-muted">
                  {t("kb.empty")}
                </p>
              )}
              {bases.map((b) => (
                <div
                  key={b.id}
                  className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    selId === b.id
                      ? "border-halo-accent/50 bg-halo-accent/10 text-halo-text"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  <button
                    onClick={() => setSelId(b.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate font-medium">{b.name}</span>
                    <span className="text-[10px] text-halo-muted/70">
                      {b.docs} · {b.chunks} {t("kb.chunksLabel")}
                    </span>
                  </button>
                  <button
                    onClick={() => removeBase(b.id)}
                    title={t("kb.deleteBase")}
                    className="shrink-0 rounded p-1 text-halo-muted/60 transition-colors hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Выбранная база: привязка + документы */}
          <div className="min-w-0 flex-1 rounded-xl border border-halo-line/70 bg-halo-surface/30 p-3">
            {selId === null ? (
              <p className="py-8 text-center text-xs text-halo-muted/60">
                {t("kb.empty")}
              </p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => onAttach(attached ? null : selId)}
                    disabled={!hasActiveChat}
                    title={!hasActiveChat ? t("kb.needChat") : undefined}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                      attached
                        ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                        : "border-halo-line text-halo-muted hover:text-halo-text"
                    }`}
                  >
                    {attached ? t("kb.attached") : t("kb.attach")}
                  </button>
                  <button
                    onClick={addDocs}
                    disabled={busy}
                    className="rounded-lg border border-halo-line px-2.5 py-1 text-xs text-halo-muted transition-colors hover:text-halo-text disabled:opacity-40"
                  >
                    {t("kb.addDocs")}
                  </button>
                </div>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-halo-muted/60">
                  {t("kb.docs")}
                </p>
                <div className="scroll-slim max-h-80 space-y-1 overflow-y-auto">
                  {docs.length === 0 && (
                    <p className="py-6 text-center text-xs text-halo-muted/60">
                      {t("kb.docsEmpty")}
                    </p>
                  )}
                  {docs.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center gap-2 rounded-lg border border-halo-line/60 bg-halo-deep/40 px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-halo-text" title={d.path}>
                        {d.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-halo-muted/70">
                        {d.chunks} {t("kb.chunksLabel")}
                      </span>
                      <button
                        onClick={() => removeDoc(d.id)}
                        title={t("kb.removeDoc")}
                        className="shrink-0 rounded p-0.5 text-halo-muted/60 transition-colors hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
