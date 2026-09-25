import { useLang } from "../../locales";

export function MemorySection({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useLang();
  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-3 text-sm font-semibold text-halo-text">
        {t("settings.memory")}
      </h3>
      <div className="flex items-center justify-between rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3.5">
        <div className="min-w-0 pr-4">
          <p className="text-sm font-medium text-halo-text">{t("memory.toggle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-halo-muted">
            {t("memory.desc")}
          </p>
        </div>
        <button
          onClick={() => onChange(!enabled)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-halo-accent" : "bg-halo-line"
          }`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-halo-on-accent transition-all ${
              enabled ? "left-4.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
      <div className="mt-3 rounded-xl border border-halo-line bg-halo-surface/50 px-4 py-3">
        <p className="text-xs font-medium text-halo-text">{t("memory.howTitle")}</p>
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-halo-muted">
          <li>· {t("memory.how1")}</li>
          <li>· {t("memory.how2")}</li>
          <li>· {t("memory.how3")}</li>
        </ul>
      </div>
      <p className="mt-3 text-xs text-halo-muted/70">{t("memory.note")}</p>
    </div>
  );
}

/** Названия шеллов консоли: не переводятся */
