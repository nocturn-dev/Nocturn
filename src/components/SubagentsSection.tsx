/** Раздел «Субагенты»: тумблер, лимит параллельности, редактор ролей (M3) */
import { useState } from "react";
import { useLang } from "../locales";
import { mergeRoles, type SubagentRole, type SubagentsConfig } from "../subagents";
import { MiniTrashIcon, ToggleRow } from "./SettingsModal";

export default function SubagentsSection({
  config,
  onChange,
  pluginIds,
}: {
  config: SubagentsConfig;
  onChange: (c: SubagentsConfig) => void;
  /** id ролей, приходящих из плагинов (только просмотр) */
  pluginIds?: Set<string>;
}) {
  const { t, lang } = useLang();
  const [editing, setEditing] = useState<string | null>(null);
  const roles = mergeRoles(config.roles);
  const storedIds = new Set(config.roles.map((r) => r.id));
  const builtinIds = new Set(["researcher", "coder", "critic", "librarian"]);

  const updateRole = (next: SubagentRole) => {
    onChange({
      ...config,
      roles: config.roles.some((r) => r.id === next.id)
        ? config.roles.map((r) => (r.id === next.id ? next : r))
        : [...config.roles, next],
    });
  };

  const addRole = () => {
    const id = `custom-${Date.now().toString(36)}`;
    onChange({
      ...config,
      roles: [
        ...config.roles,
        {
          id,
          name: "New role",
          desc: { ru: "Своя роль", en: "Custom role" },
          systemPrompt: "Ты — субагент. ",
          tools: null,
          maxSteps: 8,
        },
      ],
    });
    setEditing(id);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.subagents")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("sub.desc")}
      </p>

      <div className="space-y-1.5">
        <ToggleRow
          label={t("sub.enabled")}
          on={config.enabled}
          onChange={(v) => onChange({ ...config, enabled: v })}
        />
        {config.enabled && (
          <>
            {/* Автономность: выключена — каждый запуск субагента подтверждается */}
            <ToggleRow
              label={t("sub.autonomous")}
              on={config.autonomous}
              onChange={(v) => onChange({ ...config, autonomous: v })}
            />
            <div className="flex items-center gap-3 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
              <span className="min-w-0 flex-1 text-xs text-halo-muted">
                {t("sub.maxParallel")}
              </span>
              <input
                type="number"
                min={1}
                max={6}
                value={config.maxParallel}
                onChange={(e) =>
                  onChange({
                    ...config,
                    maxParallel: Math.max(1, Math.min(6, Number(e.target.value) || 1)),
                  })
                }
                className="w-16 shrink-0 rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none focus:border-halo-accent/60"
              />
            </div>
          </>
        )}
      </div>

      {config.enabled && (
        <>
          <p className="mb-2 mt-5 text-xs font-medium text-halo-muted">
            {t("sub.roles")}
          </p>
          <div className="space-y-1.5">
            {roles.map((r) => {
              const isEditing = editing === r.id;
              const isCustom = storedIds.has(r.id) && !builtinIds.has(r.id);
              return (
                <div
                  key={r.id}
                  className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[11px] text-halo-accent">
                      {r.id}
                    </code>
                    <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                      {lang === "ru" ? r.desc?.ru ?? "" : r.desc?.en ?? ""}
                    </span>
                    {storedIds.has(r.id) && (
                      <span className="shrink-0 text-[10px] text-halo-muted/60">
                        {t("sub.edited")}
                      </span>
                    )}
                    {pluginIds?.has(r.id) ? (
                      <span className="shrink-0 text-[10px] text-halo-muted/50">
                        {t("sub.fromPlugin")}
                      </span>
                    ) : (
                      <button
                        onClick={() => setEditing(isEditing ? null : r.id)}
                        className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[10px] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent"
                      >
                        {isEditing ? t("sub.close") : t("sub.edit")}
                      </button>
                    )}
                    {isCustom && (
                      <button
                        onClick={() =>
                          onChange({
                            ...config,
                            roles: config.roles.filter((x) => x.id !== r.id),
                          })
                        }
                        title={t("sub.delete")}
                        className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
                      >
                        <MiniTrashIcon />
                      </button>
                    )}
                  </div>

                  {isEditing && (
                    <div className="mt-2.5 space-y-2">
                      <div className="grid grid-cols-[1fr_7rem_5rem] gap-2">
                        <input
                          type="text"
                          value={r.name}
                          onChange={(e) => updateRole({ ...r, name: e.target.value })}
                          placeholder={t("sub.name")}
                          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 text-xs text-halo-text outline-none focus:border-halo-accent/60"
                        />
                        <input
                          type="text"
                          value={r.model ?? ""}
                          onChange={(e) =>
                            updateRole({ ...r, model: e.target.value || undefined })
                          }
                          placeholder={t("sub.model")}
                          title={t("sub.modelHint")}
                          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[11px] text-halo-text outline-none focus:border-halo-accent/60"
                        />
                        <input
                          type="number"
                          min={1}
                          max={25}
                          value={r.maxSteps}
                          onChange={(e) =>
                            updateRole({
                              ...r,
                              maxSteps: Math.max(1, Math.min(25, Number(e.target.value) || 1)),
                            })
                          }
                          title={t("sub.maxSteps")}
                          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none focus:border-halo-accent/60"
                        />
                      </div>
                      <input
                        type="text"
                        value={r.tools === null ? "" : r.tools.join(", ")}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          updateRole({
                            ...r,
                            tools:
                              raw === ""
                                ? null
                                : raw.split(/\s*,\s*/).filter(Boolean),
                          });
                        }}
                        placeholder={t("sub.tools")}
                        title={t("sub.toolsHint")}
                        className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[11px] text-halo-text outline-none focus:border-halo-accent/60"
                      />
                      <textarea
                        value={r.systemPrompt}
                        onChange={(e) => updateRole({ ...r, systemPrompt: e.target.value })}
                        rows={4}
                        placeholder={t("sub.prompt")}
                        className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 font-mono text-[11px] leading-relaxed text-halo-text outline-none focus:border-halo-accent/60"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <button
              onClick={addRole}
              className="text-xs text-halo-muted transition-colors hover:text-halo-accent"
            >
              + {t("sub.addRole")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
