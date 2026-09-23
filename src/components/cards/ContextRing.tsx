import { useLang } from "../../locales";
import { useState } from "react";

export function ContextRing({
  used,
  limit,
  rows,
  isEstimate,
}: {
  used: number;
  limit: number;
  rows: { label: string; tokens: number; color: string }[];
  isEstimate: boolean;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  const color = pct >= 0.85 ? "#d14b4b" : pct >= 0.6 ? "#d4aa50" : "#5fbe82";
  const R = 7;
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
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r={R} fill="none" stroke="var(--halo-line)" strokeWidth={2.5} />
          <circle
            cx="10"
            cy="10"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${C * pct} ${C}`}
            transform="rotate(-90 10 10)"
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
          <text x="10" y="13" textAnchor="middle" fill="var(--halo-muted)" fontSize={7}>
            {Math.round(pct * 100)}
          </text>
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
              className="h-full rounded-full transition-all"
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
                  title={`${r.tokens.toLocaleString("ru-RU")} ~tokens`}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      background: rowPct > 0 ? r.color : "var(--halo-muted)",
                      opacity: rowPct > 0 ? 1 : 0.4,
                    }}
                  />
                  <span className="flex-1 text-halo-muted">{t(r.label as never)}</span>
                  <span className="text-halo-text/80">
                    {rowPct > 0 ? `${rowPct.toFixed(1)}%` : "0%"}
                  </span>
                </p>
              );
            })}
          </div>
          <p className="mb-1 flex justify-between text-halo-muted">
            <span>{t("ctx.used")}</span>
            <span>{used.toLocaleString("ru-RU")}</span>
          </p>
          <p className="mb-2 flex justify-between text-halo-muted">
            <span>{t("ctx.limit")}</span>
            <span>
              {limit.toLocaleString("ru-RU")}{" "}
              <span className="text-halo-muted/50">
                ({isEstimate ? t("ctx.estimate") : t("ctx.fromProvider")})
              </span>
            </span>
          </p>
          <p className="text-[10px] text-halo-muted/60">{t("ctx.hint")}</p>
        </div>
      )}
    </div>
  );
}
