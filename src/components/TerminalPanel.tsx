import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Message, Session, ToolCallInfo } from "../types";
import {
  diffLines,
  diffStats,
  parseWriteResult,
  summarizeArguments,
} from "../diff";
import { ptyCreate, ptyKill, ptyWrite } from "../api";
import { Vt, type VtSpan } from "../vt";
import { useLang } from "../locales";

/**
 * Терминальная панель с двумя режимами:
 * - «Агент» (M4.5): append-only текстовая проекция агентной сессии,
 *   подтверждения клавишами [y/a/n] прямо в терминале.
 * - «Консоль» (M6): настоящий интерактивный PTY (PowerShell) с нашим
 *   VT-эмулятором (src/vt.ts) — команды печатает сам пользователь.
 *
 * Рендер собственный (без xterm.js): раскладку гарантирует CSS.
 */

interface TerminalPanelProps {
  session: Session | null;
  /** id ассистентского сообщения, которое сейчас стримится */
  streamingMsgId: string | null;
  pendingConfirm: { requestId: string; call: ToolCallInfo } | null;
  /** Корень проекта — рабочая папка консоли (M4.2) */
  projectRoot: string | null;
  /** Оболочка консоли: auto | powershell | cmd | gitbash */
  termShell: string;
  /** Высота панели, % от чата (drag за верхнюю границу) */
  heightPct: number;
  onResizeStart: () => void;
  onConfirmDecision: (d: "once" | "always" | "deny") => void;
  onClose: () => void;
}

const PTY_ID = "haloui-console";
const PTY_COLS = 120;
const PTY_ROWS = 33;

/** ANSI SGR-коды в палитре HaloUI (акцент #D97757) */
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  accent: "\x1b[38;2;217;119;87m",
  cyan: "\x1b[38;2;94;175;220m",
  green: "\x1b[38;2;95;190;130m",
  red: "\x1b[38;2;214;100;100m",
  yellow: "\x1b[38;2;212;170;80m",
};

/** Экранирование внешнего текста: без своих ANSI-последовательностей, \n → \r\n */
function esc(s: string): string {
  return s.replace(/\x1b/g, "^[")
    .replace(/\r/g, "")
    .replace(/\n/g, "\r\n");
}

interface Span {
  text: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  color?: string;
}

type Line = Span[];

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  color?: string;
}

/** Применяем SGR-параметры (поддерживаем ровно те коды, что эмитим сами) */
function applySgr(params: string, st: SgrState) {
  const parts = params.split(";").filter((p) => p !== "").map(Number);
  if (parts.length === 0) {
    st.bold = st.dim = st.italic = false;
    st.color = undefined;
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 0) {
      st.bold = st.dim = st.italic = false;
      st.color = undefined;
    } else if (p === 1) st.bold = true;
    else if (p === 2) st.dim = true;
    else if (p === 3) st.italic = true;
    else if (p === 22) { st.bold = false; st.dim = false; }
    else if (p === 23) st.italic = false;
    else if (p === 39) st.color = undefined;
    else if (p === 38 && parts[i + 1] === 2) {
      st.color = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
      i += 4;
    }
  }
}

function spanStyle(sp: Span | VtSpan): CSSProperties {
  const s = sp as VtSpan;
  return {
    fontWeight: sp.bold ? 600 : undefined,
    fontStyle: sp.italic ? "italic" : undefined,
    opacity: sp.dim ? 0.55 : undefined,
    color: sp.color,
    backgroundColor: s.bg,
  };
}

/** Состояние проекции последнего (незапечатанного) сообщения */
interface LiveState {
  id: string;
  header: boolean;
  thought: number;
  content: number;
  calls: number;
  body: boolean; // tool-сообщение отрисовано целиком
  usage: boolean;
}

const freshLive = (id: string): LiveState => ({
  id,
  header: false,
  thought: 0,
  content: 0,
  calls: 0,
  body: false,
  usage: false,
});

type PanelMode = "agent" | "console";

