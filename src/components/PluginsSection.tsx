/** Раздел «Плагины»: импорт бандлов (plugin.json) с командами/скилами/ролями */
import { useState } from "react";
import { useLang } from "../locales";
import { pluginRead, pluginsSave, type Plugin } from "../api";
import { MiniTrashIcon } from "./SettingsModal";

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

  const persist = (next: Plugin[]) => {
    onChange(next);
    pluginsSave(next).catch((e) => setError(String(e)));
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
      if (!manifest.name) {
        setError(t("plug.noName"));
        return;
      }
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

      <button
        onClick={() => void pickAndRead()}
        className="rounded-lg bg-halo-accent px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-halo-accent-deep"
      >
        {t("plug.import")}
      </button>

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
