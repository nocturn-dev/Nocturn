import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { type Message, type ToolCallInfo } from "../../types";
import type { StepRow } from "../../agent/steps";
import { useLang } from "../../locales";
import { StepAccordion } from "./StepAccordion";
import { MarkdownLink } from "./MarkdownLink";
import { SubagentCard } from "./SubagentCard";
import { ErrorNote } from "./ErrorNote";
import { CodeBlock } from "./AssistantCard";
import { shortModelName } from "../ProviderIcon";
import ProviderIcon from "../ProviderIcon";
import { fmtInt } from "./util";
import { ChevronDownIcon } from "./icons";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// Плагины markdown — константы уровня модуля (см. AssistantCard)
const MD_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const REHYPE_PLUGINS_NO_HL: typeof REHYPE_PLUGINS = [];

/**
 * Лента хода в стиле ZCode (фидбек 30.09): ВЕСЬ ход — один плоский фид
 * без карточек-дублей. Шапка «Работает/Работал N мин N с» (живой таймер),
 * внутри хронологически по раундам: строка «Размышления · N с» (свёрнута,
 * клик раскрывает текст) → текст раунда → плоские ряды шагов
 * (StepAccordion в flat-режиме) → живые субагенты → ошибка.
 * Usage и дисклеймер — один раз в конце, суммы по всем раундам.
 * Раздельный режим (groupTurns=false) продолжает использовать AssistantCard.
 */

