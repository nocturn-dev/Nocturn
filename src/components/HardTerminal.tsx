import { STORAGE_KEYS } from "../storageKeys";
import { useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { ptyCreate, ptyResize, ptyWrite } from "../api";
import { usePtyRestart } from "../hooks/usePtyRestart";

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
  const pty = usePtyRestart(PTY_ID);
  const exitedRef = useRef(false);
  // Подсказка выхода: показывается 4с после входа, затем тает
  const [hintVisible, setHintVisible] = useState(true);

  const [termShell] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.termShell) ?? "auto";
    } catch {
      return "auto";
    }
  });
  // В pty_create уходит только то, что бекенд различает; остальное — auto
  const shellArg =
    termShell === "cmd" || termShell === "gitbash" || termShell === "powershell"
      ? termShell
      : undefined;

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
            // Фолбэки = байты палитры claude из index.css (:root): константы
            // дрейфовали от палитры (#1f1f1e против #1f1e1d и пр.) —
            // синхронизированы, чтобы деградация была неотличима от темы
            background: pick("--halo-deep", "#1f1e1d"),
            foreground: pick("--halo-text", "#e8e6dc"),
            cursor: pick("--halo-accent", "#d97757"),
            cursorAccent: pick("--halo-deep", "#1f1e1d"),
            selectionBackground: pick("--halo-accent", "#d97757") + "55",
            black: pick("--halo-line", "#3d3c38"),
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
          // Между kill и resolve create канал мёртв — печать в него
          // терялась, поэтому рестарт блокирует ввод
          if (!exitedRef.current && !pty.restartingRef.current)
            void ptyWrite(PTY_ID, data);
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
        // Размеры перед create считаю один раз через fit и без фолбэка
        // 120×34: шелл, стартовавший с неверной шириной, оставался
        // сломанным до первого ресайза
        fitRef.current.fit();
        const dims = fitRef.current.proposeDimensions();
        const ok = await pty.ensureCreated(() => {
          if (!dims || dims.cols <= 4 || dims.rows <= 2)
            return Promise.reject(new Error("terminal-size"));
          return ptyCreate(PTY_ID, cwd ?? null, dims.cols, dims.rows, shellArg);
        });
        // Поднять шелл не вышло — включаю режим рестарта по Enter вместо
        // молчаливого мёртвого экрана
        if (!ok && !pty.restartingRef.current) {
          exitedRef.current = true;
          term?.write(`\r\n\x1b[31m${t("terminal.spawnFailed")}\x1b[0m\r\n`);
        }
        if (disposed || !term) return;
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
      // Глушение шелла при закрытии — в usePtyRestart
      term?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Рестарт после выхода шелла — Enter. Слушаю window, а не host: фокус
  // мог остаться вне терминала (клик мимо host), и подсказка не срабатывала
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!exitedRef.current) return;
      // isComposing: энтер IME-композиции не перезапускает шелл
      if (e.key !== "Enter" || e.isComposing) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      exitedRef.current = false;
      // reset, а не clear: clear оставляет scrollback, и старый вывод
      // нового шелла оставался в истории прокрутки
      termRef.current?.reset();
      void pty
        .restart(async () => {
          const fit = fitRef.current;
          if (!fit) throw new Error("terminal-size");
          fit.fit();
          // Размеры один раз перед create, как при первичном запуске
          const dims = fit.proposeDimensions();
          if (!dims || dims.cols <= 4 || dims.rows <= 2)
            throw new Error("terminal-size");
          await ptyCreate(PTY_ID, cwd ?? null, dims.cols, dims.rows, shellArg);
        })
        .then((ok) => {
          if (ok) {
            termRef.current?.focus();
            return;
          }
          // Поднять шелл не вышло — возвращаю «мёртвый» режим, Enter
          // повторит попытку
          exitedRef.current = true;
          termRef.current?.write(
            `\r\n\x1b[31m${t("terminal.spawnFailed")}\x1b[0m\r\n`,
          );
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, shellArg, t]);

  return (
    <div
      onClick={() => termRef.current?.focus()}
      className="fixed inset-0 z-[var(--halo-z-splash)] flex flex-col"
      style={{ background: "var(--halo-deep)" }}
    >
      {/* Тонкая подсказка выхода: тает через 4 секунды */}
      <div
        className={`pointer-events-none absolute right-4 top-2 z-10 font-mono text-[0.625rem] tracking-wider text-halo-muted transition-opacity duration-700 ${
          hintVisible ? "opacity-70" : "opacity-0"
        }`}
      >
        {t("hard.hint", { combo })}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
