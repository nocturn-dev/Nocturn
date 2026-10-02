import { useEffect, useRef, useState } from "react";
import type { MediaLyricsSnapshot } from "../mediaPrefs";
import { cssVarColor, rgbCss } from "../appearance";

/** Затухание по удалённости слота от активной строки; блюр соседей */
const ALPHA = [0.95, 0.5, 0.3, 0.16];
const BLUR = [0, 2, 5, 9];
// Длительность кроссфейда смены активной строки
const FADE_MS = 400;
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
 * полоса композера резервируется. Статичный canvas БЕЗ постоянного rAF:
 * перерисовка на смене строки (кроссфейд 400 мс), размере, ресайзе, теме.
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
  // Кроссфейд смены активной строки: старая догорает на якоре, новая
  // проявляется; rAF живёт только FADE_MS. lines в стейте — валидность
  // фейда: при смене трека набор строк другой, догорать должна строка
  // СВОЕГО набора, поэтому чужой fade игнорируется при отрисовке
  const indexRef = useRef(-1);
  const prevLinesRef = useRef<MediaLyricsSnapshot["lines"] | null>(null);
  const fadeRef = useRef<{
    text: string;
    from: number;
    lines: MediaLyricsSnapshot["lines"];
    start: number;
  } | null>(null);
  const rafRef = useRef(0);

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

  // Смена активной строки → кроссфейд: rAF-цикл живёт только FADE_MS,
  // cleanup гасит его на анмаунте и при следующей смене (утечки нет).
  // Эффект объявлен ДО отрисовки: fadeRef ставится синхронно в том же
  // коммите — первый кадр перехода рисуется уже с ease≈0, без вспышки
  useEffect(() => {
    const idx = snap?.index ?? -1;
    if (idx === indexRef.current) return;
    const prev = indexRef.current;
    indexRef.current = idx;
    const sameLines =
      prevLinesRef.current !== null && prevLinesRef.current === snap?.lines;
    prevLinesRef.current = snap?.lines ?? null;
    // Старт/конец трека и смена набора строк — без фейда: догорать должна
    // строка своего набора, из чужого взятый текст был бы ложным
    if (prev === -1 || idx === -1 || !snap || !sameLines) return;
    fadeRef.current = {
      text: snap.lines[prev]?.text ?? "",
      from: prev,
      lines: snap.lines,
      start: performance.now(),
    };
    cancelAnimationFrame(rafRef.current);
    const step = () => {
      setRepaint((v) => v + 1);
      const f = fadeRef.current;
      if (f && performance.now() - f.start < FADE_MS) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fadeRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [snap]);

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
    // Кроссфейд: fade валиден, только пока набор строк тот же, на котором
    // он начат (смена трека его игнорирует); ease — smoothstep 0→1
    const fade =
      fadeRef.current && fadeRef.current.lines === snap.lines
        ? fadeRef.current
        : null;
    const fadeT = fade
      ? Math.min(1, (performance.now() - fade.start) / FADE_MS)
      : 1;
    const ease = fadeT * fadeT * (3 - 2 * fadeT);
    const slots: { text: string; y: number; dist: number; li: number }[] = [];
    for (let k = 3; k >= 1; k--) {
      const line = snap.lines[a - k];
      const y = anchorY - k * spacing;
      if (line && y > kegel * 0.8)
        slots.push({ text: line.text, y, dist: k, li: a - k });
    }
    const active = snap.lines[a];
    if (active) slots.push({ text: active.text, y: anchorY, dist: 0, li: a });
    for (let k = 1; k <= 3; k++) {
      const line = snap.lines[a + k];
      const y = bandBottom + kegel * 0.4 + (k - 1) * spacing;
      if (line && y < h - kegel * 0.4)
        slots.push({ text: line.text, y, dist: k, li: a + k });
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const filterOk = "filter" in ctx;
    for (const s of slots) {
      // Догорающая строка рисуется отдельно на якоре — из слота убираем,
      // иначе двойное начертание на время фейда
      if (fade && s.li === fade.from) continue;
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
        // умножает и тень, и заливку), начертание — поверх вторым;
        // на смене строки ease ведёт её от нуля к полной яркости
        ctx.fillStyle = accent;
        ctx.shadowColor = accent;
        ctx.shadowBlur = kegel * 0.55;
        ctx.globalAlpha = 0.35 * ease;
        ctx.fillText(text, cx, s.y);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = (ALPHA[0] ?? 0.95) * ease;
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
    // Догорание старой активной строки на её прежней позиции (якорь):
    // альфа и свечение гаснут зеркально проявлению новой
    if (fade && ease < 1 && fade.text) {
      const text = fade.text.toUpperCase();
      let size = kegel;
      ctx.font = `600 ${size}px ${family}`;
      const tw = ctx.measureText(text).width;
      if (tw > maxW) {
        size = Math.max(kegel * 0.45, size * (maxW / tw));
        ctx.font = `600 ${size}px ${family}`;
      }
      ctx.filter = "none";
      ctx.fillStyle = accent;
      ctx.shadowColor = accent;
      ctx.shadowBlur = kegel * 0.55;
      ctx.globalAlpha = 0.35 * (1 - ease);
      ctx.fillText(text, cx, anchorY);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = (ALPHA[0] ?? 0.95) * (1 - ease);
      ctx.fillText(text, cx, anchorY);
      ctx.globalAlpha = 1;
    }
  }, [snap, scale, composerCentered, contentLeft, repaint]);

  return (
    <div className="lyrics-ribbon pointer-events-none fixed inset-0" aria-hidden>
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
