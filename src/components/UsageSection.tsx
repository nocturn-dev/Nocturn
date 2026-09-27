import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session, UsageEvent } from "../types";
import { dayKeyLocal } from "../time";
import { useLang, type TFn } from "../locales";
import { shortModelName } from "./ProviderIcon";
import { usageColorsLoad, usageColorsSave } from "../api";

/** Цвета моделей в графиках: дефолт по хэшу имени — стабилен между запусками */
const MODEL_COLORS = ["#4c8dd9", "#4cbf7a", "#d9a44c", "#c76fd1", "#d96570", "#5bbfc9"];
const DAY = 86_400_000;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Короткий формат токенов: 1234 → 1,2K · 365100000 → 365.1M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Длительность: 197 мин → «3 ч 17 м» (единицы — из словаря, а не хардкод) */
const fmtDuration = (ms: number, t: TFn): string => {
  if (ms <= 0) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return t("usage.durationM", { m: min });
  return t("usage.durationHm", { h: Math.floor(min / 60), m: min % 60 });
};

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Блок статистики: сводка, тепловая карта активности, тренд и донат моделей.
    События считаются из всех чатов (sessions.json), а не только текущего запуска.
    Внутри вкладки «Обзор» шапка скрыта, а диапазон управляется общим селектором
    периода (rangeDays/onRangeChange) */
