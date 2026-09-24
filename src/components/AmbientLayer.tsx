/**
 * Ambient-слой: процедурные сцены (canvas 2D) или своё видео пользователя.
 *
 * Принципы экономии, зашитые в реализацию:
 *  - 30 fps ceiling + пропуск кадра при скрытом окне и на паузе (стрим);
 *  - один resize-обработчик, devicePixelRatio ограничен двойкой;
 *  - слой pointer-events:none, z-ниже модалок; яркость — через
 *    --ambient-alpha (интенсивность в «Кастомизации»).
 * Сцены тёмные по природе — в светлой теме слой скрывается на уровне CSS.
 */

import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export type AmbientScene = "fog" | "snow" | "city" | "stars" | "video";

interface Blob {
  x: number;
  y: number;
  r: number;
  dx: number;
  dy: number;
  color: string;
}

interface Flake {
  x: number;
  y: number;
  r: number;
  vy: number;
  phase: number;
  alpha: number;
}

interface Building {
  x: number;
  w: number;
  h: number;
  lit: { x: number; y: number; phase: number }[];
}

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  speed: number;
}

function rng(seed: number) {
  // Детерминированный PRNG: сцена стабильна между перезапусками
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function AmbientLayer({
  scene,
  videoPath,
  brightness,
  density,
  paused,
}: {
  scene: AmbientScene;
  videoPath: string;
  /** Яркость слоя — дублирует CSS var --ambient-alpha (для <video> тоже) */
  brightness: number;
  /** Плотность сцены: множитель числа частиц/пятен/окон, 0.3–1.5 */
  density: number;
  paused: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedRef = useRef(paused);
  // Синхронизация через эффект: запись ref во время рендера — антипаттерн
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const isVideo = scene === "video";
  const src = isVideo && videoPath ? convertFileSrc(videoPath) : "";

  // Видео: пауза на стриме и в скрытом окне
  useEffect(() => {
    if (!isVideo) return;
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      if (pausedRef.current || document.hidden) v.pause();
      else void v.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [isVideo, paused, src]);

  useEffect(() => {
    if (isVideo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let alive = true;
    let raf = 0;
    let last = 0;
    let w = 0;
    let h = 0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rand = rng(scene === "fog" ? 42 : scene === "snow" ? 7 : scene === "city" ? 2026 : 1998);

    let blobs: Blob[] = [];
    let flakes: Flake[] = [];
    let buildings: Building[] = [];
    let stars: Star[] = [];

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (scene === "fog") {
        const colors = [
          "rgba(70, 100, 170, ",
          "rgba(90, 110, 180, ",
          "rgba(50, 80, 150, ",
          "rgba(110, 130, 200, ",
        ];
        blobs = Array.from({ length: Math.max(3, Math.round(6 * density)) }, (_, i) => ({
          x: Math.random() * w,
          y: Math.random() * h,
          r: (0.28 + Math.random() * 0.22) * Math.max(w, h),
          dx: (Math.random() - 0.5) * 0.12,
          dy: (Math.random() - 0.5) * 0.08,
          color: colors[i % colors.length],
        }));
      }
      if (scene === "snow") {
        flakes = Array.from({ length: Math.max(30, Math.round(150 * density)) }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.8 + Math.random() * 2.2,
          vy: 22 + Math.random() * 46,
          phase: Math.random() * Math.PI * 2,
          alpha: 0.35 + Math.random() * 0.5,
        }));
      }
      if (scene === "city") {
        buildings = [];
        let x = -20;
        while (x < w + 40) {
          const bw = 40 + rand() * 90;
          const bh = h * (0.14 + rand() * 0.34);
          const lit: Building["lit"] = [];
          const cols = Math.floor(bw / 14);
          const rows = Math.floor(bh / 18);
          for (let cx = 0; cx < cols; cx++) {
            for (let cy = 0; cy < rows; cy++) {
              if (rand() < Math.min(0.22 * density, 0.6)) {
                lit.push({ x: x + 6 + cx * 14, y: h - bh + 8 + cy * 18, phase: rand() * Math.PI * 2 });
              }
            }
          }
          buildings.push({ x, w: bw, h: bh, lit });
          x += bw + 6 + rand() * 18;
        }
      }
      if (scene === "stars") {
        stars = Array.from({ length: Math.max(30, Math.round(130 * density)) }, () => ({
          x: Math.random() * w,
          y: Math.random() * h * 0.85,
          r: 0.5 + Math.random() * 1.4,
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 1.2,
        }));
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const drawFog = () => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0a1230");
      g.addColorStop(0.55, "#0c1436");
      g.addColorStop(1, "#070a1c");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (const b of blobs) {
        b.x += b.dx;
        b.y += b.dy;
        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;
        const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        grad.addColorStop(0, `${b.color}0.16)`);
        grad.addColorStop(1, `${b.color}0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
      // лёгкая дымка у горизонта
      const haze = ctx.createLinearGradient(0, h * 0.7, 0, h);
      haze.addColorStop(0, "rgba(120, 150, 220, 0)");
      haze.addColorStop(1, "rgba(120, 150, 220, 0.07)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, h * 0.7, w, h * 0.3);
    };

    const drawSnow = (now: number) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0b0e2c");
      g.addColorStop(1, "#181c44");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // фонари: два тёплых пятна
      for (const fx of [w * 0.3, w * 0.72]) {
        const grad = ctx.createRadialGradient(fx, h * 0.24, 0, fx, h * 0.24, h * 0.4);
        grad.addColorStop(0, "rgba(150, 125, 255, 0.14)");
        grad.addColorStop(1, "rgba(150, 125, 255, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
      const t = now / 1000;
      for (const f of flakes) {
        f.y += (f.vy / 30) * 1.1;
        f.x += Math.sin(t * 0.9 + f.phase) * 0.35;
        if (f.y > h + 4) {
          f.y = -4;
          f.x = Math.random() * w;
        }
        ctx.globalAlpha = f.alpha;
        ctx.fillStyle = "#e8ecff";
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawCity = (now: number) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#04060d");
      g.addColorStop(1, "#0a1420");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // дымка над городом
      const haze = ctx.createLinearGradient(0, h * 0.35, 0, h);
      haze.addColorStop(0, "rgba(60, 140, 150, 0)");
      haze.addColorStop(1, "rgba(60, 140, 150, 0.10)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, w, h);
      for (const b of buildings) {
        ctx.fillStyle = "#070a10";
        ctx.fillRect(b.x, h - b.h, b.w, b.h);
        for (const win of b.lit) {
          const flicker = 0.55 + 0.45 * Math.sin(now / 900 + win.phase);
          ctx.fillStyle = `rgba(140, 210, 225, ${(0.28 * flicker).toFixed(3)})`;
          ctx.fillRect(win.x, win.y, 4, 6);
        }
      }
      // неоновое свечение самого высокого здания
      const tallest = buildings.reduce((a, b) => (b.h > a.h ? b : a), buildings[0]);
      if (tallest) {
        const grad = ctx.createRadialGradient(
          tallest.x + tallest.w / 2,
          h - tallest.h,
          0,
          tallest.x + tallest.w / 2,
          h - tallest.h,
          tallest.h * 0.9,
        );
        grad.addColorStop(0, "rgba(80, 220, 210, 0.10)");
        grad.addColorStop(1, "rgba(80, 220, 210, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
      // мигающий маячок
      const blink = Math.sin(now / 700) > 0.86 ? 0.8 : 0;
      if (blink > 0) {
        ctx.fillStyle = `rgba(255, 60, 60, ${blink})`;
        ctx.beginPath();
        ctx.arc(w * 0.08, h * 0.3, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawStars = (now: number) => {
      ctx.fillStyle = "#04060f";
      ctx.fillRect(0, 0, w, h);
      for (const nebulaColor of ["rgba(70, 100, 200, 0.05)", "rgba(120, 90, 200, 0.045)"]) {
        const grad = ctx.createRadialGradient(
          w * 0.7,
          h * 0.25,
          0,
          w * 0.7,
          h * 0.25,
          Math.max(w, h) * 0.5,
        );
        grad.addColorStop(0, nebulaColor);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
      const t = now / 1000;
      for (const st of stars) {
        const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * st.speed + st.phase));
        ctx.globalAlpha = a;
        ctx.fillStyle = "#dfe7ff";
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const render = (now: number) => {
      if (scene === "fog") drawFog();
      else if (scene === "snow") drawSnow(now);
      else if (scene === "city") drawCity(now);
      else drawStars(now);
    };

    const loop = (now: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      if (pausedRef.current || document.hidden) return;
      if (now - last < 33) return; // 30 fps ceiling
      last = now;
      render(now);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [scene, isVideo, density]);

  if (isVideo) {
    if (!src) return null;
    return (
      <div className="ambient-layer" style={{ opacity: brightness }} aria-hidden>
        <video ref={videoRef} className="ambient-video" src={src} autoPlay muted loop playsInline />
      </div>
    );
  }

  return (
    <div className="ambient-layer" style={{ opacity: brightness }} aria-hidden>
      <canvas ref={canvasRef} className="ambient-canvas" />
    </div>
  );
}
