import { summarizeArguments } from "../../diff";
import { thinkingPhases, useLang } from "../../locales";
import { type Message } from "../../types";
import { shortModelName } from "../ProviderIcon";
import { CollapseButton } from "./CollapseButton";
import { ErrorNote } from "./ErrorNote";
import { ToolStepCard } from "./ToolStepCard";
import { ChevronDownIcon, PlusIcon, SubagentIcon, ToolIcon } from "./icons";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { pickSaveFile, runTool } from "../../api";
import ProviderIcon from "../ProviderIcon";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

// Плагины markdown — константы уровня модуля: новые массивы на каждый
// рендер ломали внутренние сравнения ReactMarkdown
const MD_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function MarkdownLink({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  // Ссылки из ответа модели — во внешнем окно: обычный <a> уводил
  // вебвью приложения на произвольный URL (фишинг в доверенном окне)
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

/** Блок кода из ответа модели: hover-кнопки «копировать» и «сохранить
    как файл» (fs_write в выбранный пользователем путь — ручное действие
    и есть согласие; пермишены агента здесь не участвуют) */
function CodeBlock({
  node: _node,
  children,
}: {
  node?: unknown;
  children?: ReactNode;
}) {
  const { t } = useLang();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const text = () => preRef.current?.textContent ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // буфер недоступен (редкий кейс WebView) — молча
    }
  };

  const apply = async () => {
    try {
      const path = await pickSaveFile("snippet.txt");
      if (!path) return;
      await runTool("fs_write", JSON.stringify({ path, content: text() }));
      setApplied(true);
      window.setTimeout(() => setApplied(false), 1500);
    } catch (e) {
      window.alert(String(e));
    }
  };

  return (
    <div className="group/code relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover/code:opacity-100">
        <button
          onClick={copy}
          title={t("cp.copy")}
          className="rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
        >
          {copied ? "✓" : "📋"}
        </button>
        <button
          onClick={apply}
          title={t("cp.apply")}
          className="rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[10px] text-halo-muted transition-colors hover:text-halo-text"
        >
          {applied ? "✓" : "💾"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
const MD_COMPONENTS = { a: MarkdownLink, pre: CodeBlock };

function AssistantCardBase({
  mid,
  message,
  model,
  results,
  hint,
  glassEffect,
  isStreaming,
  smooth,
  showReasoning,
  caret,
}: {
  mid: string;
  message: Message;
  model: string;
  /** Результаты инструментов этого шага — рендерятся внутри карточки */
  results?: { id: string; content: string }[];
  /** Живой статус стрима этого хода («Размышляет…») — внутри карточки */
  hint?: string | null;
  /** Эффект стекла на карточке (тумблер в «Темах») */
  glassEffect?: boolean;
  isStreaming: boolean;
  smooth: boolean;
  showReasoning: boolean;
  caret: boolean;
}) {
  // Плавная печать: показанный текст отстаёт от реального и догоняет
  // его rAF-циклом с ускорением (чем больше отставание, тем быстрее),
  // поэтому поток выглядит непрерывным, а не рваными пачками
  // При ремонте карточки посреди стрима не переигрываем весь текст с нуля —
  // догоняем только короткий хвост (иначе текст «исчезает и печатается заново»)
  const [shownLen, setShownLen] = useState(() =>
    isStreaming ? Math.max(0, message.content.length - 120) : message.content.length,
  );
  useEffect(() => {
    const target = message.content.length;
    if (!isStreaming || !smooth) {
      setShownLen(target);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 33) {
        // ~30 кадров в секунду достаточно для плавности
        last = now;
        setShownLen((prev) => {
          const backlog = target - prev;
          if (backlog <= 0) return prev;
          return prev + Math.max(2, Math.ceil(backlog / 6));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming, smooth, message.content.length]);

  const displayContent =
    smooth && isStreaming
      ? message.content.slice(0, shownLen)
      : message.content;
  const { lang, t } = useLang();
  const [openThought, setOpenThought] = useState(false);
  // Настройка «показывать рассуждения»: первый блок в сообщении раскрывается
  // сам; защёлка — чтобы ручное закрытие не перебивалось каждым чанком
  const reasoningLatched = useRef(false);
  useEffect(() => {
    if (showReasoning && !reasoningLatched.current && message.thought) {
      reasoningLatched.current = true;
      setOpenThought(true);
    }
  }, [showReasoning, message.thought]);
  const [collapsed, setCollapsed] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phases = thinkingPhases(lang);

  // Цикл фаз активности, пока модель стримит
  useEffect(() => {
    if (!isStreaming) return;
    const t = window.setInterval(
      () => setPhaseIdx((p) => (p + 1) % phases.length),
      2500,
    );
    return () => window.clearInterval(t);
  }, [isStreaming, phases.length]);

  const preview =
    message.content.replace(/[#*`>\n]+/g, " ").trim().slice(0, 70) ||
    (message.thought ? t("card.thinking") : t("card.answer"));

  if (collapsed) {
    return (
      <button
        data-mid={mid}
        onClick={() => setCollapsed(false)}
        title={t("card.expand")}
        className="anim-fade-up mr-auto flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-halo-line/70 bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition-all duration-150 hover:border-halo-line hover:text-halo-text"
      >
        <PlusIcon />
        <span className="truncate">{preview}</span>
      </button>
    );
  }

  return (
    <div
      data-mid={mid}
      className={`anim-fade-up group relative mr-auto w-fit max-w-[85%] rounded-xl border border-halo-line/70 px-4 py-3 shadow-sm ${
        glassEffect ? "glass-pane msg-glass bg-halo-surface/40" : "ai-card-solid"
      }`}
    >
      <CollapseButton onClick={() => setCollapsed(true)} />

      <div className="mb-1 flex items-center gap-2.5 pr-6">
        <span className="flex items-center gap-1.5">
          <ProviderIcon modelId={model} size={16} />
          <span className="max-w-44 truncate text-[11px] font-semibold text-halo-text/90">
            {shortModelName(model)}
          </span>
        </span>
        {message.workedMs != null && (
          <span className="text-[11px] text-halo-muted/70">
            {/* FIX: «Worked for» было непереведённым English, а десятичная
                запятая форсилась для всех локалей; ключ chat.worked уже
                существовал во всех четырёх словарях — используем его */}
            {t("chat.worked", {
              s: (message.workedMs / 1000)
                .toFixed(1)
                .replace(".", lang === "ru" ? "," : "."),
            })}
          </span>
        )}
        {isStreaming && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-halo-accent/90">
            <span className="typing-dot size-1 rounded-full bg-halo-accent" />
            {phases[phaseIdx]}…
          </span>
        )}
      </div>

      {/* Живой статус хода: агенты думают/исполняют инструменты — показываем внутри */}
      {hint && !isStreaming && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-halo-muted">
          <span className="typing-dot size-1 rounded-full bg-halo-accent" />
          {hint}
        </div>
      )}

      {message.thought && (
        <div className="mb-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpenThought((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-halo-muted transition-colors hover:text-halo-text"
            >
              <ChevronDownIcon
                className={openThought ? "" : "-rotate-90"}
              />
              {/* FIX: «Thought» было захардкожено для всех локалей */}
              {t("chat.thought")}
            </button>
            {isStreaming && (
              <span className="flex items-center gap-1 text-[10px] text-halo-muted/70">
                <span className="typing-dot size-1 rounded-full bg-halo-muted" />
                {phases[phaseIdx]}
              </span>
            )}
          </div>
          {openThought && (
            <div className="anim-fade-up mt-1.5 whitespace-pre-wrap rounded-lg border border-halo-line/60 bg-halo-raised/40 px-3 py-2 text-xs italic leading-relaxed text-halo-muted">
              {message.thought}
            </div>
          )}
        </div>
      )}

      {message.toolCalls?.map((tc) => (
        <div
          key={tc.id}
          className="mb-1 flex w-fit items-center gap-1.5 rounded-md border border-sky-400/25 bg-sky-400/5 px-2 py-1"
        >
          <span className="text-sky-400">
            {tc.name === "subagent_run" ? <SubagentIcon /> : <ToolIcon />}
          </span>
          <span className="font-mono text-[11px] text-halo-text">
            {tc.name}
          </span>
          <span className="max-w-64 truncate font-mono text-[10px] text-halo-muted">
            {summarizeArguments(tc.name, tc.arguments)}
          </span>
        </div>
      ))}

      {/* Результаты инструментов этого шага — внутри ответа, отдельными
          сворачиваемыми карточками (при клике по заголовку раскрываются) */}
      {results?.map((r) => (
        <ToolStepCard
          key={r.id}
          mid={r.id}
          call={message.toolCalls?.find((tc) => tc.id === r.id)}
          content={r.content}
        />
      ))}

      <div className="markdown text-sm leading-relaxed text-halo-text">
        <ReactMarkdown
          remarkPlugins={MD_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={MD_COMPONENTS}
        >
          {displayContent}
        </ReactMarkdown>
        {caret && isStreaming && (
          <span className="animate-pulse align-baseline text-halo-accent">▍</span>
        )}
      </div>

      {message.error && (
        <ErrorNote title={message.error.title} raw={message.error.raw} />
      )}

      {message.usage && (
        <div className="mt-2 flex items-center gap-3 border-t border-halo-line/50 pt-2 text-[10px] text-halo-muted/70">
          <span title={t("tokens.up")}>
            ↑ {message.usage.prompt.toLocaleString("ru-RU")}
          </span>
          <span title={t("tokens.down")}>
            ↓ {message.usage.completion.toLocaleString("ru-RU")}
          </span>
          <span title={t("tokens.total")}>
            Σ {message.usage.total.toLocaleString("ru-RU")}
          </span>
        </div>
      )}

      {/* Дисклеймер: ответ сгенерирован моделью */}
      {message.role === "assistant" && message.content.trim() !== "" && (
        <p className="mt-1.5 text-[10px] italic text-halo-muted/50">
          {t("chat.aiDisclaimer")}
        </p>
      )}
    </div>
  );
}

// Мемоизация: без неё карточка ре-рендерилась (и ре-парсила markdown всей
// истории) на каждый токен стрима, даже когда её собственный контент не менялся
export const AssistantCard = memo(AssistantCardBase);

/** Ошибка запроса: короткий человекочитаемый заголовок, сырое тело — по клику */