export default function UsageSection({
  sessions,
  rangeDays,
  onRangeChange,
  showHeader = true,
}: {
  sessions: Session[];
  rangeDays?: 7 | 30;
  onRangeChange?: (d: 7 | 30) => void;
  showHeader?: boolean;
}) {
  const { t, lang } = useLang();
  const [mode, setMode] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [innerRange, setInnerRange] = useState<7 | 30>(7);
  const range = rangeDays ?? innerRange;
  const setRange = (r: 7 | 30) =>
    onRangeChange ? onRangeChange(r) : setInnerRange(r);
  const [tick, setTick] = useState(0); // Refresh: пересчёт по требованию
  // Пользовательские цвета моделей (model → hex), хранятся в colors.json
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    usageColorsLoad()
      .then(setColors)
      .catch(() => {});
  }, []);
  const setColor = (model: string, hex: string) => {
    const next = { ...colors, [model]: hex };
    setColors(next);
    usageColorsSave(next).catch(() => {});
  };
  // useCallback: memo статистики ниже зависит от colorOf — без стабильной
  // идентичности кэш пересчитывался бы на каждый рендер
  const colorOf = useCallback(
    (model: string): string =>
      colors[model] ??
      MODEL_COLORS[hashString(model) % MODEL_COLORS.length] ??
      "#8b8b85",
    [colors],
  );

  const events = useMemo(() => {
    void tick;
    const list: UsageEvent[] = [];
    for (const s of sessions) {
      const sessionDay = dayKeyLocal(new Date(s.createdAt));
      for (const m of s.messages) {
        if (m.role === "assistant" && m.usage) {
          // FIX: день события — из времени сообщения; раньше все сообщения
          // сессии приписывались дню создания сессии, и тепловая карта/тренд/
          // серии врали для многодневных задач. Старые сообщения без ts —
          // фолбэк на день сессии (прежнее поведение).
          const day = m.ts ? dayKeyLocal(new Date(m.ts)) : sessionDay;
          list.push({
            day,
            prompt: m.usage.prompt,
            completion: m.usage.completion,
            model: m.model ?? "?",
            workedMs: m.workedMs ?? 0,
          });
        }
      }
    }
    return list;
  }, [sessions, tick]);

  const data = useMemo(() => {
    void tick;
    // Итоги
    let total = 0;
    let peak = 0;
    let longest = 0;
    const byModel = new Map<string, number>();
    const byDay = new Map<string, number>();
    const days = new Set<string>();
    for (const e of events) {
      const tokens = e.prompt + e.completion;
      total += tokens;
      peak = Math.max(peak, e.prompt);
      longest = Math.max(longest, e.workedMs);
      byModel.set(e.model, (byModel.get(e.model) ?? 0) + tokens);
      byDay.set(e.day, (byDay.get(e.day) ?? 0) + tokens);
      days.add(e.day);
    }
    // Серии активных дней: текущая (от сегодня/вчера назад) и рекордная
    const sortedDays = [...days].sort();
    let longestStreak = 0;
    let run = 0;
    let prev: number | null = null;
    for (const d of sortedDays) {
      const time = new Date(d + "T00:00:00").getTime();
      run = prev !== null && time - prev === DAY ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      prev = time;
    }
    let currentStreak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!days.has(dayKey(cursor))) cursor = new Date(cursor.getTime() - DAY);
    while (days.has(dayKey(cursor))) {
      currentStreak++;
      cursor = new Date(cursor.getTime() - DAY);
    }
    // Топ моделей по расходу; цвет — пользовательский или стабильный по хэшу
    const models = [...byModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model, tokens]) => ({
        model,
        tokens,
        color: colorOf(model),
      }));

    // Последние 365 дней для тепловой карты (выравнивание по неделям, вс=первый ряд)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today.getTime() + (6 - today.getDay()) * DAY);
    const start = new Date(end.getTime() - 363 * DAY);
    const weeks: { key: string; value: number; date: Date }[][] = [];
    for (let w = 0; w < 52; w++) {
      const col: { key: string; value: number; date: Date }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getTime() + (w * 7 + d) * DAY);
        col.push({ key: dayKey(date), value: byDay.get(dayKey(date)) ?? 0, date });
      }
      weeks.push(col);
    }
    // Накопительный ряд для режима cumulative
    let acc = 0;
    const cumByDay = new Map<string, number>();
    for (const d of sortedDays) {
      acc += byDay.get(d) ?? 0;
      cumByDay.set(d, acc);
    }

    return {
      total,
      peak,
      longest,
      currentStreak,
      longestStreak,
      models,
      weeks,
      cumByDay,
      maxDay: Math.max(1, ...[...byDay.values()]),
    };
  }, [events, tick, colorOf]);

  // Дневной тренд за выбранный диапазон: топ-2 модели
  const trend = useMemo(() => {
    void tick;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysList: string[] = [];
    for (let i = range - 1; i >= 0; i--) {
      daysList.push(dayKey(new Date(today.getTime() - i * DAY)));
    }
    const top = data.models.slice(0, 2).map((m) => m.model);
    const series = top.map((model) => ({
      model,
      color: data.models.find((m) => m.model === model)!.color,
      values: daysList.map((d) => {
        const dayEvents = events.filter((e) => e.day === d && e.model === model);
        return dayEvents.reduce((acc, e) => acc + e.prompt + e.completion, 0);
      }),
    }));
    return { daysList, series };
  }, [events, data.models, range, tick]);

  const fmtDate = (d: Date) =>
    d.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", { day: "numeric", month: "short" });

  const heatColor = (v: number, max: number) => {
    if (v <= 0) return "var(--halo-line)";
    const lvl = Math.min(4, Math.ceil((Math.log2(v / max + 1) / 2) * 4));
    const alphas = [0.25, 0.45, 0.65, 0.85, 1];
    return `rgba(76, 141, 217, ${alphas[lvl]})`;
  };

  const card = "rounded-xl border border-halo-line bg-halo-surface/50 p-4";

  return (
    <div>
      {showHeader && (
        <div className="mb-4 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-halo-text">{t("usage.title")}</h3>
          <span className="rounded-full bg-halo-hover px-2.5 py-0.5 text-xs text-halo-muted">
            {t("usage.appUsage")}
          </span>
        </div>
      )}

      {/* Сводка */}
      <div className="mb-4 grid grid-cols-5 rounded-xl border border-halo-line bg-halo-surface/50 py-3">
        {[
          [fmtTokens(data.total), t("usage.total")],
          [fmtTokens(data.peak), t("usage.peak")],
          [fmtDuration(data.longest, t), t("usage.longest")],
          // FIX: «д» было захардкожено для всех четырёх локалей
          [data.currentStreak > 0 ? t("usage.days", { n: data.currentStreak }) : "—", t("usage.streak")],
          [data.longestStreak > 0 ? t("usage.days", { n: data.longestStreak }) : "—", t("usage.longestStreak")],
        ].map(([v, label], i) => (
          <div
            key={label}
            className={`px-3 text-center ${i > 0 ? "border-l border-halo-line/60" : ""}`}
          >
            <p className="text-base font-semibold text-halo-text">{v}</p>
            <p className="mt-0.5 text-[10px] text-halo-muted">{label}</p>
          </div>
        ))}
      </div>

      {/* Тепловая карта активности */}
      <div className={`${card} mb-4`}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-halo-text">{t("usage.activity")}</span>
          <div className="flex gap-1 rounded-lg bg-halo-deep p-0.5">
            {(["daily", "weekly", "cumulative"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-0.5 text-[11px] transition-colors ${
                  mode === m ? "bg-halo-hover-strong text-halo-text" : "text-halo-muted hover:text-halo-text"
                }`}
              >
                {t(`usage.${m}`)}
              </button>
            ))}
          </div>
        </div>
        <Heatmap key={`hm-${tick}-${mode}`} weeks={data.weeks} mode={mode} cumByDay={data.cumByDay} color={heatColor} lang={lang} />
      </div>

      {/* Диапазон + тренд: при управлении из «Обзора» селектор наверху */}
      {rangeDays === undefined && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-halo-text">{t("usage.timeRange")}</span>
          <div className="flex gap-1 rounded-lg bg-halo-deep p-0.5">
            {([7, 30] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded-md px-2.5 py-0.5 text-[11px] transition-colors ${
                  range === r ? "bg-halo-hover-strong text-halo-text" : "text-halo-muted hover:text-halo-text"
                }`}
              >
                {t(r === 7 ? "usage.last7" : "usage.last30")}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`${card} mb-4`}>
        <p className="mb-3 text-sm font-medium text-halo-text">{t("usage.trend")}</p>
        {data.total === 0 ? (
          <p className="py-10 text-center text-xs text-halo-muted">{t("usage.noData")}</p>
        ) : (
          <TrendChart key={`tr-${tick}-${range}`} days={trend.daysList} series={trend.series} fmtDate={fmtDate} />
        )}
      </div>

      {/* Донат по моделям */}
      <div className={card}>
        <p className="mb-3 text-sm font-medium text-halo-text">{t("usage.modelUsage")}</p>
        {data.models.length === 0 ? (
          <p className="py-6 text-center text-xs text-halo-muted">{t("usage.noData")}</p>
        ) : (
          <div className="flex items-center gap-8">
            <Donut key={`dn-${tick}`} models={data.models} total={data.total} />
            <div className="min-w-0 flex-1 space-y-3">
              {data.models.map((m) => (
                <div key={m.model}>
                  <div className="flex items-center gap-2">
                    <label className="relative shrink-0 cursor-pointer" title={t("usage.colorHint")}>
                      <span className="block size-2.5 rounded-full ring-1 ring-white/20" style={{ background: m.color }} />
                      <input
                        type="color"
                        value={m.color}
                        onChange={(e) => setColor(m.model, e.target.value)}
                        className="absolute inset-0 cursor-pointer opacity-0"
                      />
                    </label>
                    <span className="truncate text-xs text-halo-text">{shortModelName(m.model)}</span>
                    <span className="ml-auto text-xs text-halo-muted">
                      {((m.tokens / Math.max(1, data.total)) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="ml-4 text-[10px] text-halo-muted/70">{fmtTokens(m.tokens)} {t("usage.tokens")}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => setTick((v) => v + 1)}
            className="flex items-center gap-1.5 rounded-lg border border-halo-line px-3 py-1.5 text-xs text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            ⟳ {t("usage.refresh")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** GitHub-style тепловая карта: 52 недели × 7 дней */
function Heatmap({
  weeks,
  mode,
  cumByDay,
  color,
  lang,
}: {
  weeks: { key: string; value: number; date: Date }[][];
  mode: "daily" | "weekly" | "cumulative";
  cumByDay: Map<string, number>;
  color: (v: number, max: number) => string;
  lang: string;
}) {
  const max = Math.max(1, ...weeks.flat().map((c) => c.value));
  const monthLabel = (d: Date) =>
    d.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", { month: "short" });

  if (mode === "weekly") {
    // Одна полоса: сумма за неделю
    return (
      <div className="flex gap-[3px]">
        {weeks.map((col, i) => {
          const sum = col.reduce((acc, c) => acc + c.value, 0);
          const head = col[0];
          if (!head) return null;
          return (
            <span
              key={i}
              title={`${head.date.toLocaleDateString()} — ${fmtTokens(sum)}`}
              className="usage-cell h-4 flex-1 rounded-[3px]"
              style={{ background: color(sum, max), animationDelay: `${i * 12}ms` }}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-[3px]">
        {weeks.map((col, i) => (
          <div key={i} className="flex flex-1 flex-col gap-[3px]">
            {col.map((cell, d) => {
              const v = mode === "cumulative" ? (cumByDay.get(cell.key) ?? 0) : cell.value;
              const vmax = mode === "cumulative" ? Math.max(1, ...[...cumByDay.values()]) : max;
              return (
                <span
                  key={cell.key}
                  title={`${cell.date.toLocaleDateString()} — ${fmtTokens(v)}`}
                  className="usage-cell aspect-square w-full rounded-[3px]"
                  style={{ background: color(v, vmax), animationDelay: `${(i * 7 + d) * 2}ms` }}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* Подписи месяцев: над колонкой, где месяц сменился */}
      <div className="relative mt-1.5 h-3">
        {weeks.map((col, i) => {
          const head = col[0];
          if (!head) return null;
          const prevCol = i > 0 ? weeks[i - 1] : undefined;
          const prev = prevCol?.[0]?.date.getMonth() ?? -1;
          if (head.date.getMonth() === prev) return null;
          return (
            <span
              key={i}
              className="absolute text-[9px] text-halo-muted/70"
              style={{ left: `${(i / 52) * 100}%` }}
            >
              {monthLabel(head.date)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Линейный тренд по моделям: сглаженная кривая на SVG */
function TrendChart({
  days,
  series,
  fmtDate,
}: {
  days: string[];
  series: { model: string; color: string; values: number[] }[];
  fmtDate: (d: Date) => string;
}) {
  const W = 600;
  const H = 180;
  const PAD = 6;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => PAD + (i / Math.max(1, days.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  // Сглаживание: кубическая кривая через средние точки (monotone-подобная)
  const smoothPath = (vals: number[]) => {
    const pts = vals.map((v, i) => [x(i), y(v)] as const);
    if (pts.length < 2) return "";
    const first = pts[0];
    if (!first) return "";
    let d = `M ${first[0]} ${first[1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      if (!p0 || !p1) continue;
      const [x0, y0] = p0;
      const [x1, y1] = p1;
      const cx = (x0 + x1) / 2;
      d += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    return d;
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4">
        {series.map((s) => (
          <span key={s.model} className="flex items-center gap-1.5 text-[11px] text-halo-muted">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.model}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={H * f}
            y2={H * f}
            stroke="var(--halo-line)"
            strokeDasharray="3 5"
            strokeWidth="1"
          />
        ))}
        {/* Шкала Y: подписи токенов у линий сетки */}
        {[0.25, 0.5, 0.75].map((f) => (
          <text
            key={f}
            x={PAD + 4}
            y={H * f - 4}
            fill="var(--halo-muted)"
            opacity="0.6"
            fontSize="10"
          >
            {fmtTokens(max * (1 - f))}
          </text>
        ))}
        {series.map((s) => (
          <path
            key={s.model}
            d={smoothPath(s.values)}
            fill="none"
            stroke={s.color}
            pathLength={1}
            className="usage-draw"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[9px] text-halo-muted/70">
        {days
          .filter((_, i) => i % Math.ceil(days.length / 8) === 0)
          .map((d) => (
            <span key={d}>{fmtDate(new Date(d + "T00:00:00"))}</span>
          ))}
      </div>
    </div>
  );
}

/** Донат: дуги по моделям, в центре — общий расход */
function Donut({
  models,
  total,
}: {
  models: { model: string; tokens: number; color: string }[];
  total: number;
}) {
  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="relative size-40 shrink-0">
      <svg viewBox="0 0 160 160" className="anim-pop size-full -rotate-90">
        <circle cx="80" cy="80" r={R} fill="none" stroke="var(--halo-line)" strokeWidth="16" />
        {models.map((m, i) => {
          const frac = m.tokens / Math.max(1, total);
          const dash = `${Math.max(0, frac * C - 2)} ${C}`;
          const el = (
            <circle
              key={m.model}
              cx="80"
              cy="80"
              r={R}
              fill="none"
              stroke={m.color}
              strokeWidth="16"
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              className="usage-arc"
              style={{
                strokeDasharray: dash,
                animationDelay: `${i * 140}ms`,
              }}
            />
          );
          offset += frac * C;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-base font-semibold text-halo-text">{fmtTokens(total)}</span>
        <span className="text-[10px] text-halo-muted">tokens</span>
      </div>
    </div>
  );
}
