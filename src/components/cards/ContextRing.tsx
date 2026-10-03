import type { MsgKey } from "../../locales";
import { useLang } from "../../locales";
import { fmtInt } from "./util";
import { STATUS_ERR, STATUS_OK, STATUS_WARN } from "../../statusColors";
import { useState } from "react";

export function ContextRing({
  used,
  limit,
  rows,
  isEstimate,
}: {
  used: number;
  limit: number;
  rows: { label: MsgKey; tokens: number; color: string }[];
  isEstimate: boolean;
}) {
  const { lang, t } = useLang();
  const [open, setOpen] = useState(false);
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  const color = pct >= 0.85 ? STATUS_ERR : pct >= 0.6 ? STATUS_WARN : STATUS_OK;
  const R = 6;
  const C = 2 * Math.PI * R;
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        title={t("ctx.title")}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-halo-hover"
      >
        {/* Чистое кольцо заполнения без цифры (фидбек владельца: «0» внутри
            выпирало) — детали по hover в поповере. Тонкие 2px, как у ZCode */}
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r={R} fill="none" stroke="var(--halo-line)" strokeWidth={2} />
          {pct > 0.005 && (
            <circle
              cx="8"
              cy="8"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={`${C * pct} ${C}`}
              transform="rotate(-90 8 8)"
              style={{ transition: "stroke-dasharray 0.4s ease" }}
            />
          )}
        </svg>
      </button>
      {open && (
        <div className="glass-pane absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl border border-halo-line bg-halo-deep/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-medium text-halo-text">{t("ctx.title")}</span>
            <span className="text-halo-muted">
              {fmt(used)} / {fmt(limit)} · {Math.round(pct * 100)}%
            </span>
          </div>
          <div className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-halo-line">
            <div
              className="h-full rounded-full transition"
              style={{ width: `${pct * 100}%`, background: color }}
            />
          </div>
          {/* Разбивка заполнения: кто сколько окна съедает */}
          <div className="mb-2 flex flex-col gap-1.5">
            {rows.map((r) => {
              const rowPct = limit > 0 ? (r.tokens / limit) * 100 : 0;
              return (
                <p
                  key={r.label}
                  className="flex items-center gap-2"
                  title={`${fmtInt(r.tokens, lang)} ~tokens`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      background: rowPct > 0 ? r.color : "var(--halo-muted)",
                      opacity: rowPct > 0 ? 1 : 0.4,
                    }}
                  />
                  <span className="flex-1 text-halo-muted">{t(r.label)}</span>
                  <span className="text-halo-text/80">
                    {rowPct > 0 ? `${rowPct.toFixed(1)}%` : "0%"}
                  </span>
                </p>
              );
            })}
          </div>
          <p className="mb-1 flex justify-between text-halo-muted">
            <span>{t("ctx.used")}</span>
            <span>{fmtInt(used, lang)}</span>
          </p>
          <p className="mb-2 flex justify-between text-halo-muted">
            <span>{t("ctx.limit")}</span>
            <span>
              {fmtInt(limit, lang)}{" "}
              <span className="text-halo-muted/50">
                ({isEstimate ? t("ctx.estimate") : t("ctx.fromProvider")})
              </span>
            </span>
          </p>
          <p className="text-[0.625rem] text-halo-muted/60">{t("ctx.hint")}</p>
        </div>
      )}
    </div>
  );
}
