import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../locales";
import { Vt, type VtSpan } from "../vt";
import { ptyCreate, ptyKill, ptyResize, ptyWrite } from "../api";

/**
 * Hard-Mode: полноэкранный живой PTY-терминал вместо интерфейса. Основной
 * UI остаётся примонтирован («спячка» — состояние чатов не теряется), этот
 * слой просто накрывает его. Шелл живёт, пока терминал открыт; закрытие —
 * глушит шелл (хоткей hard_mode обрабатывается глобальным диспетчером).
 */

const PTY_ID = "haloui-hard-term";

/** Строка экрана: спаны + курсор-блок */
function Row({ spans, cursor }: { spans: VtSpan[]; cursor: number }) {
  const els: React.ReactNode[] = [];
  let pos = 0;
  let cursorDone = cursor < 0;
  spans.forEach((sp, j) => {
    if (!cursorDone && cursor >= pos && cursor < pos + sp.text.length) {
      const at = cursor - pos;
      if (at > 0) {
        els.push(
          <span key={`${j}a`} style={{ color: sp.color, background: sp.bg }}>
            {sp.text.slice(0, at)}
          </span>,
        );
      }
      els.push(
        <span key="cursor" className="animate-pulse bg-halo-accent/80 text-halo-deep">
          {"\u00A0"}
        </span>,
      );
      cursorDone = true;
    }
    els.push(
      <span key={j} style={{ color: sp.color, background: sp.bg }}>
        {sp.text}
      </span>,
    );
    pos += sp.text.length;
  });
  if (!cursorDone && cursor >= pos) {
    els.push(
      <span key="cursor" className="animate-pulse bg-halo-accent/80 text-halo-deep">
        {"\u00A0"}
      </span>,
    );
  }
  return <>{els}</>;
}