/** Длительность по-ZCode: «6 мин 23 с» / «6m 23s», до минуты — только секунды */
function fmtDur(ms: number, lang: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (lang === "ru") return m > 0 ? `${m} мин ${s} с` : `${s} с`;
  if (lang === "zh") return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  if (lang === "ja") return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Плавная печать текста стримящегося раунда — логика AssistantCard:
 *  показанный текст отстаёт от реального и догоняет rAF-циклом с ускорением */
function useSmoothText(
  content: string,
  active: boolean,
  smooth: boolean,
  printSpeed: number,
): string {
  const [shownLen, setShownLen] = useState(() =>
    active ? Math.max(0, content.length - 120) : content.length,
  );
  const shownMirror = useRef<number | null>(null);
  useEffect(() => {
    const target = content.length;
    if (!active || !smooth) {
      shownMirror.current = target;
      setShownLen(target);
      return;
    }
    let raf = 0;
    let last = 0;
    let shown = shownMirror.current ?? Math.max(0, target - 120);
    const tick = (now: number) => {
      if (now - last >= 50) {
        last = now;
        const backlog = target - shown;
        if (backlog <= 0) return;
        shown = Math.min(
          target,
          shown + Math.max(4, Math.ceil((backlog / 4) * printSpeed)),
        );
        shownMirror.current = shown;
        setShownLen(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, smooth, printSpeed, content.length]);
  return smooth && active ? content.slice(0, shownLen) : content;
}

/** Иконка мысли: искра-мозг (как ряд Thought в ZCode) */
function ThoughtIcon() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M12 3a5 5 0 0 1 5 5c0 1.7-.9 3.2-2.2 4.1-.5.4-.8.9-.8 1.5V15h-4v-1.4c0-.6-.3-1.1-.8-1.5A5 5 0 0 1 12 3Z" />
      <path d="M10 18h4M10.5 21h3" />
    </svg>
  );
}

/** Один раунд хода: строка мысли + текст + шаги. Отдельный компонент —
 *  useSmoothText обязан зваться безусловно на верхнем уровне */
function RunRound({
  round,
  steps,
  toolMsgs,
  callOf,
  subRuns,
  isStreamingRound,
  smooth,
  printSpeed,
  highlightLive,
  caret,
  open,
  onToggleThought,
  mdComponents,
}: {
  round: Message;
  steps: StepRow[];
  toolMsgs: Message[];
  callOf: Map<string, ToolCallInfo | undefined>;
  subRuns?: Record<string, import("../../subagents").SubRunState>;
  isStreamingRound: boolean;
  smooth: boolean;
  printSpeed: number;
  highlightLive: boolean;
  caret: boolean;
  open: boolean;
  onToggleThought: () => void;
  mdComponents: {
    a: (p: ComponentPropsWithoutRef<"a">) => ReactNode;
    pre: (p: { node?: unknown; children?: ReactNode }) => ReactNode;
  };
}) {
  const { lang, t } = useLang();
  const text = useSmoothText(round.content, isStreamingRound, smooth, printSpeed);

  return (
    <Fragment>
      {round.thought && (
        <div className="mt-2">
          <button
            onClick={onToggleThought}
            className="flex items-center gap-1.5 text-[0.6875rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            <ThoughtIcon />
            <span className="font-medium">{t("chat.thought")}</span>
            {round.workedMs != null && round.workedMs > 0 && (
              <span className="tabular-nums text-halo-muted/60">
                · {(round.workedMs / 1000).toFixed(1).replace(".", lang === "ru" ? "," : ".")}
                s
              </span>
            )}
            <ChevronDownIcon
              className={`size-2.5 transition-transform ${open ? "" : "-rotate-90"}`}
            />
          </button>
          {open && (
            <div className="anim-fade-up mt-1 whitespace-pre-wrap pl-5 text-xs italic leading-relaxed text-halo-muted">
              {round.thought}
            </div>
          )}
        </div>
      )}

      {round.content && (
        /* Мягкая подложка под текстом раунда: на «голом» фоне ленты текст
           сливался с ambient/шагами (фидбек владельца) */
        <div className="markdown mt-2 rounded-lg border border-halo-line/40 bg-halo-surface/40 px-3.5 py-2.5 text-sm leading-relaxed text-halo-text">
          <ReactMarkdown
            remarkPlugins={MD_PLUGINS}
            rehypePlugins={
              highlightLive || !isStreamingRound ? REHYPE_PLUGINS : REHYPE_PLUGINS_NO_HL
            }
            components={mdComponents}
          >
            {text}
          </ReactMarkdown>
          {caret && isStreamingRound && (
            <span className="animate-pulse align-baseline text-halo-accent">▍</span>
          )}
        </div>
      )}

      {steps.length > 0 && (
        <div className="mt-1.5">
          <StepAccordion steps={steps} flat />
        </div>
      )}

      {toolMsgs
        .filter((m) => m.toolName === "subagent_run")
        .map((m) => (
          <div key={m.id} className="mt-1.5">
            <SubagentCard
              mid={m.id}
              call={m.toolCallId ? callOf.get(m.toolCallId) : undefined}
              content={m.content}
              run={subRuns?.[m.toolCallId ?? ""]}
            />
          </div>
        ))}

      {round.error && <ErrorNote title={round.error.title} raw={round.error.raw} />}
    </Fragment>
  );
}

function RunCardBase({
  runKey,
  rounds,
  stepsOf,
  toolMsgsOf,
  callOf,
  subRuns,
  model,
  hint,
  isStreaming,
  streamingMsgId,
  showMsgTime,
  smooth,
  printSpeed,
  highlightLive,
  showReasoning,
  caret,
  onPreviewArtifact,
}: {
  runKey: string;
  /** Раунды хода (assistant-сообщения, отфильтрованные от пустых) */
  rounds: Message[];
  /** Шаги каждого раунда (Edit/Terminal/Explore/Asked) — из derived-кэша */
  stepsOf: Map<string, StepRow[]>;
  /** tool-сообщения по раундам — из них живут субагентные карточки */
  toolMsgsOf: Map<string, Message[]>;
  /** Вызовы по id tool-сообщения — из derived-кэша (стабильные ссылки) */
  callOf: Map<string, ToolCallInfo | undefined>;
  subRuns?: Record<string, import("../../subagents").SubRunState>;
  model: string;
  /** Живой статус хода («Размышляет…») — справа в шапке */
  hint?: string | null;
  isStreaming: boolean;
  streamingMsgId: string | null;
  showMsgTime?: boolean;
  smooth: boolean;
  printSpeed: number;
  highlightLive: boolean;
  showReasoning: boolean;
  caret: boolean;
  onPreviewArtifact?: (html: string) => void;
}) {
  const { lang, t } = useLang();

  // Живой таймер шапки: «сейчас» живёт в состоянии (не в рендере — purity),
  // тик раз в секунду, только пока ход идёт
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [isStreaming]);

  // Границы хода: старт — первый раунд; конец — максимум (ts + workedMs)
  // по раундам и ts tool-сообщений (инструменты исполняются между раундами)
  const startMs = rounds[0]?.ts ?? 0;
  const endMs = useMemo(() => {
    let end = 0;
    for (const a of rounds) {
      end = Math.max(end, (a.ts ?? 0) + (a.workedMs ?? 0));
    }
    for (const list of toolMsgsOf.values()) {
      for (const m of list) end = Math.max(end, m.ts ?? 0);
    }
    return end || startMs;
  }, [rounds, toolMsgsOf, startMs]);
  const durationMs = isStreaming
    ? Math.max(0, now - startMs)
    : Math.max(0, endMs - startMs);

  // Раскрытые «Размышления»: авто-раскрытие первого блока и стримящегося
  // (настройка «показывать рассуждения»); защёлка по id — чтобы ручное
  // закрытие не перебивалось каждым чанком
  const [openThoughts, setOpenThoughts] = useState<Set<string>>(new Set());
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!showReasoning) return;
    const streamingRound = rounds.find((a) => a.id === streamingMsgId);
    const target = streamingRound?.thought
      ? streamingRound
      : rounds.find((a) => a.thought && !autoOpened.current.has(a.id));
    if (target && !autoOpened.current.has(target.id)) {
      autoOpened.current.add(target.id);
      setOpenThoughts((s) => new Set(s).add(target.id));
    }
  }, [showReasoning, rounds, streamingMsgId]);
  const toggleThought = (id: string) =>
    setOpenThoughts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Компоненты markdown: pre получает колбэк предпросмотра артефактов
  const mdComponents = useMemo(
    () => ({
      a: MarkdownLink,
      pre: (p: { node?: unknown; children?: ReactNode }) => (
        <CodeBlock {...p} onPreview={onPreviewArtifact} />
      ),
    }),
    [onPreviewArtifact],
  );

  // Сумма usage по всем раундам — один футер на ход
  const usage = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let any = false;
    for (const a of rounds) {
      if (!a.usage) continue;
      any = true;
      prompt += a.usage.prompt;
      completion += a.usage.completion;
      total += a.usage.total;
    }
    return any ? { prompt, completion, total } : null;
  }, [rounds]);
  const hasContent = rounds.some((a) => a.content.trim() !== "");
  const switched = rounds.find((a) => a.switchedTo)?.switchedTo;
  const firstTs = rounds[0]?.ts;

  return (
    <div data-mid={runKey} className="anim-fade-up mr-auto w-full max-w-[85%]">
      {/* Шапка хода: модель + живой таймер, hairline снизу — как в ZCode */}
      <div className="flex items-center gap-2.5 border-b border-halo-line/40 pb-1.5">
        <span className="flex shrink-0 items-center gap-1.5">
          <ProviderIcon modelId={model} size={14} />
          <span className="max-w-44 truncate text-[0.6875rem] font-semibold text-halo-text/90">
            {shortModelName(model)}
          </span>
        </span>
        {switched && (
          <span
            title={t("card.switchedTo", { model: switched })}
            className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-400"
          >
            ⇄ {shortModelName(switched)}
          </span>
        )}
        <span className="text-[0.6875rem] tabular-nums text-halo-muted/70">
          {t(isStreaming ? "chat.runWorking" : "chat.runWorked", {
            d: fmtDur(durationMs, lang),
          })}
        </span>
        {showMsgTime && firstTs != null && (
          <span className="text-[0.6875rem] tabular-nums text-halo-muted/70">
            {new Date(firstTs).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        {isStreaming && hint && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[0.625rem] text-halo-muted">
            <span className="typing-dot size-1 shrink-0 rounded-full bg-halo-accent" />
            <span className="truncate">{hint}</span>
          </span>
        )}
      </div>

      {/* Плоская лента: по раундам — мысль → текст → шаги → субагенты → ошибка */}
      {rounds.map((a) => (
        <RunRound
          key={a.id}
          round={a}
          steps={stepsOf.get(a.id) ?? []}
          toolMsgs={toolMsgsOf.get(a.id) ?? []}
          callOf={callOf}
          subRuns={subRuns}
          isStreamingRound={a.id === streamingMsgId}
          smooth={smooth}
          printSpeed={printSpeed}
          highlightLive={highlightLive}
          caret={caret}
          open={openThoughts.has(a.id)}
          onToggleThought={() => toggleThought(a.id)}
          mdComponents={mdComponents}
        />
      ))}

      {/* Один футер на ход: сумма токенов + дисклеймер */}
      {(usage || hasContent) && (
        <div className="mt-2.5 border-t border-halo-line/40 pt-1.5">
          {usage && (
            <div className="flex items-center gap-3 text-[0.625rem] text-halo-muted/70">
              <span title={t("tokens.up")}>↑ {fmtInt(usage.prompt, lang)}</span>
              <span title={t("tokens.down")}>↓ {fmtInt(usage.completion, lang)}</span>
              <span title={t("tokens.total")}>Σ {fmtInt(usage.total, lang)}</span>
            </div>
          )}
          {hasContent && (
            <p className="mt-1 text-[0.625rem] italic text-halo-muted/50">
              {t("chat.aiDisclaimer")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Мемоизация: исторические ходы не перерисовываются на каждый тик стрима
export const RunCard = memo(RunCardBase);
