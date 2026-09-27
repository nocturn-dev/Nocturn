import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import { BrowserConfig, invalidateToolSchemas, browserGetConfig, browserSetConfig } from "../../api";
import { ToggleRow } from "./parts";

export function BrowserUseSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<BrowserConfig>({
    enabled: true,
    headless: true,
    executable: "",
    allowPrivateNetworks: false,
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    browserGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: BrowserConfig) => {
    setCfg(next);
    try {
      await browserSetConfig(next);
      invalidateToolSchemas();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.browser")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("bu.desc")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("bu.enabled")}
          desc={t("bu.enabledDesc")}
          on={cfg.enabled}
          onChange={(v) => void apply({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            <ToggleRow
              label={t("bu.headless")}
              desc={t("bu.headlessDesc")}
              on={cfg.headless}
              onChange={(v) => void apply({ ...cfg, headless: v })}
            />
            <ToggleRow
              label={t("bu.privateNet")}
              desc={t("bu.privateNetDesc")}
              on={cfg.allowPrivateNetworks}
              onChange={(v) => void apply({ ...cfg, allowPrivateNetworks: v })}
            />
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("bu.executable")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("bu.executableDesc")}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cfg.executable}
                  onChange={(e) => setCfg({ ...cfg, executable: e.target.value })}
                  placeholder={t("bu.executablePh")}
                  className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
                <button
                  onClick={() => void apply(cfg)}
                  className="shrink-0 rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
                >
                  {saved ? "✓" : t("bu.save")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <p className="mt-3 px-2.5 text-xs leading-relaxed text-halo-muted/70">
        {t("bu.note")}
      </p>
    </div>
  );
}

/** Раздел «Генерация изображений»: опциональный инструмент агента (BYOK) */
