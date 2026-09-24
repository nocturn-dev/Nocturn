import { useEffect, useMemo } from "react";
import type { Note } from "../vault";
import { extractLinks } from "../vault";
import { useLang } from "../locales";

/**
 * Монитор цепочки (M-N3.5): сплит — слева шаги со статусами,
 * справа граф, который «отрастает» по мере выполнения шагов:
 * узел появляется, когда шаг начался, пульсирует пока идёт,
 * зеленеет когда готов, серый пунктир — пропущен (abort).
 */

export type ChainStepStatus = "pending" | "running" | "done" | "skipped";

export interface ChainState {
  plan: Note[];
  current: number;
  status: ChainStepStatus[];
}

interface ChainMonitorProps {
  chain: ChainState | null;
  onClose: () => void;
}

const STEP_W = 200;
const STEP_H = 120;

export default function ChainMonitor({ chain, onClose }: ChainMonitorProps) {
  const { t } = useLang();
  // Пульсация текущего узла реализована CSS/SMIL-анимацией — раньше здесь
  // был ещё и setState-тик 600 мс, перерисовывавший всю модалку с SVG-графом
  // 1.6 раза в секунду без какой-либо пользы.

  // Esc — закрыть
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Раскладка: x = глубина в дереве ссылок, y — порядок внутри глубины
  const { pos, width, height } = useMemo(() => {
    const plan = chain?.plan ?? [];
    const byTitle = new Map(plan.map((n) => [n.title.toLowerCase(), n]));
    const depth = new Map<string, number>();
    const walk = (n: Note, d: number) => {
      if (depth.has(n.file)) return;
      depth.set(n.file, d);
      for (const link of extractLinks(n.content)) {
        const next = byTitle.get(link.toLowerCase());
        if (next) walk(next, d + 1);
      }
    };
    if (plan[0]) walk(plan[0], 0);

    const byDepth = new Map<number, Note[]>();
    for (const n of plan) {
      const d = depth.get(n.file) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxDepth = 0;
    let maxY = 0;
    for (const [d, group] of byDepth) {
      maxDepth = Math.max(maxDepth, d);
      group.forEach((n, i) => {
        const y = (i - (group.length - 1) / 2) * STEP_H;
        pos.set(n.file, { x: 40 + d * STEP_W, y: y });
        maxY = Math.max(maxY, Math.abs(y));
      });
    }
    return {
      pos,
      width: 120 + maxDepth * STEP_W,
      height: 160 + maxY * 2,
    };
  }, [chain]);

  if (!chain || chain.plan.length === 0) return null;

  const visible = (i: number) => chain.status[i] !== "pending";
  const byTitle = new Map(chain.plan.map((n) => [n.title.toLowerCase(), n]));
  const fileIndex = new Map(chain.plan.map((n, i) => [n.file, i]));

  const nodeColor = (st: ChainStepStatus) =>
    st === "done"
      ? "#5fbe82"
      : st === "running"
        ? "var(--halo-accent)"
        : st === "skipped"
          ? "var(--halo-muted)"
          : "var(--halo-line)";

  const statusLabel = (st: ChainStepStatus) =>
    st === "done"
      ? t("chain.done")
      : st === "running"
        ? t("chain.running")
        : st === "skipped"
          ? t("chain.skipped")
          : t("chain.pending");

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop relative flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-4 py-2.5">
          <span className="text-halo-accent">⛓</span>
          <h2 className="flex-1 text-sm font-semibold text-halo-text">
            {t("chain.title")}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Сплит: шаги | граф */}
        <div className="flex min-h-0 flex-1">
          {/* Шаги */}
          <div className="scroll-slim w-72 shrink-0 overflow-y-auto border-r border-halo-line px-3 py-3">
            {chain.plan.map((n, i) => {
              const st = chain.status[i];
              const agent = parseAgentFlag(n.content);
              return (
                <div
                  key={n.file}
                  className={`mb-1.5 flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                    st === "running"
                      ? "border-halo-accent/60 bg-halo-accent/10"
                      : "border-halo-line/60 bg-halo-surface/40"
                  }`}
                >
                  <span
                    className={`mt-1 size-2 shrink-0 rounded-full ${
                      st === "running" ? "animate-pulse" : ""
                    }`}
                    style={{ background: nodeColor(st) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-halo-text">
                      {i + 1}. {n.title}
                      {agent && (
                        <span
                          title="agent: true"
                          className="ml-1.5 rounded bg-sky-400/15 px-1 py-0.5 text-[9px] text-sky-400"
                        >
                          agent
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-halo-muted/70">
                      {statusLabel(st)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Граф */}
          <div className="min-w-0 flex-1">
            <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
              {/* Рёбра: появляются, когда видны оба конца */}
              {chain.plan.flatMap((n, i) =>
                visible(i)
                  ? extractLinks(n.content)
                      .map((link) => byTitle.get(link.toLowerCase()))
                      .filter((next): next is Note => !!next)
                      .map((next) => {
                        const j = fileIndex.get(next.file)!;
                        if (!visible(j)) return null;
                        const a = pos.get(n.file);
                        const b = pos.get(next.file);
                        if (!a || !b) return null;
                        const active =
                          chain.status[j] === "running" ||
                          (chain.status[i] === "running" && chain.status[j] !== "pending");
                        return (
                          <line
                            key={`${i}-${j}`}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={active ? "var(--halo-accent)" : "var(--halo-line)"}
                            strokeWidth={active ? 2 : 1.2}
                            strokeDasharray={chain.status[j] === "running" ? "6 4" : undefined}
                          />
                        );
                      })
                  : [],
              )}
              {/* Узлы */}
              {chain.plan.map((n, i) => {
                if (!visible(i)) return null;
                const p = pos.get(n.file);
                if (!p) return null;
                const st = chain.status[i];
                return (
                  <g key={n.file} transform={`translate(${p.x},${p.y})`}>
                    {st === "running" && (
                      <circle r={16} fill="none" stroke="var(--halo-accent)" strokeOpacity={0.4} strokeWidth={2}>
                        <animate attributeName="r" values="12;20;12" dur="1.6s" repeatCount="indefinite" />
                        <animate attributeName="stroke-opacity" values="0.5;0.1;0.5" dur="1.6s" repeatCount="indefinite" />
                      </circle>
                    )}
                    <circle
                      r={9}
                      fill={nodeColor(st)}
                      fillOpacity={st === "pending" ? 0.3 : 1}
                      stroke="var(--halo-surface)"
                      strokeWidth={2}
                    />
                    {st === "done" && (
                      <path
                        d="M-4 0 L-1 3 L4 -3"
                        fill="none"
                        stroke="#0e0f0d"
                        strokeWidth={2}
                        strokeLinecap="round"
                      />
                    )}
                    <text
                      y={24}
                      textAnchor="middle"
                      fill="var(--halo-text)"
                      fontSize={11}
                      className="select-none"
                    >
                      {n.title}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

/** frontmatter agent: true — бейдж на шаге */
function parseAgentFlag(content: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  return !!m && /^\s*agent\s*:\s*true\s*$/m.test(m[1]);
}
