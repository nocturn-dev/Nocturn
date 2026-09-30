import { summarizeArguments } from "../../diff";
import { copyText } from "../../clipboard";
import { isWindows } from "../../platform";
import { useLang } from "../../locales";
import { type Message } from "../../types";
import type { StepRow } from "../../agent/steps";
import { StepAccordion } from "./StepAccordion";
import { shortModelName } from "../ProviderIcon";
import { fmtInt } from "./util";
import { CollapseButton } from "./CollapseButton";
import { ErrorNote } from "./ErrorNote";
import { MermaidBlock } from "./MermaidBlock";
import { ToolStepCard } from "./ToolStepCard";
import { ChevronDownIcon, PlusIcon, SpeakerIcon, SubagentIcon, ToolIcon } from "./icons";
import { speak, stopSpeaking } from "../../tts";
import {
  memo,
  useEffect,
  useMemo,
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
/** Вариант без highlight для стрима (тумблер «Подсветка при стриме»):
 *  стабильная пустая ссылка, чтобы react-markdown не пересоздавал пайплайн */
const REHYPE_PLUGINS_NO_HL: typeof REHYPE_PLUGINS = [];

function MarkdownLink({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  // Ссылки из ответа модели — во внешнем окно: обычный <a> уводил
  // вебвью приложения на произвольный URL (фишинг в доверенном окне)
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

/** Язык fenced-блока из hast-дерева react-markdown (className="language-x") */
function codeLanguage(node: unknown): string {
  const n = node as
    | { children?: { properties?: { className?: unknown } }[] }
    | undefined;
  const cls = n?.children?.[0]?.properties?.className;
  if (!Array.isArray(cls)) return "";
  for (const c of cls) {
    if (typeof c === "string" && c.startsWith("language-")) return c.slice(9);
  }
  return "";
}

/** Исходник fenced-блока из hast-дерева (pre → code → text): без DOM —
 *  нужен ДО рендера, чтобы отдать код в MermaidBlock */
function codeText(node: unknown): string {
  const n = node as
    | { children?: { children?: { value?: unknown }[] }[] }
    | undefined;
  const val = n?.children?.[0]?.children?.[0]?.value;
  return typeof val === "string" ? val : "";
}

/** Блок кода из ответа модели: hover-кнопки «копировать» и «сохранить
    как файл» (fs_write в выбранный пользователем путь — ручное действие
    и есть согласие; пермишены агента здесь не участвуют). Для ```html —
    кнопка «Предпросмотр»: HTML уезжает в панель Artifacts (sandbox-iframe) */
function CodeBlock({
  node: _node,
  children,
  onPreview,
}: {
  node?: unknown;
  children?: ReactNode;
  /** Приходит из ChatArea через AssistantCard; нет — кнопки не будет */
  onPreview?: (html: string) => void;
}) {
  const { t } = useLang();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const text = () => preRef.current?.textContent ?? "";
  // Артефакт = ```html-блок (язык берём из hast — доктайп-эвристика не нужна)
  const previewable = onPreview !== undefined && codeLanguage(_node) === "html";

  const copy = async () => {
    // Галочка только при реальном успехе: фолбэк внутри copyText (старый WebKitGTK)
    if (await copyText(text())) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const apply = async () => {
    try {
      const path = await pickSaveFile("snippet.txt", "txt");
      if (!path) return;
      await runTool("fs_write", JSON.stringify({ path, content: text() }));
      setApplied(true);
      window.setTimeout(() => setApplied(false), 1500);
    } catch (e) {
      window.alert(String(e));
    }
  };

  // Mermaid: диаграмма вместо исходника (внутри — переключатель на код).
  // Возврат после хуков — хуки выше зовутся безусловно
  if (codeLanguage(_node) === "mermaid") {
    return <MermaidBlock code={codeText(_node)} />;
  }

  return (
    <div className="group/code relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover/code:opacity-100">
        {previewable && (
          <button
            onClick={() => onPreview?.(text())}
            title={t("cp.preview")}
            className="rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
          >
            ▶
          </button>
        )}
        <button
          onClick={copy}
          title={t("cp.copy")}
          className="rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
        >
          {copied ? "✓" : "📋"}
        </button>
        <button
          onClick={apply}
          title={t("cp.apply")}
          className="rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[0.625rem] text-halo-muted transition-colors hover:text-halo-text"
        >
          {applied ? "✓" : "💾"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
/** Компоненты markdown собираются per-card: pre получает колбэк предпросмотра
    артефактов (стабильный из ChatArea — useMemo не пересоздаёт пайплайн лишний
    раз); без колбэка (снапшот-тесты) кнопка предпросмотра не рисуется */

function AssistantCardBase({
  mid,
  message,
  model,
  results,
  steps,
  hint,
  glassEffect,
  showMsgTime,
  isStreaming,
  smooth,
  printSpeed,
  highlightLive,
  showReasoning,
  caret,
  onPreviewArtifact,
}: {
  mid: string;
  message: Message;
  model: string;
  /** Результаты инструментов этого шага — рендерятся внутри карточки */
  results?: { id: string; content: string }[];
  /** Шаги хода для аккордеона (merged-режим): вместо чипов + ToolStepCard */
  steps?: StepRow[];
  /** Живой статус стрима этого хода («Размышляет…») — внутри карточки */
  hint?: string | null;
  /** Эффект стекла на карточке (тумблер в «Темах») */
  glassEffect?: boolean;
  /** Время в шапке (кастомизация); показывается только когда известно (message.ts) */
  showMsgTime?: boolean;
  isStreaming: boolean;
  smooth: boolean;
  /** Множитель скорости печати (0.5 медленно / 1 обычно / 2 быстро) */
  printSpeed: number;
  /** Подсветка кода во время стрима: выкл — hljs только после завершения
   *  (тик плавной печати без highlight в разы дешевле на длинных ответах) */
  highlightLive: boolean;
  showReasoning: boolean;
  caret: boolean;
  /** Открывает панель Artifacts с ```html-блоком (стабилен от ChatArea) */
  onPreviewArtifact?: (html: string) => void;
}) {
  // Плавная печать: показанный текст отстаёт от реального и догоняет
  // его rAF-циклом с ускорением (чем больше отставание, тем быстрее),
  // поэтому поток выглядит непрерывным, а не рваными пачками
  // При ремонте карточки посреди стрима не переигрываем весь текст с нуля —
  // догоняем только короткий хвост (иначе текст «исчезает и печатается заново»)
  const [shownLen, setShownLen] = useState(() =>
    isStreaming ? Math.max(0, message.content.length - 120) : message.content.length,
  );
  // Зеркало shownLen между перезапусками эффекта (каждый новый контент его
  // перезапускает): без него локальный счётчик сбрасывался на 120 символов назад
  const shownMirror = useRef<number | null>(null);
  useEffect(() => {
    const target = message.content.length;
    if (!isStreaming || !smooth) {
      shownMirror.current = target;
      setShownLen(target);
      return;
    }
    let raf = 0;
    let last = 0;
    let shown = shownMirror.current ?? Math.max(0, target - 120);
    const tick = (now: number) => {
      // 50 мс: тик ре-парсит показанный markdown (react-markdown + hljs) —
      // 100 мс давали рваную печать по 10 кадров; 50 — плавно и без O(n²)
      // на разумных длинах (бюджет D6 поднят: у машин пользователя запас есть)
      if (now - last >= 50) {
        last = now;
        const backlog = target - shown;
        if (backlog <= 0) {
          // Догнали текст — гасим rAF-цикл: пока модель думает/идёт tool-шаг,
          // он раньше молотил вхолостую 60 раз/сек. Новый контент перезапустит
          // эффект (deps по длине контента)
          return;
        }
        // Множитель скорости: чем больше backlog, тем быстрее догоняем;
        // printSpeed двигает темп (0.5 лениво / 2 почти вровень с потоком)
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
  }, [isStreaming, smooth, printSpeed, message.content.length]);

  const displayContent =
    smooth && isStreaming
      ? message.content.slice(0, shownLen)
      : message.content;
  const { lang, t } = useLang();
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
  const [openThought, setOpenThought] = useState(false);
  // Озвучка этого ответа: индикатор на кнопке динамика (гаснет сам по
  // завершении речи — tts_speak разрешается в конце)
  const [speaking, setSpeaking] = useState(false);
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

  const preview =
    message.content.replace(/[#*`>\n]+/g, " ").trim().slice(0, 70) ||
    (message.thought ? t("card.thinking") : t("card.answer"));

  if (collapsed) {
    return (
      <button
        data-mid={mid}
        onClick={() => setCollapsed(false)}
        title={t("card.expand")}
        className="anim-fade-up mr-auto flex w-fit max-w-[85%] items-center gap-2 rounded-lg border border-halo-line/70 bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition duration-150 hover:border-halo-line hover:text-halo-text"
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
          <span className="max-w-44 truncate text-[0.6875rem] font-semibold text-halo-text/90">
            {shortModelName(model)}
          </span>
        </span>
        {/* Прогон ушёл на fallback-модель (429/5xx после ретраев) */}
        {message.switchedTo && (
          <span
            title={t("card.switchedTo", { model: message.switchedTo })}
            className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-400"
          >
            ⇄ {shortModelName(message.switchedTo)}
          </span>
        )}
        {showMsgTime && message.ts != null && (
          <span className="text-[0.6875rem] tabular-nums text-halo-muted/70">
            {new Date(message.ts).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
        {message.workedMs != null && (
          <span className="text-[0.6875rem] text-halo-muted/70">
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
          <span className="ml-auto flex items-center gap-1.5 text-[0.625rem] text-halo-accent/90">
            <span className="typing-dot size-1 rounded-full bg-halo-accent" />
            {/* Фейковые фазы («Планирование/Генерация кода») удалены:
                живой статус хода приходит через hint из движка */}
          </span>
        )}
        {/* TTS — SAPI, только Windows: на macOS/Linux бекенд вернёт Err,
            а «живая» кнопка с молча гаснущим индикатором обманывала бы.
            Прецедент честного скрытия фичи — keep-awake в AutomationsModal */}
        {!isStreaming && isWindows() && message.content.trim() !== "" && (
          <button
            onClick={() =>
              speaking ? stopSpeaking() : speak(message.content, setSpeaking)
            }
            title={speaking ? t("tts.stop") : t("tts.listen")}
            className={`ml-auto flex shrink-0 items-center rounded-md p-1 transition-colors ${
              speaking
                ? "bg-halo-accent/15 text-halo-accent"
                : "text-halo-muted/70 hover:bg-halo-hover hover:text-halo-text"
            }`}
          >
            <span className={speaking ? "animate-pulse" : ""}>
              <SpeakerIcon />
            </span>
          </button>
        )}
      </div>

      {/* Живой статус хода: агенты думают/исполняют инструменты — показываем внутри */}
      {hint && !isStreaming && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[0.6875rem] text-halo-muted">
          <span className="typing-dot size-1 rounded-full bg-halo-accent" />
          {hint}
        </div>
      )}

      {message.thought && (
        <div className="mb-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOpenThought((v) => !v)}
              className="flex items-center gap-1 text-[0.6875rem] font-medium text-halo-muted transition-colors hover:text-halo-text"
            >
              <ChevronDownIcon
                className={openThought ? "" : "-rotate-90"}
              />
              {/* FIX: «Thought» было захардкожено для всех локалей */}
              {t("chat.thought")}
            </button>
            {isStreaming && (
              <span className="flex items-center gap-1 text-[0.625rem] text-halo-muted/70">
                <span className="typing-dot size-1 rounded-full bg-halo-muted" />
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

      {/* Шаги хода: аккордеон Edit/Terminal/Explore/Asked с живыми деталями
          (merged-режим); в раздельном режиме шаги остаются карточками ниже */}
      {steps && steps.length > 0 ? (
        <StepAccordion steps={steps} />
      ) : (
        <>
          {message.toolCalls?.map((tc) => (
            <div
              key={tc.id}
              className="mb-1 flex w-fit items-center gap-1.5 rounded-md border border-sky-400/25 bg-sky-400/5 px-2 py-1"
            >
              <span className="text-sky-400">
                {tc.name === "subagent_run" ? <SubagentIcon /> : <ToolIcon />}
              </span>
              <span className="font-mono text-[0.6875rem] text-halo-text">
                {tc.name}
              </span>
              <span className="max-w-64 truncate font-mono text-[0.625rem] text-halo-muted">
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
        </>
      )}

      <div className="markdown text-sm leading-relaxed text-halo-text">
        <ReactMarkdown
          remarkPlugins={MD_PLUGINS}
          rehypePlugins={highlightLive || !isStreaming ? REHYPE_PLUGINS : REHYPE_PLUGINS_NO_HL}
          components={mdComponents}
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
        <div className="mt-2 flex items-center gap-3 border-t border-halo-line/50 pt-2 text-[0.625rem] text-halo-muted/70">
          <span title={t("tokens.up")}>
            ↑ {fmtInt(message.usage.prompt, lang)}
          </span>
          <span title={t("tokens.down")}>
            ↓ {fmtInt(message.usage.completion, lang)}
          </span>
          <span title={t("tokens.total")}>
            Σ {fmtInt(message.usage.total, lang)}
          </span>
        </div>
      )}

      {/* Дисклеймер: ответ сгенерирован моделью */}
      {message.role === "assistant" && message.content.trim() !== "" && (
        <p className="mt-1.5 text-[0.625rem] italic text-halo-muted/50">
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