export default function HardTerminal({ cwd, combo }: { cwd?: string; combo: string }) {
  const { t } = useLang();
  const COLS = 120;
  const ROWS = 34;
  const vtRef = useRef<Vt | null>(null);
  const [rows, setRows] = useState<Array<{ spans: VtSpan[]; cursor: number }>>([]);
  const createdRef = useRef(false);
  const exitedRef = useRef(false);
  const ptySizeRef = useRef({ cols: COLS, rows: ROWS });
  const termRef = useRef<HTMLDivElement>(null);
  // Подсказка выхода: показывается 4с после входа, затем тает
  const [hintVisible, setHintVisible] = useState(true);

  const termShell = (() => {
    try {
      return localStorage.getItem("haloui-term-shell") ?? "auto";
    } catch {
      return "auto";
    }
  })();

  const ensureVt = useCallback(() => {
    if (!vtRef.current) vtRef.current = new Vt(COLS, ROWS);
    return vtRef.current;
  }, []);

  useEffect(() => {
    const t0 = window.setTimeout(() => setHintVisible(false), 4000);
    return () => window.clearTimeout(t0);
  }, []);

  // PTY: создание + подписки (паттерн TerminalPanel: батчинг вывода,
  // unlisten'ы через массив, disposed-флаг)
  useEffect(() => {
    // Меряем контейнер ДО создания PTY: иначе первый ResizeObserver тут же
    // пересоздавал VT и PowerShell перерисовывал промпт (дубль в первой строке)
    const el = termRef.current;
    if (el) {
      const fontSize = parseFloat(window.getComputedStyle(el).fontSize || "12");
      const cols = Math.max(20, Math.min(500, Math.floor((el.clientWidth - 24) / (fontSize * 0.6))));
      const rowsCount = Math.max(5, Math.min(200, Math.floor((el.clientHeight - 12) / (fontSize * 1.5))));
      const vt = ensureVt();
      if (cols !== vt.cols || rowsCount !== vt.rowsCount) {
        vtRef.current = new Vt(cols, rowsCount);
        setRows(vtRef.current.render());
        ptySizeRef.current = { cols, rows: rowsCount };
      }
    }
    const vt = ensureVt();
    let disposed = false;
    const unlistens: (() => void)[] = [];
    let pending = "";
    let flushScheduled = false;
    let flushTimer: number | undefined;
    const flushVt = () => {
      flushScheduled = false;
      flushTimer = undefined;
      if (disposed || pending === "") return;
      vt.feed(pending);
      pending = "";
      const resp = vt.takeResponse();
      if (resp) void ptyWrite(PTY_ID, resp);
      setRows(vt.render());
    };
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      if (document.hidden) {
        flushTimer = window.setTimeout(flushVt, 50);
      } else {
        requestAnimationFrame(flushVt);
      }
    };
    void (async () => {
      try {
        if (!createdRef.current) {
          await ptyCreate(PTY_ID, cwd ?? null, COLS, ROWS, termShell === "auto" ? undefined : termShell);
          createdRef.current = true;
        }
        const offOut = await import("@tauri-apps/api/event").then(({ listen }) =>
          listen<{ id: string; data: string }>("pty-output", (e) => {
            if (e.payload.id !== PTY_ID || disposed) return;
            pending += e.payload.data;
            if (pending.length > 1_000_000) flushVt();
            else scheduleFlush();
          }),
        );
        if (disposed) {
          offOut();
          return;
        }
        unlistens.push(offOut);
        const offExit = await import("@tauri-apps/api/event").then(({ listen }) =>
          listen<string>("pty-exit", (e) => {
            if (e.payload !== PTY_ID || disposed) return;
            exitedRef.current = true;
            vt.feed(`\r\n\x1b[2m${t("terminal.exited")}\x1b[0m\r\n`);
            setRows(vt.render());
          }),
        );
        if (disposed) {
          offExit();
          return;
        }
        unlistens.push(offExit);
      } catch {
        // Не Tauri или PTY недоступен
      }
    })();
    return () => {
      disposed = true;
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      for (const off of unlistens) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Фокус: клавиши идут в PTY
  useEffect(() => {
    termRef.current?.focus();
  }, []);

  // Ресайз: ResizeObserver → cols/rows → ptyResize
  useEffect(() => {
    const el = termRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const fontSize = parseFloat(window.getComputedStyle(el).fontSize || "11.5");
      const charW = fontSize * 0.6;
      const lineH = fontSize * 1.5;
      const cols = Math.max(20, Math.min(500, Math.floor((el.clientWidth - 24) / charW)));
      const rowsCount = Math.max(5, Math.min(200, Math.floor((el.clientHeight - 12) / lineH)));
      if (cols !== ptySizeRef.current.cols || rowsCount !== ptySizeRef.current.rows) {
        ptySizeRef.current = { cols, rows: rowsCount };
        const vt = ensureVt();
        // Пересоздать VT под новую сетку (простая политика: содержимое
        // теряется — шелл продолжает, новые кадры в новых колонках)
        if (cols !== vt.cols || rowsCount !== vt.rowsCount) {
          vtRef.current = new Vt(cols, rowsCount);
          setRows(vtRef.current.render());
        }
        if (createdRef.current && !exitedRef.current) {
          void ptyResize(PTY_ID, cols, rowsCount).catch(() => {});
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ensureVt]);

  // Закрытие — глушим шелл
  useEffect(() => {
    return () => {
      if (createdRef.current) void ptyKill(PTY_ID).catch(() => {});
    };
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (exitedRef.current) {
      if (e.key === "Enter") {
        e.preventDefault();
        exitedRef.current = false;
        const vt = ensureVt();
        setRows(vt.render());
        createdRef.current = false;
        void ptyKill(PTY_ID)
          .catch(() => {})
          .then(() =>
            ptyCreate(PTY_ID, cwd ?? null, COLS, ROWS, termShell === "auto" ? undefined : termShell),
          );
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void ptyWrite(PTY_ID, "\r");
    } else if (e.key === "Backspace") {
      e.preventDefault();
      void ptyWrite(PTY_ID, "\x7f");
    } else if (e.key === "Tab") {
      e.preventDefault();
      void ptyWrite(PTY_ID, e.shiftKey ? "\x1b[Z" : "\t");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Печатные символы — в шелл посимвольно (иначе терминал «не печатает»)
      e.preventDefault();
      void ptyWrite(PTY_ID, e.key);
    } else if (e.ctrlKey && e.key.length === 1) {
      // Ctrl-коды (C, L, D, A, E…) — сыром в PTY
      e.preventDefault();
      const code = e.key.toUpperCase().charCodeAt(0) - 64;
      if (code > 0 && code < 27) void ptyWrite(PTY_ID, String.fromCharCode(code));
    } else if (e.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown", "Delete"].includes(e.key)) {
      // Навигационные клавиши — escape-последовательности
      e.preventDefault();
      const seqs: Record<string, string> = {
        ArrowUp: "\x1b[A",
        ArrowDown: "\x1b[B",
        ArrowRight: "\x1b[C",
        ArrowLeft: "\x1b[D",
        Home: "\x1b[H",
        End: "\x1b[F",
        PageUp: "\x1b[5~",
        PageDown: "\x1b[6~",
        Delete: "\x1b[3~",
      };
      const seq = seqs[e.key];
      if (seq) void ptyWrite(PTY_ID, e.shiftKey ? `${seq}` : seq);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      void ptyWrite(PTY_ID, text.replace(/\r?\n/g, "\r"));
    }
  };

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
      <div
        ref={termRef}
        tabIndex={0}
        onKeyDown={handleKey}
        onPaste={handlePaste}
        style={{ fontSize: "var(--halo-term-font, 12px)" }}
        className="scroll-slim min-h-0 flex-1 select-text overflow-y-auto px-3 py-2 font-mono leading-[1.45] text-halo-text outline-none"
      >
        {rows.map((r, i) => (
          <div key={i} className="whitespace-pre">
            <Row spans={r.spans} cursor={r.cursor} />
            {r.spans.length === 0 && r.cursor < 0 ? "\u00A0" : null}
          </div>
        ))}
      </div>
    </div>
  );
}
