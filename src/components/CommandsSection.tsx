/** Раздел «Команды»: пользовательские slash-команды (commands.json) */
import { useEffect, useState } from "react";
import { useLang } from "../locales";
import { commandsLoad, commandsSave, type UserCommand } from "../api";
import { MiniTrashIcon } from "./settings/parts";
import { BUILTIN_COMMANDS } from "../commands";

export default function CommandsSection() {
  const { t } = useLang();
  const [commands, setCommands] = useState<UserCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Форма добавления/редактирования
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("");

  useEffect(() => {
    commandsLoad()
      .then(setCommands)
      .catch(() => {});
  }, []);

  const persist = (next: UserCommand[]) => {
    setCommands(next);
    commandsSave(next).catch((e) => setError(String(e)));
  };

  const startNew = () => {
    setName("");
    setDescription("");
    setTemplate(t("commands.blankTemplate"));
    setEditing("new");
  };

  const startEdit = (idx: number) => {
    const c = commands[idx];
    if (!c) return;
    setName(c.name);
    setDescription(c.description);
    setTemplate(c.template);
    setEditing(idx);
  };

  const save = () => {
    const n = name.trim().replace(/^\//, "").replace(/\s+/g, "-").toLowerCase();
    if (!n || !template.trim()) return;
    const entry: UserCommand = {
      name: n,
      description: description.trim(),
      template: template,
    };
    const next =
      typeof editing === "number"
        ? commands.map((c, i) => (i === editing ? entry : c))
        : [...commands.filter((c) => c.name !== n), entry];
    persist(next);
    setEditing(null);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.commands")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("cmds.desc")}
      </p>

      <div className="space-y-1.5">
        {commands.length === 0 && editing === null && (
          <p className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-6 text-center text-xs text-halo-muted">
            {t("cmds.empty")}
          </p>
        )}
        {commands.map((c, i) => (
          <div
            key={c.name + i}
            className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold text-halo-accent">
                /{c.name}
              </code>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {c.description}
              </span>
              <button
                onClick={() => (editing === i ? setEditing(null) : startEdit(i))}
                className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent"
              >
                {editing === i ? t("cmds.close") : t("cmds.edit")}
              </button>
              <button
                onClick={() => persist(commands.filter((_, j) => j !== i))}
                title={t("cmds.delete")}
                className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </div>
            {editing === i && (
              <div className="mt-2.5 space-y-2">
                <FormFields
                  name={name}
                  description={description}
                  template={template}
                  onName={setName}
                  onDescription={setDescription}
                  onTemplate={setTemplate}
                />
                <div className="flex justify-end">
                  <button
                    onClick={save}
                    disabled={!name.trim() || !template.trim()}
                    className="rounded-lg bg-halo-accent px-3 py-1.5 text-xs font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:opacity-40"
                  >
                    {t("cmds.save")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing === "new" && (
        <div className="mt-3 space-y-2 rounded-xl border border-halo-line p-3">
          <FormFields
            name={name}
            description={description}
            template={template}
            onName={setName}
            onDescription={setDescription}
            onTemplate={setTemplate}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("prompts.cancel")}
            </button>
            <button
              onClick={save}
              disabled={!name.trim() || !template.trim()}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent transition-colors hover:bg-halo-accent-deep disabled:opacity-40"
            >
              {t("cmds.add")}
            </button>
          </div>
        </div>
      )}

      {editing === null && (
        <div className="mt-3">
          <button
            onClick={startNew}
            className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
          >
            + {t("cmds.new")}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {/* Встроенные команды: только просмотр, перекрываются своими по имени */}
      <p className="mb-2 mt-5 text-xs font-medium text-halo-muted">
        {t("cmds.builtin")}
      </p>
      <div className="space-y-1">
        {BUILTIN_COMMANDS.map((bc) => {
          const overridden = commands.some((c) => c.name === bc.name);
          return (
            <div
              key={bc.name}
              className="flex items-center gap-2 rounded-lg border border-halo-line/60 bg-halo-surface/30 px-3 py-1.5"
            >
              <code className={`shrink-0 font-mono text-[0.6875rem] ${overridden ? "text-halo-muted/40 line-through" : "text-halo-muted"}`}>
                /{bc.name}
              </code>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted/70">
                {bc.description}
              </span>
              {overridden && (
                <span className="shrink-0 text-[0.625rem] text-halo-muted/50">
                  {t("cmds.overridden")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[0.625rem] leading-relaxed text-halo-muted/60">
        {t("cmds.builtinHint")}
      </p>
    </div>
  );
}

function FormFields({
  name,
  description,
  template,
  onName,
  onDescription,
  onTemplate,
}: {
  name: string;
  description: string;
  template: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onTemplate: (v: string) => void;
}) {
  const { t } = useLang();
  return (
    <>
      <div className="grid grid-cols-[10rem_1fr] gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={t("cmds.name")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-xs text-halo-text outline-none focus:border-halo-accent/60"
        />
        <input
          type="text"
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          placeholder={t("cmds.description")}
          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none focus:border-halo-accent/60"
        />
      </div>
      <textarea
        value={template}
        onChange={(e) => onTemplate(e.target.value)}
        rows={5}
        placeholder={t("cmds.template")}
        className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-halo-text outline-none focus:border-halo-accent/60"
      />
      <p className="text-[0.625rem] leading-relaxed text-halo-muted/70">
        {t("cmds.hint")}
      </p>
    </>
  );
}