export default function TerminalPanel({
  session,
  streamingMsgId,
  pendingConfirm,
  projectRoot,
  termShell,
  heightPct,
  onResizeStart,
  onConfirmDecision,
  onClose,
}: TerminalPanelProps) {
  const { t } = useLang();
  const [mode, setMode] = useState<PanelMode>("agent");
  const scrollRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<Line[]>([]);
  const sgrRef = useRef<SgrState>({ bold: false, dim: false, italic: false });
  const [lines, setLines] = useState<Line[]>([]);
  const [awaiting, setAwaiting] = useState(false);
  const awaitingRef = useRef(false);
  const decisionRef = useRef(onConfirmDecision);
  decisionRef.current = onConfirmDecision;

  /** Дописываем ANSI-строку в буфер строк (append-only) */
  const write = (s: string) => {
    const buf = linesRef.current;
    if (buf.length === 0) buf.push([]);
    let cur = buf[buf.length - 1];

    const emitText = (text: string) => {
      const parts = text.split("\r\n");
      parts.forEach((p, i) => {
        if (i > 0) {
          cur = [];
          buf.push(cur);
        }
        if (p) cur.push({ text: p, ...sgrRef.current });
      });
    };

    const re = /\x1b\[([0-9;]*)([a-zA-Z])/g;
    let idx = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > idx) emitText(s.slice(idx, m.index));
      idx = re.lastIndex;
      if (m[2] === "m") applySgr(m[1], sgrRef.current);
    }
    if (idx < s.length) emitText(s.slice(idx));

    setLines([...buf]);
  };

  // ---------- Приветствие при монтировании ----------
  useEffect(() => {
    const title = session?.title ?? "—";
    write(
      `${C.dim}Nocturn · ${t("terminal.welcome")} · ${esc(title)}${C.reset}\r\n` +
        `${C.dim}${t("terminal.hint")}${C.reset}\r\n`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Append-only проекция сообщений (режим «Агент») ----------
  const cursorRef = useRef(0); // индекс первого незапечатанного сообщения
  const liveRef = useRef<LiveState>(freshLive(""));

  useEffect(() => {
    const msgs = session?.messages ?? [];

    const writeToolBlock = (m: Message, st: LiveState) => {
      st.body = true;
      const name =
        m.toolName ??
        msgs
          .flatMap((x) => x.toolCalls ?? [])
          .find((tc) => tc.id === m.toolCallId)?.name ??
        "?";
      const denied = m.content === t("agent.denied");
      const toolError = m.content.startsWith("tool error:");
      const parsed =
        name === "fs_write" && !denied && !toolError
          ? parseWriteResult(m.content)
          : null;

      if (denied || toolError) {
        write(
          `  ${C.red}⎿ ${name} · ${denied ? t("agent.denied") : t("agent.errorResult")}${C.reset}`,
        );
        return;
      }

      if (parsed) {
        const diff = diffLines(parsed.before ?? "", parsed.after);
        const { added, removed } = diffStats(diff);
        const label = parsed.created ? t("agent.diffCreated") : name;
        write(
          `  ${C.green}⎿ ${label}${C.reset} ${C.dim}${parsed.path}${C.reset} ${C.green}+${added}${C.reset} ${C.red}−${removed}${C.reset}`,
        );
        // Мини-превью диффа: первые 8 значимых строк
        const meaningful = diff.filter((l) => l.type !== "ctx" || l.text.trim() !== "");
        let shown = 0;
        for (const l of meaningful) {
          if (shown >= 8) {
            write(`\r\n    ${C.dim}… +${meaningful.length - shown} ${C.reset}`);
            break;
          }
          const sign = l.type === "del" ? "-" : l.type === "add" ? "+" : " ";
          const color = l.type === "del" ? C.red : l.type === "add" ? C.green : C.dim;
          write(`\r\n    ${color}${sign} ${esc(l.text)}${C.reset}`);
          shown++;
        }
        return;
      }

      // shell_run: команда + exit-код; остальное — первые строки вывода
      const exitMatch = m.content.match(/exit code: (-?\d+)/);
      const exit = exitMatch ? parseInt(exitMatch[1], 10) : null;
      const failed = exit !== null && exit !== 0;
      const statusColor = failed ? C.red : C.green;
      const args =
        msgs
          .flatMap((x) => x.toolCalls ?? [])
          .find((tc) => tc.id === m.toolCallId)?.arguments ?? "";
      write(
        `  ${C.cyan}⎿ ${name}${C.reset} ${C.dim}${esc(summarizeArguments(name, args))}${C.reset} ${statusColor}${exit !== null ? `exit ${exit}` : ""}${C.reset}`,
      );
      const body = m.content
        .split("\n")
        .filter((l) => !/^exit code:/.test(l) && !/^--- (stdout|stderr) ---$/.test(l))
        .filter((l) => l.trim() !== "" && l.trim() !== "(empty)")
        .slice(0, 6);
      for (const l of body) {
        write(`\r\n    ${C.dim}${esc(l)}${C.reset}`);
      }
      const totalLines = m.content.split("\n").length;
      if (totalLines > 8) {
        write(`\r\n    ${C.dim}… (${totalLines - 6})${C.reset}`);
      }
    };

    const renderLive = (m: Message, st: LiveState) => {
      // Пустые ассистентские карточки — placeholders стрима, пропускаем
      if (m.role === "assistant" && !m.content && !m.thought && !m.toolCalls) {
        return;
      }

      if (!st.header) {
        st.header = true;
        if (m.role === "user") {
          write(`\r\n${C.accent}${C.bold}❯${C.reset} `);
        } else if (m.role === "assistant") {
          write(`\r\n${C.accent}●${C.reset} `);
        } else if (m.role === "tool") {
          writeToolBlock(m, st);
        }
      }

      if (m.role === "user" && m.content.length > st.content) {
        write(esc(m.content.slice(st.content)));
        st.content = m.content.length;
      }

      if (m.role === "assistant") {
        if (m.thought && m.thought.length > st.thought) {
          if (st.thought === 0) write(`${C.dim}${C.italic}`);
          write(esc(m.thought.slice(st.thought)));
          st.thought = m.thought.length;
        }
        if (m.content && m.content.length > st.content) {
          if (st.content === 0) write("\r\n");
          write(esc(m.content.slice(st.content)));
          st.content = m.content.length;
        }
        const calls = m.toolCalls ?? [];
        for (; st.calls < calls.length; st.calls++) {
          const tc = calls[st.calls];
          write(
            `\r\n  ${C.cyan}◆ ${tc.name}${C.reset} ${C.dim}${esc(summarizeArguments(tc.name, tc.arguments))}${C.reset}`,
          );
        }
        if (m.usage && !st.usage) {
          st.usage = true;
          write(`\r\n  ${C.dim}↑${m.usage.prompt} ↓${m.usage.completion}${C.reset}`);
        }
      }
    };

    for (let i = cursorRef.current; i < msgs.length; i++) {
      const m = msgs[i];
      if (liveRef.current.id !== m.id) {
        // Запечатываем предыдущее живое сообщение и начинаем новое
        if (liveRef.current.header) write("\r\n");
        liveRef.current = freshLive(m.id);
      }
      const st = liveRef.current;
      renderLive(m, st);
      if (i < msgs.length - 1) {
        if (!st.body && st.header) write("\r\n");
        cursorRef.current = i + 1;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, streamingMsgId, t]);

  // ---------- Подтверждение в терминале ----------
  useEffect(() => {
    if (pendingConfirm && !awaitingRef.current) {
      awaitingRef.current = true;
      setAwaiting(true);
      // Подтверждение относится к агенту — показываем его режим
      setMode("agent");
      const s = summarizeArguments(
        pendingConfirm.call.name,
        pendingConfirm.call.arguments,
      );
      write(
        `\r\n${C.yellow}${C.bold}⚠ ${t("agent.confirmTitle")}${C.reset}\r\n${C.yellow}  ${pendingConfirm.call.name}${C.reset} ${C.dim}${esc(s)}${C.reset}\r\n${C.yellow}  [y] ${t("terminal.yes")} · [a] ${t("terminal.always")} · [n] ${t("terminal.no")}${C.reset}`,
      );
    } else if (!pendingConfirm && awaitingRef.current) {
      // Решение пришло из чат-карточки или отменено — закрываем строку
      awaitingRef.current = false;
      setAwaiting(false);
      write("\r\n");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConfirm, t]);

  // Клавиши y/a/n: пока терминал ждёт решение; поля ввода чата не перехватываем
  useEffect(() => {
    if (!awaiting) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable)
      ) {
        return;
      }
      // Раскладконезависимо: действие определяем по e.code — физическая
      // клавиша Y/A/N (на русской раскладке Y даёт e.key = «н»)
      const action =
        e.code === "KeyY"
          ? "once"
          : e.code === "KeyA"
            ? "always"
            : e.code === "KeyN"
              ? "deny"
              : null;
      if (action) {
        e.preventDefault();
        awaitingRef.current = false;
        setAwaiting(false);
        const label =
          action === "once"
            ? `${C.green} ${t("terminal.yes")}${C.reset}`
            : action === "always"
              ? `${C.green} ${t("terminal.always")}${C.reset}`
              : `${C.red} ${t("terminal.no")}${C.reset}`;
        write(label + "\r\n");
        decisionRef.current(action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, t]);

  // ---------- Режим «Консоль»: PTY + VT-эмулятор (M6) ----------
  const vtRef = useRef<Vt>(new Vt(PTY_COLS, PTY_ROWS));
  const createdRef = useRef(false);
  const exitedRef = useRef(false);
  const [consoleRows, setConsoleRows] = useState(vtRef.current.render());

  // Создание PTY и подписка на вывод — при первом включении консоли
  useEffect(() => {
    if (mode !== "console") return;
    let disposed = false;
    // Unlisten'ы собираем в массив: async-IIFE возвращает промис, а не cleanup,
    // поэтому подписки снимаем только через внешний cleanup эффекта
    const unlistens: (() => void)[] = [];
    void (async () => {
      try {
        if (!createdRef.current) {
          await ptyCreate(
            PTY_ID,
            projectRoot,
            PTY_COLS,
            PTY_ROWS,
            termShell === "auto" ? undefined : termShell,
          );
          createdRef.current = true;
        }
        const offOut = await listen<{ id: string; data: string }>(
          "pty-output",
          (e) => {
            if (e.payload.id !== PTY_ID || disposed) return;
            vtRef.current.feed(e.payload.data);
            const resp = vtRef.current.takeResponse();
            if (resp) void ptyWrite(PTY_ID, resp);
            setConsoleRows(vtRef.current.render());
          },
        );
        if (disposed) {
          offOut();
          return;
        }
        unlistens.push(offOut);
        const offExit = await listen<string>("pty-exit", (e) => {
          if (e.payload !== PTY_ID || disposed) return;
          exitedRef.current = true;
          vtRef.current.feed(`\r\n\x1b[2m${t("terminal.exited")}\x1b[0m\r\n`);
          setConsoleRows(vtRef.current.render());
        });
        if (disposed) {
          offExit();
          return;
        }
        unlistens.push(offExit);
      } catch {
        // Не Tauri или PTY недоступен — консоль просто не отвечает
      }
    })();
    return () => {
      disposed = true;
      for (const off of unlistens) off();
      unlistens.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Фокус на консоль при включении режима, чтобы клавиши шли в PTY
  useEffect(() => {
    if (mode === "console") consoleRef.current?.focus();
  }, [mode]);

  // Закрытие панели — глушим шелл
  useEffect(() => {
    return () => {
      if (createdRef.current) void ptyKill(PTY_ID).catch(() => {});
    };
  }, []);

  /** Клавиша → байты для PTY */
  const keyToBytes = (e: React.KeyboardEvent): string | null => {
    if (e.ctrlKey || e.metaKey) {
      // Раскладконезависимо: физические клавиши C/D (на русской C даёт «с»)
      if (e.code === "KeyC") return "\x03"; // SIGINT
      if (e.code === "KeyD") return "\x04"; // EOF
      return null;
    }
    switch (e.key) {
      case "Enter": return "\r";
      case "Backspace": return "\x7f";
      case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
      case "Escape": return "\x1b";
      case "ArrowUp": return "\x1b[A";
      case "ArrowDown": return "\x1b[B";
      case "ArrowRight": return "\x1b[C";
      case "ArrowLeft": return "\x1b[D";
      case "Home": return "\x1b[H";
      case "End": return "\x1b[F";
      case "Delete": return "\x1b[3~";
      case "PageUp": return "\x1b[5~";
      case "PageDown": return "\x1b[6~";
      default: break;
    }
    if (e.key.length === 1) return e.key;
    return null;
  };

  const handleConsoleKey = (e: React.KeyboardEvent) => {
    // Перезапуск шелла после выхода — Enter
    if (exitedRef.current) {
      if (e.key === "Enter") {
        e.preventDefault();
        exitedRef.current = false;
        vtRef.current = new Vt(PTY_COLS, PTY_ROWS);
        setConsoleRows(vtRef.current.render());
        createdRef.current = false;
        // Сначала дожидаемся kill, только потом создаём: иначе create
        // может сработать до завершения kill и потерять шелл
        void ptyKill(PTY_ID)
          .catch(() => {})
          .then(() =>
            ptyCreate(
              PTY_ID,
              projectRoot,
              PTY_COLS,
              PTY_ROWS,
              termShell === "auto" ? undefined : termShell,
            ),
          )
          .then(() => {
            createdRef.current = true;
          })
          .catch(() => {});
      }
      return;
    }
    const bytes = keyToBytes(e);
    if (bytes !== null) {
      e.preventDefault();
      void ptyWrite(PTY_ID, bytes);
    }
  };

  const handleConsolePaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (text && !exitedRef.current) {
      e.preventDefault();
      void ptyWrite(PTY_ID, text.replace(/\r?\n/g, "\r"));
    }
  };

  // Автоскролл: только когда пользователь у нижнего края (режим «Агент»)
  useEffect(() => {
    if (mode !== "agent") return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines, mode]);

  // В консоли всегда держимся у нижнего края (экран терминала)
  useEffect(() => {
    if (mode !== "console") return;
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleRows, mode]);

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-halo-line bg-halo-deep"
      style={{ height: `${heightPct}%` }}
    >
      {/* Drag за верхнюю границу — меняем высоту панели */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          onResizeStart();
        }}
        title={t("terminal.resizeHint")}
        className="absolute left-0 right-0 top-0 z-30 h-1.5 cursor-row-resize transition-colors hover:bg-halo-accent/40"
      />
      {/* Переключатель режимов */}
      <div className="flex shrink-0 items-center gap-1 border-b border-halo-line/60 px-3 py-1">
        <ModeTab
          active={mode === "agent"}
          onClick={() => setMode("agent")}
          label={t("terminal.modeAgent")}
        >
          <span className="text-halo-accent">●</span>
        </ModeTab>
        <ModeTab
          active={mode === "console"}
          onClick={() => setMode("console")}
          label={t("terminal.modeConsole")}
        >
          <span>❯</span>
        </ModeTab>
      </div>
      <button
        onClick={onClose}
        title={t("terminal.close")}
        className="absolute right-2 top-1.5 z-10 flex size-5 items-center justify-center rounded-full border border-halo-line bg-halo-surface text-halo-muted shadow-sm transition-colors hover:text-halo-text"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Режим «Агент»: проекция сессии */}
      <div
        ref={scrollRef}
        style={{ fontSize: "var(--halo-term-font, 11.5px)" }}
        className={`scroll-slim min-h-0 flex-1 select-text overflow-y-auto px-4 py-2 font-mono leading-[1.5] text-halo-text ${
          mode === "agent" ? "" : "hidden"
        }`}
      >
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">
            {line.length === 0
              ? "\u00A0"
              : line.map((sp, j) => (
                  <span key={j} style={spanStyle(sp)}>
                    {sp.text}
                  </span>
                ))}
            {awaiting && i === lines.length - 1 && (
              <span className="animate-pulse text-halo-accent">▊</span>
            )}
          </div>
        ))}
      </div>

      {/* Режим «Консоль»: живой PTY-экран */}
      <div
        ref={consoleRef}
        tabIndex={0}
        onKeyDown={handleConsoleKey}
        onPaste={handleConsolePaste}
        style={{ fontSize: "var(--halo-term-font, 11.5px)" }}
        className={`scroll-slim min-h-0 flex-1 select-text overflow-y-auto px-4 py-2 font-mono leading-[1.5] text-halo-text outline-none ${
          mode === "console" ? "" : "hidden"
        }`}
      >
        {consoleRows.map((r, i) => (
          <div key={i} className="whitespace-pre">
            {renderConsoleRow(r.spans, r.cursor)}
            {r.spans.length === 0 && r.cursor < 0 ? "\u00A0" : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Строка экрана консоли: спаны + курсор-блок в нужной колонке */
function renderConsoleRow(spans: VtSpan[], cursor: number): ReactNode[] {
  const els: ReactNode[] = [];
  let pos = 0;
  let cursorDone = cursor < 0;
  const pushCursor = () => {
    els.push(
      <span
        key="cursor"
        className="animate-pulse bg-halo-accent/80 text-halo-deep"
      >
        {"\u00A0"}
      </span>,
    );
    cursorDone = true;
  };
  spans.forEach((sp, j) => {
    if (!cursorDone && cursor >= pos && cursor < pos + sp.text.length) {
      const at = cursor - pos;
      if (at > 0) els.push(<span key={`${j}a`} style={spanStyle(sp)}>{sp.text.slice(0, at)}</span>);
      pushCursor();
      els.push(<span key={`${j}b`} style={spanStyle(sp)}>{sp.text.slice(at)}</span>);
    } else {
      els.push(<span key={j} style={spanStyle(sp)}>{sp.text}</span>);
    }
    pos += sp.text.length;
  });
  if (!cursorDone && pos === cursor) pushCursor();
  if (els.length === 0) els.push(<span key="empty">{"\u00A0"}</span>);
  return els;
}

function ModeTab({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
        active
          ? "bg-halo-accent/15 text-halo-accent"
          : "text-halo-muted hover:bg-halo-hover hover:text-halo-text"
      }`}
    >
      {children}
      {label}
    </button>
  );
}
