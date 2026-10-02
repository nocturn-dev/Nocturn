import { useState, type ReactNode } from "react";
import { useLang } from "../../locales";
import {
  builtinJailbreaksFor,
  JB_REASONING_LABEL_KEYS,
  JB_REASONING_LEVELS,
  type JbReasoning,
  type JailbreakEntry,
} from "../../jailbreaks";
import { Dropdown, MiniPencilIcon, MiniTrashIcon } from "./parts";

/** Чип мета-данных записи (модель / уровень мышления) */
function JbChip({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-halo-surface/80 px-1.5 py-0.5 font-mono text-[0.625rem] leading-4 text-halo-muted">
      {children}
    </span>
  );
}

/** Карточка «Джейлбрейки» в разделе «Промпты»: свои записи (название /
 * модель / текст / уровень мышления) + встроенные пресеты-образцы.
 * Применение — только явной кнопкой: запись ДОБАВЛЯЕТСЯ к системному
 * промту задачи (см. appendJailbreak), ничего не отправляет сама. */
export function JailbreaksCard({
  entries,
  onChange,
  onApply,
}: {
  entries: JailbreakEntry[];
  onChange: (list: JailbreakEntry[]) => void;
  onApply: (entry: JailbreakEntry) => void;
}) {
  const { t, lang } = useLang();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<JbReasoning>("any");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editReasoning, setEditReasoning] = useState<JbReasoning>("any");
  const [editText, setEditText] = useState("");

  const reasoningOptions = JB_REASONING_LEVELS.map((lvl) => ({
    value: lvl,
    label: t(JB_REASONING_LABEL_KEYS[lvl]),
  }));

  const modelChip = (m: string) => (m && m !== "*" ? m : t("jb.modelAny"));

  const add = () => {
    if (!name.trim() || !text.trim()) return;
    const now = Date.now();
    onChange([
      ...entries,
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        model: model.trim(),
        text: text.trim(),
        reasoning,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    setName("");
    setModel("");
    setReasoning("any");
    setText("");
  };

  const startEdit = (e: JailbreakEntry) => {
    setEditingId(e.id);
    setEditName(e.name);
    setEditModel(e.model);
    setEditReasoning(e.reasoning);
    setEditText(e.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const n = editName.trim();
    const tx = editText.trim();
    if (!n || !tx) return;
    onChange(
      entries.map((e) =>
        e.id === editingId
          ? {
              ...e,
              name: n,
              model: editModel.trim(),
              text: tx,
              reasoning: editReasoning,
              updatedAt: Date.now(),
            }
          : e,
      ),
    );
    setEditingId(null);
  };

  const builtins = builtinJailbreaksFor(lang);

  const copyBuiltin = (b: JailbreakEntry) => {
    const now = Date.now();
    onChange([
      ...entries,
      {
        ...b,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    ]);
  };

  const entryRow = (e: JailbreakEntry, builtin: boolean) =>
    editingId === e.id ? (
      <div
        key={e.id}
        className="space-y-2 rounded-lg border border-halo-accent/50 bg-halo-surface/50 p-2.5"
      >
        <div className="flex gap-2">
          <input
            autoFocus
            value={editName}
            onChange={(ev) => setEditName(ev.target.value)}
            placeholder={t("jb.namePh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors focus:border-halo-accent/60"
          />
          <input
            value={editModel}
            onChange={(ev) => setEditModel(ev.target.value)}
            placeholder={t("jb.modelPh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors focus:border-halo-accent/60"
          />
        </div>
        <Dropdown
          value={editReasoning}
          options={reasoningOptions}
          onSelect={(v) => setEditReasoning(v as JbReasoning)}
        />
        <textarea
          value={editText}
          onChange={(ev) => setEditText(ev.target.value)}
          rows={6}
          placeholder={t("jb.textPh")}
          className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-sm leading-relaxed text-halo-text outline-none transition-colors focus:border-halo-accent/60"
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
        key={e.id}
        className="group flex items-start gap-2.5 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-halo-text">{e.name}</p>
            <JbChip>{modelChip(e.model)}</JbChip>
            <JbChip>{t(JB_REASONING_LABEL_KEYS[e.reasoning])}</JbChip>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-halo-muted">
            {e.text}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-0.5">
          {builtin ? (
            <button
              onClick={() => copyBuiltin(e)}
              title={t("jb.builtinCopy")}
              className="rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
            >
              {t("jb.builtinCopy")}
            </button>
          ) : (
            <>
              <button
                onClick={() => onApply(e)}
                title={t("jb.apply")}
                className="rounded-md border border-halo-line px-2 py-1 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-text"
              >
                {t("jb.apply")}
              </button>
              <button
                onClick={() => startEdit(e)}
                title={t("prompts.edit")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
              >
                <MiniPencilIcon />
              </button>
              <button
                onClick={() => onChange(entries.filter((x) => x.id !== e.id))}
                title={t("prompts.deleteTitle")}
                className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="mt-6">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("jb.title")}
      </h3>
      <p className="mb-3 text-xs leading-relaxed text-halo-muted">
        {t("jb.desc")}
      </p>

      {/* Встроенные пресеты-образцы: только копирование, не редактируются */}
      <p className="mb-2 text-xs font-medium text-halo-muted">
        {t("jb.builtinTitle")}
      </p>
      <div className="mb-4 space-y-2">
        {builtins.map((b) => entryRow(b, true))}
      </div>

      <p className="mb-2 text-xs font-medium text-halo-muted">
        {t("jb.ownTitle")}
      </p>
      <div className="mb-4 space-y-2">
        {entries.length === 0 && (
          <p className="rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-3 text-center text-xs text-halo-muted">
            {t("jb.empty")}
          </p>
        )}
        {entries.map((e) => entryRow(e, false))}
      </div>

      <div className="space-y-2 rounded-xl border border-halo-line p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("jb.namePh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t("jb.modelPh")}
            className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 text-sm text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
          />
        </div>
        <Dropdown
          value={reasoning}
          options={reasoningOptions}
          onSelect={(v) => setReasoning(v as JbReasoning)}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={t("jb.textPh")}
          className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-3 py-2.5 font-mono text-sm leading-relaxed text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
        />
        <div className="flex justify-end">
          <button
            onClick={add}
            disabled={!name.trim() || !text.trim()}
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("jb.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
