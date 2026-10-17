import { useState } from "react";
import { useLang } from "../../locales";
import type { PromptPreset } from "../../presets";
import type { JailbreakEntry } from "../../jailbreaks";
import { MiniPencilIcon, MiniTrashIcon } from "./parts";
import { JailbreaksCard } from "./JailbreaksCard";

/** Библиотека системных промтов: свои роли для быстрых вызовов.
 *  Джейлбрейки — отдельная страница настроек, здесь рендерятся только
 *  когда showJailbreaks (.compat: старое цельное место) */
export function PromptsSection({
  library,
  onChangeLibrary,
  jailbreaks,
  onChangeJailbreaks,
  onApplyJailbreak,
  showJailbreaks = false,
}: {
  library: PromptPreset[];
  onChangeLibrary: (list: PromptPreset[]) => void;
  jailbreaks: JailbreakEntry[];
  onChangeJailbreaks: (list: JailbreakEntry[]) => void;
  onApplyJailbreak: (entry: JailbreakEntry) => "task" | "new";
  /** Рендер JailbreaksCard под библиотекой (историческое место) */
  showJailbreaks?: boolean;
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
                  className="rounded-lg bg-halo-accent px-3 py-1.5 text-sm font-medium text-halo-on-accent press hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("prompts.save")}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="press rounded-lg border border-halo-line px-3 py-1.5 text-sm text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
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
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent press hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("prompts.add")}
          </button>
        </div>
      </div>

      {showJailbreaks && (
        <JailbreaksCard
          entries={jailbreaks}
          onChange={onChangeJailbreaks}
          onApply={onApplyJailbreak}
        />
      )}
    </div>
  );
}

