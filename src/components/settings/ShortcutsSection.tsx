import { useEffect, useState } from "react";
import { useLang, type MsgKey } from "../../locales";
import { SHORTCUT_ACTIONS, SHORTCUT_LABEL_KEYS, comboFromEvent, type ShortcutAction, type CustomShortcut, type ShortcutBinds } from "../../shortcuts";
import { Dropdown, MiniTrashIcon } from "./parts";

export function ShortcutsSection({
  binds,
  onChange,
  custom,
  onCustomChange,
  availableCommands,
}: {
  binds: ShortcutBinds;
  onChange: (b: ShortcutBinds) => void;
  custom: CustomShortcut[];
  onCustomChange: (c: CustomShortcut[]) => void;
  availableCommands: { name: string; desc: string; argHint?: string }[];
}) {
  const { t } = useLang();
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // Форма своего хоткея
  const [addOpen, setAddOpen] = useState(false);
  const [cmdName, setCmdName] = useState("");
  const [cmdArg, setCmdArg] = useState("");
  const [customCombo, setCustomCombo] = useState("");

  // Запись комбинации: и для встроенных действий, и для нового хоткея.
  // recording === "@new" — пишем комбо для добавляемого хоткея.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setConflict(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const clash =
        SHORTCUT_ACTIONS.find((a) => a !== recording && binds[a] === combo) ??
        custom.find((c) => c.id !== recording && c.combo === combo);
      if (clash) {
        setConflict(combo);
        return;
      }
      if (recording === "@new") {
        setCustomCombo(combo);
      } else if ((SHORTCUT_ACTIONS as readonly string[]).includes(recording)) {
        onChange({ ...binds, [recording as ShortcutAction]: combo });
      } else {
        onCustomChange(
          custom.map((c) => (c.id === recording ? { ...c, combo } : c)),
        );
      }
      setRecording(null);
      setConflict(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, binds, custom, onChange, onCustomChange]);

  const addCustom = () => {
    const name = cmdName.trim().replace(/^\//, "");
    if (!name || !customCombo) return;
    onCustomChange([
      ...custom,
      {
        id: `sc-${Date.now().toString(36)}`,
        combo: customCombo,
        command: cmdArg.trim() ? `/${name} ${cmdArg.trim()}` : `/${name}`,
      },
    ]);
    setCmdName("");
    setCmdArg("");
    setCustomCombo("");
    setAddOpen(false);
  };

  const comboButton = (target: string, current: string) => (
    <button
      onClick={() => {
        setRecording(recording === target ? null : target);
        setConflict(null);
      }}
      className={`shrink-0 rounded-md border px-3 py-1 font-mono text-xs transition-colors ${
        recording === target
          ? "animate-pulse border-halo-accent text-halo-accent"
          : current
            ? "border-halo-line text-halo-muted hover:border-halo-accent/50 hover:text-halo-text"
            : "border-dashed border-halo-line text-halo-muted/60 hover:text-halo-text"
      }`}
    >
      {recording === target ? t("sc.press") : current || t("sc.unbound")}
    </button>
  );

  const selectedCmd = availableCommands.find((c) => c.name === cmdName);

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.shortcuts")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("sc.desc")}
      </p>

      <div className="space-y-1.5">
        {SHORTCUT_ACTIONS.map((action) => {
          const current = binds[action] ?? "";
          return (
            <div
              key={action}
              className="flex items-center gap-3 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-halo-text">
                {t(SHORTCUT_LABEL_KEYS[action] as MsgKey)}
              </span>
              {comboButton(action, current)}
              {current && (
                <button
                  onClick={() => onChange({ ...binds, [action]: "" })}
                  title={t("sc.clear")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Свои хоткеи: комбо → slash-команда */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-halo-muted">{t("sc.custom")}</p>
          {!addOpen && (
            <button
              onClick={() => setAddOpen(true)}
              className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
            >
              + {t("sc.addCustom")}
            </button>
          )}
        </div>

        {custom.length === 0 && !addOpen && (
          <p className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-4 text-center text-xs text-halo-muted">
            {t("sc.customEmpty")}
          </p>
        )}
        <div className="space-y-1.5">
          {custom.map((cs) => {
            const cmd = availableCommands.find(
              (c) => c.name === cs.command.replace(/^\//, "").split(/\s+/)[0],
            );
            return (
              <div
                key={cs.id}
                className="flex items-center gap-3 rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
              >
                <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[11px] text-halo-accent">
                  /{cs.command.replace(/^\//, "").split(/\s+/)[0]}
                </code>
                <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                  {cs.command.includes(" ") && cs.command.split(/\s+/).slice(1).join(" ")}
                  {cmd ? "" : ` — ${t("sc.unknownCmd")}`}
                </span>
                {comboButton(cs.id, cs.combo)}
                <button
                  onClick={() => onCustomChange(custom.filter((c) => c.id !== cs.id))}
                  title={t("sc.clear")}
                  className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                >
                  <MiniTrashIcon />
                </button>
              </div>
            );
          })}
        </div>

        {addOpen && (
          <div className="mt-2 space-y-2.5 rounded-xl border border-halo-line p-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                  {t("sc.cmdLabel")}
                </label>
              <Dropdown
                value={cmdName}
                options={[
                  { value: "", label: "—" },
                  ...availableCommands.map((c) => ({
                    value: c.name,
                    label: `/${c.name} — ${c.desc}`,
                  })),
                ]}
                onSelect={setCmdName}
                className="w-full"
              />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                  {t("sc.argLabel")}
                </label>
                <input
                  type="text"
                  value={cmdArg}
                  onChange={(e) => setCmdArg(e.target.value)}
                  disabled={!selectedCmd?.argHint}
                  placeholder={selectedCmd?.argHint || t("sc.noArg")}
                  className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60 disabled:opacity-40"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-halo-muted/70">
                {t("sc.comboLabel")}
              </label>
              <div className="flex items-center gap-2">
                {comboButton("@new", customCombo)}
                <span className="text-[11px] text-halo-muted/70">{t("sc.comboHint")}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAddOpen(false)}
                className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
              >
                {t("prompts.cancel")}
              </button>
              <button
                onClick={addCustom}
                disabled={!cmdName || !customCombo}
                className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("sc.addCustom")}
              </button>
            </div>
          </div>
        )}
      </div>

      {conflict && (
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-400">
          {t("sc.conflict", { combo: conflict })}
        </p>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-halo-muted/60">
        {t("sc.hint")}
      </p>
    </div>
  );
}

/** Раздел «Скилы»: каталог встроенных скилов (вызов — «&» в поле ввода) */
