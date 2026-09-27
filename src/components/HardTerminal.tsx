import { useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { ptyCreate, ptyKill, ptyResize, ptyWrite } from "../api";

/**
 * Hard-Mode: полноэкранный живой PTY-терминал на xterm.js (та же библиотека,
 * что в VS Code — вся VT-математика: курсорная адресация, бэкспейс, redraw
 * строк). Основной UI остаётся примонтирован («спячка»), слой накрывает его;
 * выход — хоткей hard_mode (глобальный диспетчер). Шелл гасится при закрытии.
 * xterm подгружается динамически — обычным пользователям бандл не растёт.
 */

const PTY_ID = "haloui-hard-term";

export default function HardTerminal({ cwd, combo }: { cwd?: string; combo: string }) {
  const { t } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const createdRef = useRef(false);
  const exitedRef = useRef(false);
  const [exited, setExited] = useState(false);
  // Подсказка выхода: показывается 4с после входа, затем тает
  const [hintVisible, setHintVisible] = useState(true);

  const termShell = (() => {
    try {
      return localStorage.getItem("haloui-term-shell") ?? "auto";
    } catch {
      return "auto";
    }
  })();

  useEffect(() => {
    const t0 = window.setTimeout(() => setHintVisible(false), 4000);
    return () => window.clearTimeout(t0);
  }, []);

  useEffect(() => {
    let disposed = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    const unlistens: (() => void)[] = [];
    let ro: ResizeObserver | undefined;

    void (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;
        // Динамический импорт: xterm нужен только в Hard-Mode
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed) return;
        await import("@xterm/xterm/css/xterm.css");

        const css = getComputedStyle(document.documentElement);
        const pick = (name: string, fallback: string) =>
          css.getPropertyValue(name).trim() || fallback;

        term = new Terminal({
          fontFamily: pick(
            "--halo-font-mono",
            'ui-monospace, "Cascadia Mono", Consolas, monospace',
          ),
          fontSize: 12,
          cursorBlink: true,
          theme: {
            // фолбэк — дефолтный акцент проекта (#d97757): #7c5cff в палитрах
            // не существовал и при достижимости делал курсор чужим цветом
            background: pick("--halo-deep", "#1f1f1e"),
            foreground: pick("--halo-text", "#e8e6e3"),
            cursor: pick("--halo-accent", "#d97757"),
            cursorAccent: pick("--halo-deep", "#1f1f1e"),
            selectionBackground: pick("--halo-accent", "#d97757") + "55",
            black: pick("--halo-line", "#3a3936"),
          },
        });
        termRef.current = term;
        const fit = new FitAddon();
        fitRef.current = fit;
        term.loadAddon(fit);
        term.open(host);
        fit.fit();

        // Клавиатура/вставка: xterm сам превращает клавиши в VT-последовательности
        term.onData((data) => {
          if (!exitedRef.current) void ptyWrite(PTY_ID, data);
        });

        const { listen } = await import("@tauri-apps/api/event");
        const offOut = await listen<{ id: string; data: string }>("pty-output", (e) => {
          if (e.payload.id !== PTY_ID || disposed || !term) return;
          term.write(e.payload.data);
        });
        if (disposed) {
          offOut();
          return;
        }
        unlistens.push(offOut);
        const offExit = await listen<string>("pty-exit", (e) => {
          if (e.payload !== PTY_ID || disposed || !term) return;
          exitedRef.current = true;
          setExited(true);
          term.write(`\r\n\x1b[2m${t("terminal.exited")}\x1b[0m\r\n`);
        });
        if (disposed) {
          offExit();
          return;
        }
        unlistens.push(offExit);

        const syncSize = () => {
          if (disposed || !fitRef.current || !term) return;
          fitRef.current.fit();
          const dims = fitRef.current.proposeDimensions();
          if (dims && dims.cols > 4 && dims.rows > 2) {
            void ptyResize(PTY_ID, dims.cols, dims.rows).catch(() => {});
          }
        };
        if (!createdRef.current) {
          syncSize();
          const dims = fitRef.current.proposeDimensions();
          await ptyCreate(
            PTY_ID,
            cwd ?? null,
            dims?.cols ?? 120,
            dims?.rows ?? 34,
            termShell === "auto" ? undefined : termShell,
          );
          createdRef.current = true;
        }
        ro = new ResizeObserver(syncSize);
        ro.observe(host);
        term.focus();
      } catch {
        // Не Tauri / PTY недоступен / xterm не загрузился
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      for (const off of unlistens) off();
      if (createdRef.current) void ptyKill(PTY_ID).catch(() => {});
      createdRef.current = false;
      exitedRef.current = false;
      term?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Рестарт после выхода шелла: Enter в мёртвом терминале
  useEffect(() => {
    if (!exited) return;
    const host = hostRef.current;
    if (!host) return;
    const onKey = (e: KeyboardEvent) => {
      // isComposing: энтер IME-композиции не перезапускает шелл
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        setExited(false);
        exitedRef.current = false;
        termRef.current?.clear();
        void ptyKill(PTY_ID)
          .catch(() => {})
          .then(() =>
            ptyCreate(
              PTY_ID,
              cwd ?? null,
              fitRef.current?.proposeDimensions()?.cols ?? 120,
              fitRef.current?.proposeDimensions()?.rows ?? 34,
              termShell === "auto" ? undefined : termShell,
            ),
          );
      }
    };
    host.addEventListener("keydown", onKey);
    return () => host.removeEventListener("keydown", onKey);
  }, [exited, cwd, termShell]);

  return (
    <div
      onClick={() => termRef.current?.focus()}
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: "var(--halo-deep)" }}
    >
      {/* Тонкая подсказка выхода: тает через 4 секунды */}
      <div
        className={`pointer-events-none absolute right-4 top-2 z-10 font-mono text-[10px] tracking-wider text-halo-muted transition-opacity duration-700 ${
          hintVisible ? "opacity-70" : "opacity-0"
        }`}
      >
        {t("hard.hint", { combo })}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
