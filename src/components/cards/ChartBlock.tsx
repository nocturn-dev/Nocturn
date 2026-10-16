import { useEffect, useRef, useState } from "react";
import type uPlot from "uplot";
import { parseChartBlock } from "../../chartQuiz";
import { useLang } from "../../locales";

/** Палитра из CSS-переменных темы: canvas uPlot CSS-переменные не видит
 *  (прецедент xterm); перерисовка — на смене класса light на <html> */
function themeColors(): {
  text: string;
  muted: string;
  line: string;
  accent: string;
  series: string[];
} {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    text: pick("--halo-text", "#e8e6dc"),
    muted: pick("--halo-muted", "#8f8d88"),
    line: pick("--halo-line", "#3a3936"),
    accent: pick("--halo-accent", "#c88e9b"),
    series: [
      pick("--halo-accent", "#c88e9b"),
      pick("--halo-live", "#7fa6a3"),
      "#e0b060",
      "#8fb573",
      "#a08ec4",
      "#c47f8f",
      "#7f9fc4",
      "#c4a77f",
    ],
  };
}

function useThemeLight(): boolean {
  const [light, setLight] = useState(() =>
    document.documentElement.classList.contains("light"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setLight(document.documentElement.classList.contains("light")),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return light;
}

/** Пирог: uPlot не рисует pie по идеологии (x/y-библиотека) — дуги SVG.
 *  Возвращает path сегмента-доли (donut-кольцо при hole > 0) */
function pieSlice(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  from: number,
  to: number,
): string {
  const pt = (r: number, a: number) =>
    `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  const large = to - from > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rOuter, from).split(" ");
  const [x1, y1] = pt(rOuter, to).split(" ");
  if (rInner <= 0) {
    return `M ${cx} ${cy} L ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} Z`;
  }
  const [x2, y2] = pt(rInner, to).split(" ");
  const [x3, y3] = pt(rInner, from).split(" ");
  return `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3} Z`;
}

/** Диаграмма из ```chart-блока ответа модели. uPlot — ленивый импорт
 *  (тяжёлый, отдельный чанк при первой диаграмме); битый/недопечатанный
 *  блок → обычный код (паттерн MermaidBlock) */
export function ChartBlock({ code }: { code: string }) {
  const { t } = useLang();
  const spec = parseChartBlock(code);
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const light = useThemeLight();
  const [ready, setReady] = useState(false);
  const [showCode, setShowCode] = useState(false);
  // Спецификация и тема — в ref: перерисовка графика без ре-рендера React
  const drawRef = useRef({ spec, light });
  drawRef.current = { spec, light };

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      try {
        const [U, ] = await Promise.all([
          import("uplot"),
          import("uplot/dist/uPlot.min.css"),
        ]);
        if (cancelled || !hostRef.current) return;
        const host = hostRef.current;
        const build = () => {
          const s = drawRef.current.spec;
          if (!s) return;
          const c = themeColors();
          host.innerHTML = "";
          const width = host.clientWidth || 320;
          const height = Math.min(260, Math.max(160, Math.round(width / 2.4)));
          if (s.type === "pie") {
            setReady(true);
            return;
          }
          const xData =
            s.labels.length === s.series[0]!.values.length
              ? s.labels.map((_, i) => i)
              : s.series[0]!.values.map((_, i) => i);
          const common = {
            width,
            height,
            legend: { show: s.series.length > 1 || s.series[0]!.name !== "S1" },
            cursor: { show: false },
            scales: { x: { time: false } },
            axes: [
              {
                stroke: c.muted,
                grid: { show: false },
                ticks: { show: false },
                label: s.xLabel,
                labelSize: 16,
                labelFont: "10px sans-serif",
                font: "10px sans-serif",
              },
              {
                stroke: c.muted,
                grid: { stroke: c.line, width: 1 },
                ticks: { show: false },
                label: s.yLabel,
                labelSize: 16,
                labelFont: "10px sans-serif",
                font: "10px sans-serif",
                side: 3,
              },
            ] as NonNullable<uPlot.Options["axes"]>,
          };
          const data: uPlot.AlignedData = [
            xData,
            ...s.series.map((sr) => sr.values),
          ];
          if (s.labels.length === xData.length) {
            // Категориальные метки вместо числовых тиков
            const xAxis = common.axes[0]!;
            xAxis.values = (_u: unknown, ticks: number[]) =>
              ticks.map((i) => s.labels[i] ?? "");
          }
          const series: uPlot.Options["series"] = [
            {},
            ...s.series.map((sr, i) => ({
              label: sr.name,
              stroke: c.series[i % c.series.length]!,
              width: 2,
              fill:
                s.type === "bar"
                  ? `${c.series[i % c.series.length]}55`
                  : undefined,
              points: { show: s.series[0]!.values.length <= 16 },
              paths:
                s.type === "bar"
                  ? U.default.paths.bars!({ size: [0.6, 100] })
                  : undefined,
            })),
          ];
          plotRef.current?.destroy();
          plotRef.current = new U.default(
            { ...common, series } as uPlot.Options,
            data,
            host,
          );
          setReady(true);
        };
        build();
        ro = new ResizeObserver(() => {
          const u = plotRef.current;
          if (!u || !host.clientWidth) return;
          u.setSize({
            width: host.clientWidth,
            height: u.height,
          });
        });
        ro.observe(host);
      } catch {
        if (!cancelled) setReady(false);
      }
    })();
    return () => {
      cancelled = true;
      ro?.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // spec из пропа code: пересоздание только на смене блока или темы
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, light]);

  if (!spec) {
    return (
      <pre className="overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-code-bg px-3 py-2 text-xs leading-relaxed text-halo-text">
        {code}
      </pre>
    );
  }

  if (spec.type === "pie") {
    const values = spec.series[0]!.values.map((v) => v ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    const c = themeColors();
    const size = 180;
    const cx = size / 2;
    let angle = -Math.PI / 2;
    const slices = values.map((v, i) => {
      const sweep = total > 0 ? (v / total) * Math.PI * 2 : 0;
      const path = pieSlice(cx, cx, cx - 2, 0, angle, angle + sweep);
      angle += sweep;
      return { path, color: c.series[i % c.series.length]!, i };
    });
    return (
      <div className="my-1 rounded-lg border border-halo-line/60 bg-halo-deep/40 px-2 py-3">
        {spec.title && (
          <div className="mb-1 text-center text-xs text-halo-muted">{spec.title}</div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-4">
          <svg width={size} height={size} role="img">
            {slices.map((s) => (
              <path key={s.i} d={s.path} fill={s.color} stroke="none" />
            ))}
          </svg>
          <ul className="space-y-1 text-xs">
            {spec.labels.map((label, i) => (
              <li key={i} className="flex items-center gap-1.5 text-halo-text">
                <span
                  className="inline-block size-2 rounded-sm"
                  style={{ background: c.series[i % c.series.length] }}
                />
                {label}
                <span className="text-halo-muted">
                  {total > 0 ? `${Math.round(((values[i] ?? 0) / total) * 100)}%` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="group/code relative my-1">
      <button
        onClick={() => setShowCode((v) => !v)}
        title={showCode ? t("md.showDiagram") : t("md.showCode")}
        className="absolute right-2 top-2 z-10 rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[0.625rem] text-halo-muted opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-halo-text"
      >
        {showCode ? "▦" : "</>"}
      </button>
      {spec.title && (
        <div className="mb-1 text-center text-xs text-halo-muted">{spec.title}</div>
      )}
      {showCode ? (
        <pre className="overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-code-bg px-3 py-2 text-xs leading-relaxed text-halo-text">
          {code}
        </pre>
      ) : (
        <div
          ref={hostRef}
          className="rounded-lg border border-halo-line/60 bg-halo-deep/40 px-2 py-3"
          style={{ display: ready ? undefined : "none" }}
        />
      )}
    </div>
  );
}
