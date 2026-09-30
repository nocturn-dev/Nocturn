import { useEffect, useState } from "react";
import { type NetworkConfig, networkGetConfig, networkSetConfig } from "../../api";
import { useLang, MsgKey } from "../../locales";

export function NetworkSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<NetworkConfig>({
    proxy: "",
    no_proxy: "",
    ca_path: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [savedField, setSavedField] = useState<string | null>(null);
  useEffect(() => {
    void networkGetConfig()
      .then(setCfg)
      .finally(() => setLoaded(true));
  }, []);
  const saveField = async (key: keyof NetworkConfig) => {
    try {
      await networkSetConfig(cfg);
      setSavedField(key);
      window.setTimeout(() => setSavedField(null), 2500);
    } catch (e) {
      setSavedField(null);
      window.alert(String(e));
    }
  };
  if (!loaded) return null;
  const placeholders: Record<keyof NetworkConfig, string> = {
    proxy: t("network.proxyPh"),
    no_proxy: t("network.noProxyPh"),
    ca_path: t("network.caPh"),
  };
  const row = (
    titleKey: MsgKey,
    hintKey: MsgKey,
    key: keyof NetworkConfig,
  ) => (
    <div className="rounded-xl border border-halo-line bg-halo-surface/30 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-halo-text">{t(titleKey)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-halo-muted">
            {t(hintKey)}
          </p>
          <input
            type="text"
            value={cfg[key]}
            onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
            placeholder={placeholders[key]}
            className="mt-2 w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/50 focus:border-halo-accent/60"
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            onClick={() => saveField(key)}
            className="rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-text transition-colors hover:bg-halo-hover"
          >
            {t("network.save")}
          </button>
          {savedField === key && (
            <span className="text-[0.625rem] text-emerald-400">
              {t("network.saved")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.network")}
      </h3>
      <div className="space-y-2.5">
        {row("network.proxyTitle", "network.proxyHint", "proxy")}
        {row("network.noProxyTitle", "network.noProxyHint", "no_proxy")}
        {row("network.caTitle", "network.caHint", "ca_path")}
      </div>
    </div>
  );
}

