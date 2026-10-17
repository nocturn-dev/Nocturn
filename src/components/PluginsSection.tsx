/** Раздел «Плагины»: импорт бандлов (plugin.json) с командами/скилами/ролями */
import { useState } from "react";
import { useLang } from "../locales";
import {
  HOOK_EVENTS,
  hooksSave,
  mcpSaveServers,
  mcpListServers,
  mcpDisconnect,
  pluginRead,
  pluginsSave,
  hooksLoad,
  chatExportWrite,
  pickSaveFile,
  type Hook,
  type HookEvent,
  type McpServerCfg,
  type Plugin,
  type PluginPackFile,
} from "../api";
import { MiniTrashIcon } from "./settings/parts";

/** Значения env/headers — только пары строк: другой тип из чужого файла
 *  конфигурации исполняемому серверу не нужен */
const strRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Санитизация хука из чужого файла: команда/событие проверяются, id
 *  выдаётся заново при установке (чужой файл не диктует ключи hooks.json) */
const sanitizeHook = (raw: unknown): Hook | null => {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Partial<Hook>;
  if (typeof h.command !== "string" || !h.command.trim()) return null;
  if (!HOOK_EVENTS.includes(h.event as HookEvent)) return null;
  return {
    id: "",
    event: h.event as HookEvent,
    matcher: typeof h.matcher === "string" ? h.matcher : "",
    command: h.command,
    timeout:
      typeof h.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0
        ? h.timeout
        : 15,
    enabled: true,
  };
};

/** Санитизация MCP-сервера из чужого файла: stdio без command и удалённый
 *  без url — заведомо нерабочие записи, до предпросмотра не доходят */
const sanitizeMcp = (raw: unknown): McpServerCfg | null => {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name.trim()) return null;
  const transport = typeof s.transport === "string" ? s.transport : undefined;
  const remote = transport === "http" || transport === "sse";
  if (remote ? typeof s.url !== "string" : typeof s.command !== "string") return null;
  const cfg: McpServerCfg = {
    name: s.name,
    command: typeof s.command === "string" ? s.command : "",
    args: Array.isArray(s.args)
      ? s.args.filter((a): a is string => typeof a === "string")
      : [],
    env: strRecord(s.env) ?? {},
    // Ставится выключенным: подключает пользователь после предпросмотра
    enabled: false,
  };
  if (remote) {
    cfg.transport = transport;
    cfg.url = s.url as string;
    const headers = strRecord(s.headers);
    if (headers) cfg.headers = headers;
    if (s.auth === "oauth") cfg.auth = "oauth";
    if (typeof s.client_id === "string") cfg.client_id = s.client_id;
    if (typeof s.oauth_scope === "string") cfg.oauth_scope = s.oauth_scope;
  }
  return cfg;
};

/** Исполняемая часть манифеста (хуки/MCP): собирается отдельно от плагина —
 *  в объект плагина она не копируется, ставится только после подтверждения */
const collectExecutable = (
  raw: unknown,
  hooks: Hook[],
  mcp: McpServerCfg[],
): void => {
  if (!raw || typeof raw !== "object") return;
  const m = raw as Record<string, unknown>;
  if (Array.isArray(m.hooks)) {
    for (const h of m.hooks) {
      const s = sanitizeHook(h);
      if (s) hooks.push(s);
    }
  }
  if (Array.isArray(m.mcpServers)) {
    for (const srv of m.mcpServers) {
      const s = sanitizeMcp(srv);
      if (s) mcp.push(s);
    }
  }
};

/** Белый список полей плагина: из чужого plugin.json переносится только
 *  известное — неизвестные/исполняемые поля до plugins.json не доезжают */
