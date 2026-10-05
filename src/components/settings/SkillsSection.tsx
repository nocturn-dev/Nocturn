import { useState } from "react";
import { useLang } from "../../locales";
import { BUILTIN_SKILLS } from "../../skills";

export function SkillsSection({
  extra = [],
}: {
  extra?: { id: string; name: string; desc?: { ru: string; en: string }; prompt: string }[];
}) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-2xl">
      <h3 className="mb-1 text-sm font-semibold text-halo-text">
        {t("settings.skills")}
      </h3>
      <p className="mb-4 text-xs leading-relaxed text-halo-muted">
        {t("skills.desc")}
      </p>
      <div className="space-y-1.5">
        {BUILTIN_SKILLS.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-2"
          >
            <button
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className="flex w-full items-center gap-2 text-left"
            >
              <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold text-halo-accent">
                &{s.id}:
              </code>
              <span className="shrink-0 text-sm font-medium text-halo-text">
                {s.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {lang === "ru" ? s.desc?.ru ?? "" : s.desc?.en ?? ""}
              </span>
              <span
                className={`shrink-0 text-halo-muted transition-transform ${open === s.id ? "rotate-90" : ""}`}
              >
                ›
              </span>
            </button>
            {open === s.id && (
              <pre className="scroll-slim mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-halo-deep/60 px-2.5 py-2 font-mono text-[0.625rem] leading-relaxed text-halo-muted">
                {s.prompt}
              </pre>
            )}
          </div>
        ))}
        {extra.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border border-halo-line/60 bg-halo-surface/30 px-3 py-2"
          >
            <button
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className="flex w-full items-center gap-2 text-left"
            >
              <code className="shrink-0 rounded bg-halo-muted/10 px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold text-halo-muted">
                &{s.id}
              </code>
              <span className="shrink-0 text-sm font-medium text-halo-text">
                {s.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                {lang === "ru" ? s.desc?.ru ?? "" : s.desc?.en ?? ""}
              </span>
              <span className="shrink-0 text-[0.625rem] text-halo-muted/50">
                {t("skills.fromPlugin")}
              </span>
            </button>
            {open === s.id && (
              <pre className="scroll-slim mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-halo-deep/60 px-2.5 py-2 font-mono text-[0.625rem] leading-relaxed text-halo-muted">
                {s.prompt}
              </pre>
            )}
          </div>
        ))}
      </div>
      {extra.length > 0 && (
        <p className="mt-2 text-[0.625rem] leading-relaxed text-halo-muted/60">
          {t("skills.fromPluginHint")}
        </p>
      )}
    </div>
  );
}
