import { useState } from "react";
import { useLang } from "../../locales";
import type { PromptPreset } from "../../presets";
import type { JailbreakEntry } from "../../jailbreaks";
import { MiniPencilIcon, MiniTrashIcon } from "./parts";
import { JailbreaksCard } from "./JailbreaksCard";

export function AgentSection({
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
                  className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-red-400/50 hover:text-red-400"
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
                    <code className="scroll-slim min-w-0 flex-1 break-all font-mono text-[0.6875rem] leading-relaxed text-halo-muted">
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

/** Библиотека системных промтов: свои роли для быстрых вызовов */
export function PromptsSection({
  library,
  onChangeLibrary,
  jailbreaks,
  onChangeJailbreaks,
  onApplyJailbreak,
}: {
  library: PromptPreset[];
  onChangeLibrary: (list: PromptPreset[]) => void;
  jailbreaks: JailbreakEntry[];
  onChangeJailbreaks: (list: JailbreakEntry[]) => void;
  onApplyJailbreak: (entry: JailbreakEntry) => void;
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
                  className="rounded-lg bg-halo-accent px-3 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
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
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("prompts.add")}
          </button>
        </div>
      </div>

      <JailbreaksCard
        entries={jailbreaks}
        onChange={onChangeJailbreaks}
        onApply={onApplyJailbreak}
      />
    </div>
  );
}