const sanitizePlugin = (raw: unknown): Plugin | null => {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name.trim()) return null;
  const cmd = (v: unknown): Plugin["commands"] =>
    Array.isArray(v)
      ? v
          .filter(
            (c): c is Record<string, unknown> =>
              !!c && typeof c === "object" &&
              typeof (c as { name?: unknown }).name === "string" &&
              typeof (c as { template?: unknown }).template === "string",
          )
          .map((c) => ({
            name: c.name as string,
            description:
              typeof c.description === "string" ? c.description : "",
            template: c.template as string,
          }))
      : [];
  const skills = (v: unknown): Plugin["skills"] =>
    Array.isArray(v)
      ? v
          .filter(
            (s): s is Record<string, unknown> =>
              !!s && typeof s === "object" &&
              typeof (s as { id?: unknown }).id === "string" &&
              typeof (s as { prompt?: unknown }).prompt === "string",
          )
          .map((s) => ({
            id: s.id as string,
            name: typeof s.name === "string" ? s.name : s.id as string,
            desc:
              !!s.desc && typeof s.desc === "object"
                ? (s.desc as Plugin["skills"][number]["desc"])
                : { ru: "", en: "" },
            prompt: s.prompt as string,
          }))
      : [];
  const roles = (v: unknown): Plugin["roles"] =>
    Array.isArray(v)
      ? v
          .filter(
            (r): r is Record<string, unknown> =>
              !!r && typeof r === "object" &&
              typeof (r as { id?: unknown }).id === "string" &&
              typeof (r as { systemPrompt?: unknown }).systemPrompt === "string",
          )
          .map((r) => ({
            id: r.id as string,
            name: typeof r.name === "string" ? r.name : r.id as string,
            systemPrompt: r.systemPrompt as string,
            tools: Array.isArray(r.tools)
              ? r.tools.filter((x): x is string => typeof x === "string")
              : null,
            maxSteps: typeof r.maxSteps === "number" ? r.maxSteps : 0,
          }))
      : [];
  return {
    name: m.name,
    version: typeof m.version === "string" ? m.version : "1.0.0",
    description: typeof m.description === "string" ? m.description : "",
    // Ставится выключенным: включает пользователь, увидев предпросмотр
    enabled: false,
    commands: cmd(m.commands),
    skills: skills(m.skills),
    roles: roles(m.roles),
  };
};

/** Всё, что собирается поставиться одним нажатием «Установить» */
interface PendingInstall {
  plugins: Plugin[];
  hooks: Hook[];
  mcp: McpServerCfg[];
  isPack: boolean;
}

