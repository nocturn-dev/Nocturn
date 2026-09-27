import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import { type WebSearchConfig, webSearchGetConfig, webSearchSetConfig, invalidateToolSchemas } from "../../api";
import { ToggleRow } from "./parts";

/** Раздел «Веб-поиск»: тул web_search для агента (SearXNG / Brave) */
export function WebSearchSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<WebSearchConfig>({
    enabled: false,
    provider: "searxng",
    searxng_url: "",
    brave_key: "",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    webSearchGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: WebSearchConfig) => {
    setCfg(next);
    try {
      await webSearchSetConfig(next);
      invalidateToolSchemas(); // тул появляется/исчезает у модели сразу
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  const providers = [
    { id: "searxng", label: t("ws.providerSearxng") },
    { id: "brave", label: t("ws.providerBrave") },
  ];

  return (
    <div className="mt-5 border-t border-halo-line pt-4">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.websearch")}
      </h3>
      <p className="mb-2 text-xs leading-relaxed text-halo-muted">
        {t("ws.desc")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("ws.enabled")}
          desc={t("ws.enabledDesc")}
          on={cfg.enabled}
          onChange={(v) => void apply({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            {/* Провайдер: сегмент из двух кнопок */}
            <div className="flex items-center gap-2 rounded-lg border border-halo-line bg-halo-surface/40 px-3 py-2.5">
              <span className="text-xs text-halo-muted">{t("ws.provider")}:</span>
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void apply({ ...cfg, provider: p.id })}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    cfg.provider === p.id
                      ? "border-halo-accent/60 bg-halo-accent/10 text-halo-accent"
                      : "border-halo-line text-halo-muted hover:text-halo-text"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {cfg.provider === "searxng" ? (
              <div className="rounded-lg px-2.5 py-2.5">
                <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                  {t("ws.searxngUrl")}
                </span>
                <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                  {t("ws.searxngUrlDesc")}
                </p>
                <input
                  type="text"
                  value={cfg.searxng_url}
                  onChange={(e) => setCfg({ ...cfg, searxng_url: e.target.value })}
                  onBlur={() => void apply(cfg)}
                  placeholder="http://localhost:8888"
                  className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
              </div>
            ) : (
              <div className="rounded-lg px-2.5 py-2.5">
                <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                  Brave API key
                </span>
                <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                  {t("ws.braveKeyDesc")}
                </p>
                <input
                  type="password"
                  value={cfg.brave_key}
                  onChange={(e) => setCfg({ ...cfg, brave_key: e.target.value })}
                  onBlur={() => void apply(cfg)}
                  placeholder="BSA..."
                  className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
              </div>
            )}
            <p className="rounded-lg border border-halo-line/60 bg-halo-surface/40 px-2.5 py-2 text-[11px] leading-relaxed text-halo-muted/80">
              {t("ws.hint")}
              {saved ? ` ✓` : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
