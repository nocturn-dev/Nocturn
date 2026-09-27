/** Раздел «Плагины»: импорт бандлов (plugin.json) с командами/скилами/ролями */
import { useState } from "react";
import { useLang } from "../locales";
import {
  hooksSave,
  mcpSaveServers,
  mcpListServers,
  pluginRead,
  pluginsSave,
  hooksLoad,
  chatExportWrite,
  pickSaveFile,
  type Hook,
  type McpServerCfg,
  type Plugin,
} from "../api";
import { MiniTrashIcon } from "./settings/parts";

export default function PluginsSection({
  plugins,
  onChange,
}: {
  plugins: Plugin[];
  onChange: (p: Plugin[]) => void;
}) {
  const { t } = useLang();
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<Partial<Plugin> | null>(null);
  // Хуки/MCP из пака — исполняемые: применяются только после подтверждения
  const [packHooks, setPackHooks] = useState<Hook[] | null>(null);
  const [packMcp, setPackMcp] = useState<McpServerCfg[] | null>(null);

  const persist = (next: Plugin[]) => {
    onChange(next);
    pluginsSave(next).catch((e) => setError(String(e)));
  };

  // Экспорт всех установленных плагинов одним файлом-паком: шаринг
  // воркфлоу между машинами/пользователями без ручного пересборки
  const exportPack = async () => {
    try {
      setError(null);
      const path = await pickSaveFile("nocturn-plugin-pack.json", "json");
      if (!path) return;
      const pack = { kind: "nocturn-plugin-pack", version: 1, plugins };
      await chatExportWrite(path, JSON.stringify(pack, null, 2));
    } catch (e) {
      setError(String(e));
    }
  };

  const pickAndRead = async () => {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        filters: [{ name: "plugin.json", extensions: ["json"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const manifest = await pluginRead(picked);
      // Набор паков (экспорт «все плагины разом») — ставим все без вопросов:
      // плагины v1 не несут hooks/MCP, исполняемое сюда не попадает
      if (
        (manifest as { kind?: string }).kind === "nocturn-plugin-pack" &&
        Array.isArray((manifest as { plugins?: unknown }).plugins)
      ) {
        const pack = manifest as unknown as {
          plugins: Plugin[];
        };
        const merged = [...plugins];
        for (const p of pack.plugins) {
          const i = merged.findIndex((m) => m.name === p.name);
          if (i >= 0) merged[i] = p;
          else merged.push(p);
        }
        persist(merged);
        return;
      }
      if (!manifest.name) {
        setError(t("plug.noName"));
        return;
      }
      const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : null;
      const mcpServers = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : null;
      setPackHooks(hooks);
      setPackMcp(mcpServers);
      setImported({
        name: manifest.name,
        version: manifest.version ?? "1.0.0",
        description: manifest.description ?? "",
        commands: Array.isArray(manifest.commands) ? manifest.commands : [],
        skills: Array.isArray(manifest.skills) ? manifest.skills : [],
        roles: Array.isArray(manifest.roles) ? manifest.roles : [],
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const confirmInstall = () => {
    if (!imported?.name) return;
    // Хуки/MCP исполняемы (AGENTS.md: произвольная запись в конфиг = RCE-вектор):
    // установка только явным подтверждением пользователя
    if ((packHooks?.length ?? 0) + (packMcp?.length ?? 0) > 0) {
      const ok = window.confirm(t("plug.execConfirm"));
      if (!ok) return;
    }
    const full: Plugin = {
      name: imported.name,
      version: imported.version ?? "1.0.0",
      description: imported.description ?? "",
      enabled: true,
      commands: imported.commands ?? [],
      skills: imported.skills ?? [],
      roles: imported.roles ?? [],
    };
    persist([...plugins.filter((p) => p.name !== full.name), full]);
    // Хуки пака добавляются к пользовательским (id генерим заново — без коллизий)
    if (packHooks && packHooks.length > 0) {
      void hooksLoad()
        .then((file) => {
          const existing = file.hooks ?? [];
          const add = packHooks.map((h, i) => ({
            ...h,
            id: `${h.id}-pack-${Date.now()}-${i}`,
          }));
          return hooksSave({ hooks: [...existing, ...add] });
        })
        .catch((e) => setError(String(e)));
    }
    // MCP-серверы: имя совпадает — пак перезаписывает (превью предупреждает)
    if (packMcp && packMcp.length > 0) {
      void mcpListServers()
        .then((current) => {
          const merged = [...current];
          for (const srv of packMcp) {
            const i = merged.findIndex((m) => m.name === srv.name);
            if (i >= 0) merged[i] = srv;
            else merged.push(srv);
          }
          return mcpSaveServers(merged);
        })
        .catch((e) => setError(String(e)));
    }
    setPackHooks(null);
    setPackMcp(null);
    setImported(null);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.plugins")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("plug.desc")}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void pickAndRead()}
          className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
        >
          {t("plug.import")}
        </button>
        <button
          onClick={() => void exportPack()}
          disabled={plugins.length === 0}
          className="rounded-lg border border-halo-line px-3.5 py-1.5 text-sm text-halo-text transition-colors hover:border-halo-accent/60 hover:text-halo-accent disabled:opacity-50"
        >
          {t("plug.exportPack")}
        </button>
      </div>

      {/* Предпросмотр перед установкой */}
      {imported && (
        <div className="mt-3 space-y-2 rounded-xl border border-halo-accent/40 p-3">
          <p className="text-sm font-medium text-halo-text">
            {imported.name}{" "}
            <span className="text-xs text-halo-muted">v{imported.version}</span>
          </p>
          {imported.description && (
            <p className="text-xs text-halo-muted">{imported.description}</p>
          )}
          <p className="text-xs text-halo-muted">
            {t("plug.brings", {
              n: String(
                (imported.commands?.length ?? 0) +
                  (imported.skills?.length ?? 0) +
                  (imported.roles?.length ?? 0),
              ),
            })}
            {": "}
            {[
              `${imported.commands?.length ?? 0} ${t("plug.commands")}`,
              `${imported.skills?.length ?? 0} ${t("plug.skills")}`,
              `${imported.roles?.length ?? 0} ${t("plug.roles")}`,
            ].join(" · ")}
          </p>
          {(packHooks?.length ?? 0) > 0 && (
            <p className="text-xs font-medium text-amber-400">
              {t("plug.bringsHooks", { n: String(packHooks!.length) })}
            </p>
          )}
          {(packMcp?.length ?? 0) > 0 && (
            <p className="text-xs font-medium text-amber-400">
              {t("plug.bringsMcp", { n: String(packMcp!.length) })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setImported(null)}
              className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:text-halo-text"
            >
              {t("prompts.cancel")}
            </button>
            <button
              onClick={confirmInstall}
              className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
            >
              {t("plug.install")}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-1.5">
        {plugins.length === 0 && (
          <p className="rounded-lg border border-dashed border-halo-line bg-halo-surface/40 px-3 py-6 text-center text-xs text-halo-muted">
            {t("plug.empty")}
          </p>
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
              <span className="shrink-0 text-[10px] text-halo-muted/60">
                v{p.version}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {p.description}
              </span>
              <span className="shrink-0 text-[10px] text-halo-muted/60">
                {(p.commands?.length ?? 0) + (p.skills?.length ?? 0) + (p.roles?.length ?? 0)}
              </span>
              <button
                onClick={() =>
                  persist(
                    plugins.map((x) =>
                      x.name === p.name ? { ...x, enabled: !x.enabled } : x,
                    ),
                  )
                }
                className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] transition-colors ${
                  p.enabled
                    ? "border-emerald-400/40 text-emerald-400"
                    : "border-halo-line text-halo-muted hover:text-halo-text"
                }`}
              >
                {p.enabled ? t("hook.on") : t("hook.off")}
              </button>
              <button
                onClick={() => persist(plugins.filter((x) => x.name !== p.name))}
                title={t("plug.uninstall")}
                className="shrink-0 rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-red-400"
              >
                <MiniTrashIcon />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-halo-muted/60">
        {t("plug.hint")}
      </p>

      {error && (
        <p className="mt-3 break-all rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