export default function PluginsSection({
  plugins,
  onChange,
}: {
  plugins: Plugin[];
  onChange: (p: Plugin[]) => void;
}) {
  const { t } = useLang();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Предпросмотр: и одиночный манифест, и пак идут через одно подтверждение —
  // исполняемая конфигурация не ставится молча
  const [pending, setPending] = useState<PendingInstall | null>(null);

  const persist = (next: Plugin[]) => {
    onChange(next);
    pluginsSave(next).catch((e) => setError(String(e)));
  };

  // Экспорт всех установленных плагинов одним файлом-паком: шаринг
  // воркфлоу между машинами/пользователями без ручной пересборки
  const exportPack = async () => {
    try {
      setError(null);
      const path = await pickSaveFile("nocturn-plugin-pack.json", "json");
      if (!path) return;
      // Тип из api.ts связывает контракт файла пака с местом создания:
      // иначе рассинхрон shape'а не ловил компилятор
      const pack: PluginPackFile = { kind: "nocturn-plugin-pack", version: 1, plugins };
      await chatExportWrite(path, JSON.stringify(pack, null, 2));
    } catch (e) {
      setError(String(e));
    }
  };

  const pickAndRead = async () => {
    setError(null);
    setNotice(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "plugin.json", extensions: ["json"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const manifest = await pluginRead(picked);
      const isPack =
        (manifest as { kind?: string }).kind === "nocturn-plugin-pack" &&
        Array.isArray((manifest as { plugins?: unknown }).plugins);
      // И пак, и одиночный плагин — через один предпросмотр: раньше пакет
      // ставил все плагины сразу, минуя подтверждение
      const sanitized: Plugin[] = [];
      const hooks: Hook[] = [];
      const mcp: McpServerCfg[] = [];
      if (isPack) {
        for (const raw of (manifest as { plugins: unknown[] }).plugins) {
          const p = sanitizePlugin(raw);
          if (!p) continue;
          sanitized.push(p);
          // Хуки/MCP внутри записей пака — тоже исполняемое: предпросмотр
          // обязан их показать, объект плагина их не получает
          collectExecutable(raw, hooks, mcp);
        }
      } else {
        const p = sanitizePlugin(manifest);
        if (!p) {
          setError(t("plug.noName"));
          return;
        }
        sanitized.push(p);
        collectExecutable(manifest, hooks, mcp);
      }
      if (sanitized.length === 0) {
        setError(t("plug.noName"));
        return;
      }
      setPending({ plugins: sanitized, hooks, mcp, isPack });
    } catch (e) {
      setError(String(e));
    }
  };

  /** Хуки плагина в hooks.json: старые хуки этого плагина убираются по
   *  сохранённой связи, копии по содержимому не плодятся при переустановке.
   *  Возвращает id добавленных — они ложатся в plugin.hookIds */
  const installPluginHooks = async (
    pluginName: string,
    packHooks: Hook[],
  ): Promise<string[]> => {
    if (packHooks.length === 0) return [];
    const file = await hooksLoad();
    const existing = file.hooks ?? [];
    const oldIds = new Set(plugins.find((x) => x.name === pluginName)?.hookIds ?? []);
    const freshKeys = new Set(
      packHooks.map((h) => `${h.event}|${h.matcher}|${h.command}`),
    );
    const kept = existing.filter(
      (h) =>
        !oldIds.has(h.id) &&
        !freshKeys.has(`${h.event}|${h.matcher}|${h.command}`),
    );
    const added = packHooks.map((h) => ({
      ...h,
      id: `hook-${crypto.randomUUID()}`,
    }));
    await hooksSave({ hooks: [...kept, ...added] });
    return added.map((h) => h.id);
  };

  /** MCP-серверы плагина: перезапись существующего по имени. Возвращает
   *  имена записанных — они ложатся в plugin.mcpNames */
  const installPluginMcp = async (
    packMcp: McpServerCfg[],
    current: McpServerCfg[],
  ): Promise<string[]> => {
    if (packMcp.length === 0) return [];
    const merged = [...current];
    for (const srv of packMcp) {
      const i = merged.findIndex((m) => m.name === srv.name);
      if (i >= 0) merged[i] = srv;
      else merged.push(srv);
    }
    await mcpSaveServers(merged);
    return packMcp.map((s) => s.name);
  };

  const confirmInstall = async () => {
    if (!pending) return;
    try {
      setError(null);
      // Все подтверждения собираются ДО первой записи: раньше плагин уже
      // был установлен, пока пользователь отменял перезапись MCP, —
      // частичная установка выглядела полной
      if (pending.hooks.length + pending.mcp.length > 0) {
        if (!window.confirm(t("plug.execConfirm"))) return;
      }
      let currentServers: McpServerCfg[] = [];
      if (pending.mcp.length > 0) {
        currentServers = await mcpListServers();
        const overwritten = pending.mcp
          .filter((s) => currentServers.some((m) => m.name === s.name))
          .map((s) => s.name);
        if (
          overwritten.length > 0 &&
          !window.confirm(t("plug.mcpOverwrite", { names: overwritten.join(", ") }))
        ) {
          return;
        }
      }
      // Хуки пака ставятся одним набором и связываются с первым плагином
      // пака: дедуп по содержимому внутри не даст продублировать их
      const hookIds = await installPluginHooks(pending.plugins[0]!.name, pending.hooks);
      const mcpNames = await installPluginMcp(pending.mcp, currentServers);
      const merged = [...plugins];
      for (const p of pending.plugins) {
        const full: Plugin = {
          ...p,
          hookIds: p === pending.plugins[0] ? hookIds : [],
          mcpNames: p === pending.plugins[0] ? mcpNames : [],
        };
        const i = merged.findIndex((m) => m.name === full.name);
        if (i >= 0) merged[i] = full;
        else merged.push(full);
      }
      persist(merged);
      const parts = [t("plug.installDone")];
      if (pending.hooks.length > 0) {
        parts.push(t("plug.bringsHooks", { n: String(pending.hooks.length) }));
      }
      if (pending.mcp.length > 0) {
        parts.push(t("plug.bringsMcp", { n: String(pending.mcp.length) }));
      }
      setNotice(parts.join(" "));
      setPending(null);
    } catch (e) {
      setError(String(e));
    }
  };

  /** Выключение/включение плагина гасит/оживляет и его исполняемое: хуки
   *  и MCP-серверы плагина без этого продолжали работать после «выкл» */
  const togglePlugin = async (p: Plugin) => {
    const nextEnabled = !p.enabled;
    try {
      setError(null);
      if (p.hookIds && p.hookIds.length > 0) {
        const ids = new Set(p.hookIds);
        const file = await hooksLoad();
        await hooksSave({
          hooks: (file.hooks ?? []).map((h) =>
            ids.has(h.id) ? { ...h, enabled: nextEnabled } : h,
          ),
        });
      }
      if (p.mcpNames && p.mcpNames.length > 0) {
        const names = new Set(p.mcpNames);
        const current = await mcpListServers();
        await mcpSaveServers(
          current.map((s) => (names.has(s.name) ? { ...s, enabled: nextEnabled } : s)),
        );
      }
      persist(plugins.map((x) => (x.name === p.name ? { ...x, enabled: nextEnabled } : x)));
    } catch (e) {
      // Список плагинов не меняем: UI не показывает выключенный плагин,
      // чьё исполняемое на самом деле ещё живо
      setError(String(e));
    }
  };

  const uninstallPlugin = async (p: Plugin) => {
    try {
      setError(null);
      if (p.hookIds && p.hookIds.length > 0) {
        const ids = new Set(p.hookIds);
        const file = await hooksLoad();
        const kept = (file.hooks ?? []).filter((h) => !ids.has(h.id));
        if (kept.length !== (file.hooks ?? []).length) {
          await hooksSave({ hooks: kept });
        }
      }
      if (p.mcpNames && p.mcpNames.length > 0) {
        const names = new Set(p.mcpNames);
        const current = await mcpListServers();
        const kept = current.filter((s) => !names.has(s.name));
        if (kept.length !== current.length) {
          await mcpSaveServers(kept);
          for (const n of p.mcpNames) {
            void mcpDisconnect(n).catch(() => {});
          }
        }
      }
      persist(plugins.filter((x) => x.name !== p.name));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.plugins")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("plug.desc")}
      </p>

      {/* Действия — по схеме ZCode: при непустом списке тулбар сверху,
          при пустом обе кнопки живут внутри карточки-пустого-состояния */}
      {plugins.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void pickAndRead()}
            className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent press hover:bg-halo-accent-deep"
          >
            {t("plug.import")}
          </button>
          <button
            onClick={() => void exportPack()}
            className="press rounded-lg border border-halo-line px-3.5 py-1.5 text-sm text-halo-text transition-colors hover:border-halo-accent/60 hover:text-halo-accent"
          >
            {t("plug.exportPack")}
          </button>
        </div>
      )}

      {/* Предпросмотр перед установкой */}
      {pending && (
        <div className="mt-3 space-y-2 rounded-xl border border-halo-accent/40 p-3">
          {pending.isPack && (
            <p className="text-sm font-medium text-halo-text">
              {t("plug.packBrings", { n: String(pending.plugins.length) })}
            </p>
          )}
          {pending.plugins.map((p) => (
            <div key={p.name}>
              <p className="text-sm font-medium text-halo-text">
                {p.name} <span className="text-xs text-halo-muted">v{p.version}</span>
              </p>
              {p.description && (
                <p className="text-xs text-halo-muted">{p.description}</p>
              )}
              <p className="text-xs text-halo-muted">
                {t("plug.entitiesCount", {
                  n: String(p.commands.length + p.skills.length + p.roles.length),
                })}
                {": "}
                {[
                  `${p.commands.length} ${t("plug.commands")}`,
                  `${p.skills.length} ${t("plug.skills")}`,
                  `${p.roles.length} ${t("plug.roles")}`,
                ].join(" · ")}
              </p>
            </div>
          ))}
          {(pending.hooks.length > 0 || pending.mcp.length > 0) && (
            <p className="text-xs font-medium text-amber-400">
              {pending.hooks.length > 0 &&
                t("plug.bringsHooks", { n: String(pending.hooks.length) })}
              {pending.hooks.length > 0 && pending.mcp.length > 0 && " · "}
              {pending.mcp.length > 0 &&
                t("plug.bringsMcp", { n: String(pending.mcp.length) })}
            </p>
          )}
          {/* Что именно запустится: команда/матчер каждого хука и строка
              запуска каждого сервера — решение видно до подтверждения */}
          {pending.hooks.length > 0 && (
            <div className="space-y-1">
              {pending.hooks.map((h, i) => (
                <p
                  key={`hook-${i}`}
                  className="break-all rounded bg-halo-surface px-2 py-1 font-mono text-[0.625rem] text-halo-muted"
                >
                  {h.event}
                  {h.matcher ? ` · ${h.matcher}` : ""} · {h.command}
                </p>
              ))}
            </div>
          )}
          {pending.mcp.length > 0 && (
            <div className="space-y-1">
              {pending.mcp.map((s) => (
                <p
                  key={s.name}
                  className="break-all rounded bg-halo-surface px-2 py-1 font-mono text-[0.625rem] text-halo-muted"
                >
                  {s.name}: {s.transport ? `${s.transport} ${s.url ?? ""}` : [s.command, ...s.args].join(" ")}
                </p>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPending(null)}
              className="press rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("prompts.cancel")}
            </button>
            <button
              onClick={() => void confirmInstall()}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-halo-on-accent press hover:bg-halo-accent-deep"
            >
              {t("plug.install")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {plugins.length === 0 && !pending && (
          <div className="rounded-xl border border-dashed border-halo-line bg-halo-surface/40 px-6 py-8 text-center">
            <p className="text-sm font-medium text-halo-text">{t("plug.emptyTitle")}</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-halo-muted">
              {t("plug.emptyBody")}
            </p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-halo-muted/70">
              {t("plug.emptyWhat")}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => void pickAndRead()}
                className="rounded-lg bg-halo-accent px-4 py-1.5 text-sm font-medium text-halo-on-accent press hover:bg-halo-accent-deep"
              >
                {t("plug.import")}
              </button>
              {/* Экспорт пустого пака валиден: валидный json с plugins: [] —
                  удобно как шаблон для ручной сборки пака */}
              <button
                onClick={() => void exportPack()}
                className="rounded-lg border border-halo-line px-4 py-1.5 text-sm text-halo-text transition-colors hover:border-halo-accent/60 hover:text-halo-accent"
              >
                {t("plug.exportPack")}
              </button>
            </div>
          </div>
        )}
        {plugins.map((p) => (
          <div
            key={p.name}
            className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm font-medium text-halo-text">
                {p.name}
              </span>
              <span className="shrink-0 text-[0.625rem] text-halo-muted/60">
                v{p.version}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {p.description}
              </span>
              <span className="shrink-0 text-[0.625rem] text-halo-muted/60">
                {(p.commands?.length ?? 0) + (p.skills?.length ?? 0) + (p.roles?.length ?? 0)}
              </span>
              <button
                onClick={() => void togglePlugin(p)}
                className={`shrink-0 rounded-md border px-2 py-0.5 text-[0.625rem] transition-colors ${
                  p.enabled
                    ? "border-emerald-400/40 text-emerald-400"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {p.enabled ? t("hook.on") : t("hook.off")}
              </button>
              <button
                onClick={() => void uninstallPlugin(p)}
                title={t("plug.uninstall")}
                className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[0.625rem] leading-relaxed text-halo-muted/60">
        {t("plug.hint")}
      </p>

      {notice && (
        <p className="mt-3 break-all rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-400">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
