import { useEffect, useState } from "react";
import { useLang } from "../../locales";
import { ComputerConfig, invalidateToolSchemas, computerGetConfig, computerSetConfig } from "../../api";
import { ToggleRow } from "./parts";
import { WarnIcon } from "../cards/icons";

export function ComputerUseSection() {
  const { t } = useLang();
  const [cfg, setCfg] = useState<ComputerConfig>({ enabled: true });

  useEffect(() => {
    computerGetConfig()
      .then(setCfg)
      .catch(() => {});
  }, []);

  const apply = async (next: ComputerConfig) => {
    setCfg(next);
    try {
      await computerSetConfig(next);
      invalidateToolSchemas();
    } catch {
      // файл конфига недоступен — снапшот в Rust всё равно обновлён
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.computer")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("cu.desc")}
      </p>

      <ToggleRow
        label={t("cu.enabled")}
        desc={t("cu.enabledDesc")}
        on={cfg.enabled}
        onChange={(v) => void apply({ ...cfg, enabled: v })}
      />

      <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300/90">
        <WarnIcon /> {t("cu.note")}
      </p>
    </div>
  );
}
