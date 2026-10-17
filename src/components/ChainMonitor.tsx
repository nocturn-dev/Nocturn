import { useEffect, useMemo } from "react";
import type { Note } from "../vault";
import { extractLinks } from "../vault";
import { useLang } from "../locales";
import { STATUS_OK } from "../statusColors";
import { ChainIcon } from "./cards/icons";

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

  // Раскладка: x = глубина в дереве ссылок, y — порядок внутри глубины.
  // Пересчёт привязан к плану: chain пересоздаётся на каждом событии
  // прогона (статусы), а ссылки plan при этом стабильны — позиции не
  // должны пересобираться на каждый статус-тик
  const plan = chain?.plan ?? null;
  const { pos, width, height } = useMemo(() => {
    const nodes = plan ?? [];
    // Узлы идентифицируются ИНДЕКСОМ в плане: дубликаты file (две заметки
    // с одним именем) раньше затирали позицию друг друга и дублировали ключи
    const byTitle = new Map<string, number>();
    nodes.forEach((n, i) => {
      if (!byTitle.has(n.title.toLowerCase())) byTitle.set(n.title.toLowerCase(), i);
    });
    // Глубина — BFS от корня: обход в глубину фиксировал глубину первым
    // путём, и ромбовидная связь рисовалась длинным разрывом вместо
    // кратчайшего маршрута
    const depth = new Map<number, number>();
    if (nodes[0]) {
      depth.set(0, 0);
      const queue: number[] = [0];
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head]!;
        const n = nodes[i]!;
        const d = depth.get(i) ?? 0;
        for (const link of extractLinks(n.content)) {
          const j = byTitle.get(link.toLowerCase());
          if (j !== undefined && j !== i && !depth.has(j)) {
            depth.set(j, d + 1);
            queue.push(j);
          }
        }
      }
    }
    // Недостижимые от корня узлы — в общий столбец за последней достижимой
    // глубиной: раньше фолбэк-глубина 0 ставила их на корень и узлы налезали
    let reachableMax = 0;
    for (const d of depth.values()) reachableMax = Math.max(reachableMax, d);
    const byDepth = new Map<number, number[]>();
    nodes.forEach((_n, i) => {
      const d = depth.get(i) ?? reachableMax + 1;
      const bucket = byDepth.get(d);
      if (bucket) bucket.push(i);
      else byDepth.set(d, [i]);
    });
    const pos = new Map<number, { x: number; y: number }>();
    let maxDepth = 0;
    let maxY = 0;
    for (const [d, group] of byDepth) {
      maxDepth = Math.max(maxDepth, d);
      group.forEach((i, k) => {
        const y = (k - (group.length - 1) / 2) * STEP_H;
        pos.set(i, { x: 40 + d * STEP_W, y: y });
        maxY = Math.max(maxY, Math.abs(y));
      });
    }
    return {
      pos,
      width: 120 + maxDepth * STEP_W,
      height: 160 + maxY * 2,
    };
  }, [plan]);

  if (!chain || chain.plan.length === 0) return null;

  // Единственная точка чтения статуса: рассинхрон длин (status короче
  // плана) трактуем как pending — раньше «нет записи» был не-pending
  // в одних проверках и pending в других
  const statusAt = (i: number): ChainStepStatus => chain.status[i] ?? "pending";
  const visible = (i: number) => statusAt(i) !== "pending";
  const byTitle = new Map(chain.plan.map((n, i) => [n.title.toLowerCase(), i]));

  const nodeColor = (st: ChainStepStatus) =>
    st === "done"
      ? STATUS_OK
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
      className="anim-fade fixed inset-0 z-[var(--halo-z-modal)] flex items-center justify-center bg-halo-scrim p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop relative flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-4 py-2.5">
          <span className="text-halo-accent"><ChainIcon /></span>
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
              const st = statusAt(i);
              const agent = parseAgentFlag(n.content);
              return (
                <div
                  key={`${i}-${n.file}`}
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
                          className="ml-1.5 rounded bg-sky-400/15 px-1 py-0.5 text-[0.5625rem] text-sky-400"
                        >
                          agent
                        </span>
                      )}
                    </p>
                    <p className="text-[0.625rem] text-halo-muted/70">
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
                      .filter((next): next is number => next !== undefined && next !== i)
                      .map((j) => {
                        // fileIndex заполнен из тех же заметок: guard вместо
                        // non-null assertion — защита не исчезает при рефакторинге
                        if (!visible(j)) return null;
                        const a = pos.get(i);
                        const b = pos.get(j);
                        if (!a || !b) return null;
                        const active =
                          statusAt(j) === "running" ||
                          (statusAt(i) === "running" && statusAt(j) !== "pending");
                        return (
                          <line
                            key={`${i}-${j}`}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={active ? "var(--halo-accent)" : "var(--halo-line)"}
                            strokeWidth={active ? 2 : 1.2}
                            strokeDasharray={statusAt(j) === "running" ? "6 4" : undefined}
                          />
                        );
                      })
                  : [],
              )}
              {/* Узлы */}
              {chain.plan.map((n, i) => {
                if (!visible(i)) return null;
                const p = pos.get(i);
                if (!p) return null;
                const st = statusAt(i);
                return (
                  <g key={`${i}-${n.file}`} transform={`translate(${p.x},${p.y})`}>
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
  return !!m && /^\s*agent\s*:\s*true\s*$/m.test(m[1] ?? "");
}
