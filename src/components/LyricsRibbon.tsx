import { useEffect, useRef, useState } from "react";
import type { MediaLyricsSnapshot } from "../mediaPrefs";
import { cssVarColor, rgbCss } from "../appearance";

/** Затухание по удалённости слота от активной строки; блюр соседей */
const ALPHA = [0.95, 0.5, 0.3, 0.16];
const BLUR = [0, 2, 5, 9];
// Фолбэки на случай пустых переменных (до первого applyAppearance)
const ACCENT_FALLBACK = "#d97757";
const MUTED_FALLBACK = "#9b9890";

/**
 * Лента строк лирики (Ambient Lyrics): большой текст песни поверх фона
 * чата — режим Spotify/YouTube-интеграции, НЕ модификация ambient-сцен
 * (фон остаётся как настроен). Референс: активная строка ярко со светом,
 * соседние гаснут и расплываются по удалённости. Цвета — из живой темы
 * (accent/muted): canvas не видит Tailwind-классы, читаем CSS-переменные
 * при каждой отрисовке. Фикс-слоты (рандом отброшен — вылезает за поля),
 * полоса композера резервируется. Статичный canvas БЕЗ rAF: перерисовка
 * только на смене строки/размере/ресайзе/теме.
 */
export function LyricsRibbon({
  snap,
  scale,
  composerCentered,
  contentLeft,
}: {
  snap: MediaLyricsSnapshot | null;
  /** Размер строк 0.3–1.0: от компактной полоски до «на весь экран» */
  scale: number;
  /** Композер центрирован (пустой чат): лента обходит центр */
  composerCentered: boolean;
  /** Ширина сайдбара — строки центрируются по зоне чата */
  contentLeft: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Счётчик перерисовки (не размер вьюпорта): ресайз и смена темы
  // инкрементят его, эффект отрисовки перезапускается
  const [repaint, setRepaint] = useState(0);
  useEffect(() => {
    const onResize = () => setRepaint((v) => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Тема применяется инлайн-стилем/классами на корне: без наблюдателя
  // цвета ленты оставались бы от прежней темы до следующей строки
  useEffect(() => {
    const mo = new MutationObserver(() => setRepaint((v) => v + 1));
    mo.observe(document.documentElement, {
      attributeFilter: ["class", "style"],
    });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!snap || snap.lines.length < 2) return;

    const accent = rgbCss(cssVarColor("--halo-accent", ACCENT_FALLBACK));
    const muted = rgbCss(cssVarColor("--halo-muted", MUTED_FALLBACK));
    const kegel = Math.max(16, h * 0.05 * scale);
    const spacing = kegel * 1.95;
    // Полоса композера: центрирован (пустой чат) — середина, иначе низ.
    // Активная строка садится НАД полосой (как на референсе)
    const bandTop = composerCentered ? h * 0.4 : h - kegel * 3.4;
    const bandBottom = composerCentered ? h * 0.63 : h;
    const anchorY = Math.max(kegel, bandTop - kegel * 0.7);
    const cx = contentLeft + (w - contentLeft) / 2;
    const maxW = Math.min(w - contentLeft - 48, w * 0.9);
    const family =
      getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
    const a = Math.max(0, Math.min(snap.index, snap.lines.length - 1));
    const slots: { text: string; y: number; dist: number }[] = [];
    for (let k = 3; k >= 1; k--) {
      const line = snap.lines[a - k];
      const y = anchorY - k * spacing;
      if (line && y > kegel * 0.8) slots.push({ text: line.text, y, dist: k });
    }
    const active = snap.lines[a];
    if (active) slots.push({ text: active.text, y: anchorY, dist: 0 });
    for (let k = 1; k <= 3; k++) {
      const line = snap.lines[a + k];
      const y = bandBottom + kegel * 0.4 + (k - 1) * spacing;
      if (line && y < h - kegel * 0.4) slots.push({ text: line.text, y, dist: k });
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const filterOk = "filter" in ctx;
    for (const s of slots) {
      // Референс — капсовый текст; для кириллицы тоже ок
      const text = s.text.toUpperCase();
      let size = s.dist === 0 ? kegel : kegel * 0.86;
      ctx.font = `600 ${size}px ${family}`;
      const tw = ctx.measureText(text).width;
      if (tw > maxW) {
        size = Math.max(kegel * 0.45, size * (maxW / tw));
        ctx.font = `600 ${size}px ${family}`;
      }
      const dist = Math.min(s.dist, 3);
      const blurPx = BLUR[dist] ?? 0;
      ctx.filter = filterOk && blurPx > 0 ? `blur(${blurPx}px)` : "none";
      if (s.dist === 0) {
        // Активная строка: свет — отдельным проходом (globalAlpha
        // умножает и тень, и заливку), начертание — поверх вторым
        ctx.fillStyle = accent;
        ctx.shadowColor = accent;
        ctx.shadowBlur = kegel * 0.55;
        ctx.globalAlpha = 0.35;
        ctx.fillText(text, cx, s.y);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = ALPHA[0] ?? 0.95;
        ctx.fillText(text, cx, s.y);
        ctx.globalAlpha = 1;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillStyle = muted;
        ctx.globalAlpha = ALPHA[dist] ?? 0.3;
        ctx.fillText(text, cx, s.y);
        ctx.globalAlpha = 1;
      }
      ctx.filter = "none";
      ctx.shadowBlur = 0;
    }
  }, [snap, scale, composerCentered, contentLeft, repaint]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[1]" aria-hidden>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
