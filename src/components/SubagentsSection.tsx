/** Раздел «Субагенты»: тумблер, лимит параллельности, редактор ролей */
import { useState } from "react";
import { pickBilingual, translate, useLang } from "../locales";
import {
  BUILTIN_ROLE_IDS,
  mergeRoles,
  type SubagentRole,
  type SubagentsConfig,
} from "../subagents";
import { MiniTrashIcon, Row, Segmented, ToggleRow } from "./settings/parts";

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

  // Черновики полей роли (tools/maxSteps) живут строкой до blur: раньше
  // контролируемое поле пересобиралось на каждый символ — запятая в списке
  // инструментов съедалась мгновенно, а очистка maxSteps мгновенно падала в 1.
  // Черновик один: редактируется максимум одна роль за раз
  const [toolsDraft, setToolsDraft] = useState<string | null>(null);
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);

  const commitTools = (r: SubagentRole, raw: string) => {
    setToolsDraft(null);
    const clean = raw.trim();
    const next = clean === "" ? null : clean.split(/\s*,\s*/).filter(Boolean);
    if (JSON.stringify(next) === JSON.stringify(r.tools)) return;
    updateRole({ ...r, tools: next });
  };

  const commitSteps = (r: SubagentRole, raw: string) => {
    setStepsDraft(null);
    // Пустое поле — отказ от правки, возвращаем прежнее значение: раньше
    // очистка мгновенно превращалась в 1
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const clamped = Math.max(1, Math.min(25, n));
    if (clamped === r.maxSteps) return;
    updateRole({ ...r, maxSteps: clamped });
  };

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
          name: t("sub.newRole"),
          // desc — двуязычные данные: собираю пару из словаря, чтобы zh/ja
          // не видели русскую заглушку новой роли
          desc: {
            ru: translate("ru", "sub.newRoleDesc"),
            en: translate("en", "sub.newRoleDesc"),
          },
          systemPrompt: t("sub.newRolePrompt"),
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

      {/* Поведение: одной карточкой — тумблеры и лимит параллельности */}
      <div className="rounded-xl border border-halo-line bg-halo-surface/40 px-3.5 py-2.5">
        <ToggleRow
          label={t("sub.enabled")}
          on={config.enabled}
          onChange={(v) => onChange({ ...config, enabled: v })}
        />
        {config.enabled && (
          <>
            {/* Автономность: выключена — каждый запуск субагента подтверждается */}
            <div className="mt-1.5">
              <ToggleRow
                label={t("sub.autonomous")}
                on={config.autonomous}
                onChange={(v) => onChange({ ...config, autonomous: v })}
              />
            </div>
            <div className="mt-2.5 border-t border-halo-line/60 pt-3">
              <Row
                label={t("sub.maxParallel")}
                desc={t("sub.maxParallelHint")}
                // Чипы 1-6 вместо числового поля: жёсткий потолок виден глазами,
                // промахнуться мимо него нельзя — normalize в subagents.ts режет всё > 6
                extra={
                  <Segmented
                    value={String(config.maxParallel)}
                    onChange={(v) => onChange({ ...config, maxParallel: Number(v) })}
                    options={[1, 2, 3, 4, 5, 6].map((n) => ({
                      value: String(n),
                      label: String(n),
                    }))}
                  />
                }
              />
            </div>
          </>
        )}
      </div>

      {config.enabled && (
        <>
          <p className="mb-2 mt-5 text-xs font-medium uppercase tracking-wider text-halo-muted/60">
            {t("sub.roles")}
          </p>
          <div className="space-y-2">
            {roles.map((r) => {
              const isEditing = editing === r.id;
              const isCustom = storedIds.has(r.id) && !BUILTIN_ROLE_IDS.has(r.id);
              return (
                <div
                  key={r.id}
                  className={`rounded-xl border px-3.5 py-3 transition-colors ${
                    isEditing
                      ? "border-halo-accent/40 bg-halo-surface/70"
                      : "border-halo-line bg-halo-surface/50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="shrink-0 rounded-md bg-halo-muted/10 px-2 py-0.5 font-mono text-[0.6875rem] text-halo-accent">
                      {r.id}
                    </code>
                    {storedIds.has(r.id) && (
                      <span className="shrink-0 rounded bg-halo-accent/10 px-1.5 py-0.5 text-[0.625rem] text-halo-accent">
                        {t("sub.edited")}
                      </span>
                    )}
                    {pluginIds?.has(r.id) && (
                      <span className="shrink-0 rounded bg-halo-surface/70 px-1.5 py-0.5 text-[0.625rem] text-halo-muted">
                        {t("sub.fromPlugin")}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 basis-48 truncate text-xs leading-relaxed text-halo-muted">
                      {pickBilingual(r.desc, lang)}
                    </span>
                    {/* Превью plugin-роли без редактора: набор инструментов
                        должен быть виден до установки плагина — роль с пустым
                        allowlist получает только инструменты чтения */}
                    {pluginIds?.has(r.id) && (
                      <span className="max-w-56 shrink-0 truncate font-mono text-[0.625rem] text-halo-muted/70" title={r.tools?.join(", ") ?? t("sub.toolsReadOnly")}>
                        {r.tools && r.tools.length > 0 ? r.tools.join(", ") : t("sub.toolsReadOnly")}
                      </span>
                    )}
                    {pluginIds?.has(r.id) ? null : (
                      <button
                        onClick={() => setEditing(isEditing ? null : r.id)}
                        className="shrink-0 rounded-md border border-halo-line px-2 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent"
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
                          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[0.6875rem] text-halo-text outline-none focus:border-halo-accent/60"
                        />
                        <input
                          type="number"
                          min={1}
                          max={25}
                          value={stepsDraft !== null && editing === r.id ? stepsDraft : String(r.maxSteps)}
                          onChange={(e) => setStepsDraft(e.target.value)}
                          onBlur={(e) => commitSteps(r, e.target.value)}
                          onKeyDown={(e) => {
                            // Enter коммитит черновик; IME-энтер — только закрытие состава
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                              e.currentTarget.blur();
                            }
                          }}
                          title={t("sub.maxSteps")}
                          className="w-full rounded-lg border border-halo-line bg-halo-surface px-2 py-1.5 text-center text-xs text-halo-text outline-none focus:border-halo-accent/60"
                        />
                      </div>
                      <input
                        type="text"
                        value={toolsDraft !== null && editing === r.id ? toolsDraft : r.tools === null ? "" : r.tools.join(", ")}
                        onChange={(e) => setToolsDraft(e.target.value)}
                        onBlur={(e) => commitTools(r, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder={t("sub.tools")}
                        title={t("sub.toolsHint")}
                        className="w-full rounded-lg border border-halo-line bg-halo-surface px-2.5 py-1.5 font-mono text-[0.6875rem] text-halo-text outline-none focus:border-halo-accent/60"
                      />
                      <textarea
                        value={r.systemPrompt}
                        onChange={(e) => updateRole({ ...r, systemPrompt: e.target.value })}
                        rows={4}
                        placeholder={t("sub.prompt")}
                        className="scroll-slim w-full resize-none rounded-lg border border-halo-line bg-halo-surface px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-halo-text outline-none focus:border-halo-accent/60"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button
            onClick={addRole}
            className="mt-3 w-full rounded-xl border border-dashed border-halo-line px-3 py-2.5 text-xs text-halo-muted transition-colors hover:border-halo-accent/50 hover:text-halo-accent"
          >
            + {t("sub.addRole")}
          </button>
        </>
      )}
    </div>
  );
}
