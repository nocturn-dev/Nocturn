import { useEffect, useRef } from "react";

/**
 * Шар из орбитальных точек «Thinking» — React-порт SwiftUI-референса
 * (ThinkingOrbsBall, style 0): 150 точек по сфере Фибоначчи, дыхание
 * радиуса, двойное вращение вокруг Y с наклоном оси, перспективная
 * проекция с глубинным затуханием и auto-fit в квадрат размера.
 *
 * Цвет точек — токен темы (--halo-text): тёмный вариант даёт слоновую
 * кость, светлый — тёмный графит; перекрашивается на лету при смене темы.
 * Анимация через rAF; при prefers-reduced-motion рисуется один статичный
 * кадр (дыхание текста в пузыре гасится CSS-ом, здесь — той же логикой).
 */

const TAU = Math.PI * 2;
/** Период цикла, сек — как в референсе (period: 3.6) */
const PERIOD = 3.6;
/** Точек на сфере — NC(150, n=1) */
const DOTS = 150;
/** Доп. оборотов за период (knob spin) */
const SPIN = 2;
/** Наклон оси, рад (knob из rot) */
const TILT = 0.36;
/** Золотой угол сферы Фибоначчи */
const GOLDEN = 2.399963229728653;

/** Масштаб радиуса точек от размера шара — orbSizeDotScale из референса */
function dotScale(S: number): number {
  if (S <= 46) return 0.4;
  if (S <= 190) return 0.4 + ((S - 46) / 144) * 0.6;
  if (S <= 340) return 1 + ((S - 190) / 150) * 0.55;
  return 1.55;
}

interface OrbDot {
  x: number;
  y: number;
  r: number;
  a: number;
  z: number;
}

/** Точки фазы u (0..1) в боксе S при абсолютном масштабе точек ds (пиксельные координаты) */
function orbDots(u: number, S: number, ds: number): OrbDot[] {
  const h = S / 2;
  const R = S * 0.3;
  const f = 3.5;
  const cy1 = Math.cos(TAU * u);
  const sy1 = Math.sin(TAU * u);
  const cy2 = Math.cos(TAU * SPIN * u);
  const sy2 = Math.sin(TAU * SPIN * u);
  const cb = Math.cos(TILT);
  const sb = Math.sin(TILT);
  const out: OrbDot[] = [];
  for (let i = 0; i < DOTS; i++) {
    const y0 = 1 - (i / (DOTS - 1)) * 2;
    const r0 = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const th = i * GOLDEN;
    // Дыхание: радиус точки пульсирует волной по широте (как в draw0)
    const m = 1 + 0.13 * Math.sin(TAU * (u - 0.22 * (y0 + 1)));
    const x = Math.cos(th) * r0 * m;
    const y = y0 * m;
    const z = Math.sin(th) * r0 * m;
    // rot(yaw TAU*u, pitch TILT)
    const X = x * cy1 - z * sy1;
    let Z = x * sy1 + z * cy1;
    const Y = y * cb - Z * sb;
    Z = y * sb + Z * cb;
    // VIEW: второй yaw (spin) и перспективная проекция
    const X2 = X * cy2 - Z * sy2;
    const Z2 = X * sy2 + Z * cy2;
    const per = f / (f - Z2);
    const d = Math.min(1, Math.max(0, (Z2 + 1.1) / 2.2));
    out.push({
      x: h + X2 * R * per,
      y: h + Y * R * per,
      r: ds * (0.4 + 1.6 * d) * per * 0.85,
      a: (0.07 + 0.93 * Math.pow(d, 1.55)) * 0.9,
      z: Z2,
    });
  }
  return out;
}

/** Auto-fit в квадрат размера — orbFit из референса (проба 20 фаз, ds=1) */
function orbFit(S: number): number {
  const h = S / 2;
  let ext = 0;
  for (let k = 0; k < 20; k++) {
    for (const p of orbDots(k / 20, S, 1)) {
      if (p.a <= 0.05 || p.r <= 0.15) continue;
      ext = Math.max(ext, Math.abs(p.x - h) + p.r * 0.5, Math.abs(p.y - h) + p.r * 0.5);
    }
  }
  return ext > 1 ? Math.max(0.55, Math.min(1.7, (S * 0.415) / ext)) : 1;
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  S: number,
  u: number,
  fit: number,
  ink: string,
) {
  const h = S / 2;
  const dots = orbDots(u, S, dotScale(S)).sort((a, b) => a.z - b.z);
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = ink;
  for (const p of dots) {
    const fr = p.r * (0.55 + 0.45 * fit);
    if (fr <= 0.05 || p.a <= 0.004) continue;
    ctx.globalAlpha = Math.min(1, p.a);
    ctx.beginPath();
    ctx.arc(h + (p.x - h) * fit, h + (p.y - h) * fit, fr, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function ThinkingOrbs({ size = 30 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // DPR ограничиваем двойкой: шар мелкий, больше — даром жжём GPU
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fit = orbFit(size);
    const readInk = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--halo-text").trim() ||
      "#f0efec";
    const reduce =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      drawFrame(ctx, size, 0.12, fit, readInk());
      return;
    }
    let raf = 0;
    let frames = 0;
    let ink = readInk();
    const t0 = performance.now();
    const loop = (now: number) => {
      // Тема может смениться на ходу — токен перечитываем раз в ~0.7 с
      if (++frames % 42 === 0) ink = readInk();
      drawFrame(ctx, size, ((now - t0) / 1000 % PERIOD) / PERIOD, fit, ink);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden="true" />;
}
