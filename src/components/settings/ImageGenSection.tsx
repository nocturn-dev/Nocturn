import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import { type ImageGenConfig, imageGenGetConfig, imageGenSetConfig, invalidateToolSchemas } from "../../api";
import { ToggleRow } from "./parts";
import { CheckIcon } from "../cards/icons";

export function ImageGenSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<ImageGenConfig>({
    enabled: false,
    base_url: "",
    api_key: "",
    model: "",
    size: "",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    imageGenGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: ImageGenConfig) => {
    const prev = cfg;
    setCfg(next);
    try {
      await imageGenSetConfig(next);
      invalidateToolSchemas(); // инструмент появляется/исчезает у модели сразу
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {
      // Запись на диск не удалась: снапшот в Rust НЕ обновлялся (save_json_config
      // идёт ДО set_config) — откатываем UI, иначе он врал об активном состоянии
      setCfg(prev);
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.imagegen")}
      </h3>
      <p className="mb-2 text-xs leading-relaxed text-halo-muted">
        {t("ig.desc")}
      </p>
      <p className="mb-4 rounded-lg border border-halo-line/60 bg-halo-surface/40 px-2.5 py-2 text-xs leading-relaxed text-halo-muted">
        {t("ig.fallbackHint")}
      </p>

      <div className="space-y-1">
        <ToggleRow
          label={t("ig.enabled")}
          desc={t("ig.enabledDesc")}
          on={cfg.enabled}
          onChange={(v) => void apply({ ...cfg, enabled: v })}
        />
        {cfg.enabled && (
          <>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.baseUrl")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("ig.baseUrlDesc")}
              </p>
              <input
                type="text"
                value={cfg.base_url}
                onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("img.apiKey")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("ig.apiKeyDesc")}
              </p>
              <input
                type="password"
                value={cfg.api_key}
                onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })}
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors focus:border-halo-accent/60"
              />
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.model")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("ig.modelDesc")}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cfg.model}
                  onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
                  placeholder="dall-e-3 / flux-… / gemini-2.5-flash-image"
                  className="min-w-0 flex-1 rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
                />
                <button
                  onClick={() => void apply(cfg)}
                  className="shrink-0 rounded-lg border border-halo-line px-3 py-2 text-xs text-halo-text transition-colors hover:border-halo-accent/50 hover:bg-halo-hover"
                >
                  {saved ? <CheckIcon /> : t("bu.save")}
                </button>
              </div>
            </div>
            <div className="rounded-lg px-2.5 py-2.5">
              <span className="mb-1.5 block text-xs font-medium text-halo-muted">
                {t("ig.size")}
              </span>
              <p className="mb-2 text-xs leading-relaxed text-halo-muted">
                {t("ig.sizeDesc")}
              </p>
              <input
                type="text"
                value={cfg.size}
                onChange={(e) => setCfg({ ...cfg, size: e.target.value })}
                placeholder="1024x1024"
                className="w-full rounded-lg border border-halo-line bg-halo-surface px-3 py-2 font-mono text-xs text-halo-text outline-none transition-colors placeholder:text-halo-muted/60 focus:border-halo-accent/60"
              />
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-halo-muted/70">
        {t("ig.note")}
      </p>
    </div>
  );
}
