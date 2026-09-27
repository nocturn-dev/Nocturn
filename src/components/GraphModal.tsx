import { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "../vault";
import { extractLinks } from "../vault";
import { useLang } from "../locales";

/**
 * Граф заметок (M-N2) в духе Obsidian: узлы — заметки, рёбра — [[ссылки]].
 * Свой мини force-симулятор (отталкивание + пружины + гравитация) без
 * внешних зависимостей; SVG-канвас с панорамированием и зумом.
 * Клик по узлу открывает заметку.
 */

interface GraphModalProps {
  notes: Note[];
  onOpenNote: (file: string) => void;
  onClose: () => void;
}

interface GNode {
  file: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  fixed: boolean;
}

interface GEdge {
  a: number;
  b: number;
}

const REST_LENGTH = 110;
const TICKS_MAX = 600;

export default function GraphModal({ notes, onOpenNote, onClose }: GraphModalProps) {
  const { t } = useLang();

  // Граф строится один раз на открытие
  const { nodes, edges } = useMemo(() => {
    const ns: GNode[] = notes.map((n, i) => {
      const angle = (i / Math.max(1, notes.length)) * Math.PI * 2;
      const r = 60 + 14 * Math.sqrt(notes.length);
      return {
        file: n.file,
        title: n.title,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        degree: 0,
        fixed: false,
      };
    });
    const byTitle = new Map<string, number>();
    ns.forEach((n, i) => byTitle.set(n.title.toLowerCase(), i));

    const es: GEdge[] = [];
    const seen = new Set<string>();
    notes.forEach((n, i) => {
      for (const link of extractLinks(n.content)) {
        const j = byTitle.get(link.toLowerCase());
        if (j === undefined || j === i) continue;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        es.push({ a: i, b: j });
        const na = ns[i];
        const nb = ns[j];
        if (!na || !nb) continue;
        na.degree++;
        nb.degree++;
      }
    });
    return { nodes: ns, edges: es };
  }, [notes]);

  const nodesRef = useRef(nodes);
  const [, setTick] = useState(0); // перерисовка после тиков физики
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const [hover, setHover] = useState<number | null>(null);
  /** force — симуляция; tree — иерархия развилок (уровни = глубина ссылок) */
  const [layout, setLayout] = useState<"force" | "tree">("force");

  // Раскладка деревом: BFS от самого связного корня, уровни — глубина,
  // развилки — дети под родителем (x — среднее детей, листья — по порядку)
  useEffect(() => {
    if (layout !== "tree") return;
    const ns = nodesRef.current;
    const n = ns.length;
    if (n === 0) return;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of edges) {
      adj[e.a]?.push(e.b);
      adj[e.b]?.push(e.a);
    }
    const depth: number[] = new Array(n).fill(-1);
    const parent: number[] = new Array(n).fill(-1);
    const order: number[] = [];
    const bfs = (root: number) => {
      depth[root] = 0;
      const queue = [root];
      while (queue.length) {
        const u = queue.shift() as number;
        order.push(u);
        for (const v of adj[u] ?? []) {
          const du = depth[u];
          if (du === undefined) continue;
          if (depth[v] === -1) {
            depth[v] = du + 1;
            parent[v] = u;
            queue.push(v);
          }
        }
      }
    };
    // Корень — самый связный; несвязные компоненты обходим следующими корнями
    let root = 0;
    for (let i = 1; i < n; i++) {
      if ((ns[i]?.degree ?? 0) > (ns[root]?.degree ?? 0)) root = i;
    }
    bfs(root);
    for (let i = 0; i < n; i++) if (depth[i] === -1) bfs(i);

    let leafX = 0;
    const xs = new Array(n).fill(0);
    const assignX = (u: number): number => {
      const kids = (adj[u] ?? []).filter((v) => parent[v] === u);
      if (kids.length === 0) {
        xs[u] = leafX++;
        return xs[u] ?? 0;
      }
      const cx = kids.reduce((acc, k) => acc + assignX(k), 0) / kids.length;
      xs[u] = cx;
      return cx;
    };
    for (const u of order) if (parent[u] === -1) {
      assignX(u);
      leafX += 1; // зазор между компонентами
    }

    const maxDepth = Math.max(...depth);
    for (let i = 0; i < n; i++) {
      const nd = ns[i];
      if (!nd) continue;
      nd.vx = 0;
      nd.vy = 0;
      nd.x = (xs[i] ?? 0) * 130;
      nd.y = (depth[i] ?? 0) * 95;
      // Изолированные узлы — нижним рядом
      if (nd.degree === 0) {
        nd.y = (maxDepth + 1) * 95;
      }
    }
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, nodes]);

  // ---------- Физика ----------
  useEffect(() => {
    if (layout === "tree") return; // дерево статично
    let tick = 0;
    let raf = 0;
    let last = 0;
    const startedAt = performance.now();
    const step = (now: number) => {
      // ~30 тиков/сек: перерисовка тяжёлого SVG каждый кадр (60fps)
      // на большом графе садит процессор — этого достаточно для плавности
      if (now - last < 33) {
        raf = requestAnimationFrame(step);
        return;
      }
      last = now;
      // Жёсткий лимит по времени: даже «живой» граф не крутится вечно
      if (now - startedAt > 5000) return;
      const ns = nodesRef.current;
      const n = ns.length;
      if (n === 0) return;
      let movement = 0;

      // Отталкивание (O(n²) — для сотен узлов ок)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = ns[i];
          const b = ns[j];
          if (!a || !b) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 1) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
            dist2 = 4;
          }
          const force = 2200 / dist2;
          const dist = Math.sqrt(dist2);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // Пружины по рёбрам
      for (const e of edges) {
        const a = ns[e.a];
        const b = ns[e.b];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - REST_LENGTH) * 0.015;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Гравитация к центру + интеграция с трением
      for (const nd of ns) {
        nd.vx -= nd.x * 0.003;
        nd.vy -= nd.y * 0.003;
        if (!nd.fixed) {
          nd.x += nd.vx;
          nd.y += nd.vy;
        }
        movement += Math.abs(nd.vx) + Math.abs(nd.vy);
        nd.vx *= 0.85;
        nd.vy *= 0.85;
      }

      tick++;
      setTick((v) => v + 1);
      if (movement > 0.5 && tick < TICKS_MAX) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    // Скрытое окно — физика не нужна
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(step);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, layout]); // FIX: layout читался в эффекте (строка выше), но не был в
  // зависимостях — после переключения tree→force rAF-цикл физики не запускался,
  // и граф замирал навсегда в позициях дерева

  // ---------- Pan / zoom / drag ----------
  const svgRef = useRef<SVGSVGElement>(null);

  // Колесо — нативный listener с passive:false: React вешает onWheel как
  // passive на корень, и e.preventDefault() внутри него — no-op
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((v) => ({
        ...v,
        scale: Math.min(3, Math.max(0.3, v.scale * factor)),
      }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);
  const [size, setSize] = useState({ w: 800, h: 500 });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dragNode = useRef<number | null>(null);
  const panning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - rect.width / 2 - view.tx) / view.scale,
      y: (clientY - rect.top - rect.height / 2 - view.ty) / view.scale,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragNode.current === null && !panning.current) return;
      // Отпускание кнопки за пределами окна: mouseup теряется — страховка
      if (e.buttons === 0) {
        if (dragNode.current !== null) {
          const moved = nodesRef.current[dragNode.current];
          if (moved) moved.fixed = false;
          dragNode.current = null;
        }
        panning.current = false;
        return;
      }
      if (dragNode.current !== null) {
        const nd = nodesRef.current[dragNode.current];
        if (!nd) return;
        const p = toWorld(e.clientX, e.clientY);
        nd.x = p.x;
        nd.y = p.y;
        nd.vx = nd.vy = 0;
        setTick((v) => v + 1);
      } else if (panning.current) {
        setView((v) => ({
          ...v,
          tx: panStart.current.tx + (e.clientX - panStart.current.x),
          ty: panStart.current.ty + (e.clientY - panStart.current.y),
        }));
      }
    };
    const onUp = () => {
      if (dragNode.current !== null) {
        const up = nodesRef.current[dragNode.current];
        if (up) up.fixed = false;
        dragNode.current = null;
      }
      panning.current = false;
    };
    const onBlur = () => {
      if (dragNode.current !== null) {
        const blurred = nodesRef.current[dragNode.current];
        if (blurred) blurred.fixed = false;
        dragNode.current = null;
      }
      panning.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.scale, view.tx, view.ty, layout]);

  // Esc — закрыть
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const neighbors = useMemo(() => {
    if (hover === null) return null;
    const set = new Set<number>([hover]);
    for (const e of edges) {
      if (e.a === hover) set.add(e.b);
      if (e.b === hover) set.add(e.a);
    }
    return set;
  }, [hover, edges]);

  const radius = (deg: number) => Math.min(14, 5 + deg * 2.5);

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-pane anim-pop relative flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-halo-line bg-halo-deep shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex shrink-0 items-center gap-2 border-b border-halo-line px-4 py-2.5">
          <span className="text-halo-accent">
            <GraphIcon />
          </span>
          <h2 className="flex-1 text-sm font-semibold text-halo-text">
            {t("notes.graph")}
          </h2>
          <span className="text-[11px] text-halo-muted/70">
            {nodes.length} · {edges.length}
          </span>
          {/* Раскладка: симуляция / дерево развилок */}
          <div className="flex gap-0.5 rounded-lg bg-halo-deep p-0.5">
            {(["force", "tree"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setLayout(m)}
                className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                  layout === m
                    ? "bg-halo-hover-strong text-halo-text"
                    : "text-halo-muted hover:text-halo-text"
                }`}
              >
                {t(m === "force" ? "notes.graphForce" : "notes.graphTree")}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Канвас */}
        {nodes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-halo-muted">
            {t("notes.graphEmpty")}
          </div>
        ) : (
          <svg
            ref={svgRef}
            className="h-full w-full cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => {
              panning.current = true;
              panStart.current = {
                x: e.clientX,
                y: e.clientY,
                tx: view.tx,
                ty: view.ty,
              };
            }}
          >
            <g
              transform={`translate(${size.w / 2 + view.tx}, ${size.h / 2 + view.ty}) scale(${view.scale})`}
            >
              {/* Рёбра */}
              {edges.map((e, i) => {
                const a = nodesRef.current[e.a];
                const b = nodesRef.current[e.b];
                if (!a || !b) return null;
                const active =
                  neighbors !== null && (neighbors.has(e.a) || neighbors.has(e.b));
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={active ? "var(--halo-accent)" : "var(--halo-line)"}
                    strokeOpacity={neighbors === null ? 0.9 : active ? 1 : 0.25}
                    strokeWidth={active ? 1.5 : 1}
                  />
                );
              })}
              {/* Узлы */}
              {nodesRef.current.map((nd, i) => {
                const dim = neighbors !== null && !neighbors.has(i);
                return (
                  <g
                    key={nd.file}
                    transform={`translate(${nd.x},${nd.y})`}
                    opacity={dim ? 0.3 : 1}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      dragNode.current = i;
                      nd.fixed = true;
                    }}
                    onClick={() => onOpenNote(nd.file)}
                  >
                    <circle
                      r={radius(nd.degree)}
                      fill="var(--halo-accent)"
                      fillOpacity={hover === i ? 1 : 0.75}
                      stroke="var(--halo-surface)"
                      strokeWidth={2}
                    />
                    <text
                      y={radius(nd.degree) + 12}
                      textAnchor="middle"
                      className="select-none"
                      fill="var(--halo-text)"
                      fontSize={11}
                    >
                      {nd.title}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {/* Подсказка */}
        <div className="shrink-0 border-t border-halo-line px-4 py-1.5 text-center text-[10px] text-halo-muted/60">
          {t("notes.graphHint")}
        </div>
      </div>
    </div>
  );
}

function GraphIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="19" cy="5" r="2.4" />
      <circle cx="12" cy="17" r="2.4" />
      <path d="M7 7.2 10.5 15M17 7 13.5 15M7.4 6H16.6" />
    </svg>
  );
}
