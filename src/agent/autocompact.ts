import type { ChatMsgParam } from "../api";
import { COMPACT_TAIL_MESSAGES, historyWithSummary } from "./history";

/**
 * Autocompact — персистентный слой контекст-менеджмента поверх microcompact:
 * голова истории (всё, кроме защищённого хвоста) суммаризируется одним
 * безголовым вызовом модели, summary вшивается в system-сообщение и
 * переживает границы окна, шаги цикла и рестарт приложения (Session.compact,
 * перегенерация в buildHistory). Чистится, как и в microcompact, только
 * история ЗАПРОСА — карточки чата не меняются.
 *
 * Компакция — оптимизация, а не граница безопасности: отказ суммаризатора
 * никогда не роняет прогон (compactHistory возвращает null).
 *
 * Все вызовы модели идут через thunk, передаваемый вызывающим (useAgentRun
 * подставляет headless chatWithRetry под requestId прогона) — модуль остаётся
 * чистым и тестируемым с fake-call.
 */

/** Порог промпт-токенов последнего раунда (usageAcc.lastPrompt): буфер ~13k
    учтён для 128k-моделей; малые окна ловит reactive-ветка по 400/413 */
export const COMPACT_TRIGGER_TOKENS = 96_000;

/** Анти-спираль: не больше двух компакций за прогон */
export const COMPACT_MAX_PER_RUN = 2;

/** Кап одного сообщения в сериализации головы (суммаризатору не нужны
    мегабайты — сам запрос должен влезть в контекст) */
const HEAD_MSG_CAP = 2_000;

/** Кап всей сериализации головы */
const HEAD_TOTAL_CAP = 80_000;

/** Кап текста суммаризации на входе в историю */
const SUMMARY_CAP_CHARS = 8_000;

/** Реестр маркеров переполнения контекста (текстовые; HTTP 413 добавляет
    вызывающий через parseHttpCode). Ошибка удерживается от показа —
    reactive-ветка делает компакцию и один повтор */
export function isContextLengthError(msg: string): boolean {
  const m = msg.toLowerCase();
  return [
    "context_length_exceeded", // OpenAI-совместимые (code)
    "context length", // "maximum context length …" (OpenAI)
    "prompt is too long", // Anthropic Messages API
    "input token count", // Gemini
    "maximum number of tokens", // прочие
  ].some((needle) => m.includes(needle));
}

/** Сериализация головы для суммаризатора: system не отдаём (он и так в
    запросе), каждый ответ капится, вся сериализация — тоже. При переполнении
    сохраняются начало (цель задачи) и конец (свежее состояние) головы */
export function serializeHead(msgs: ChatMsgParam[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "system") continue;
    const label =
      m.role === "tool"
        ? `[tool result${m.tool_call_id ? ` for ${m.tool_call_id}` : ""}]`
        : `[${m.role}]`;
    let text =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (text == null) continue;
    if (text.length > HEAD_MSG_CAP) {
      text = `${text.slice(0, HEAD_MSG_CAP)}…[truncated]`;
    }
    lines.push(`${label} ${text}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= HEAD_TOTAL_CAP) return joined;
  const headKeep = 20_000;
  const tailKeep = HEAD_TOTAL_CAP - headKeep;
  return `${joined.slice(0, headKeep)}\n[…older messages omitted…]\n${joined.slice(
    joined.length - tailKeep,
  )}`;
}

/** Промпт суммаризации: 6 секций своими словами; секция 6 замещает
    реинжект плана/файлов — «текущее состояние и следующий шаг» */
export function buildSummaryPrompt(head: ChatMsgParam[]): string {
  return [
    "You are summarizing an ongoing agent task so it can continue with a fresh context.",
    "Summarize the conversation below for a model that will CONTINUE the task. Be specific and factual.",
    "Use exactly these sections:",
    "1) Task goal — the user's original request, as close to verbatim as possible",
    "2) Key decisions and constraints made along the way",
    "3) Files and artifacts touched — exact paths and what changed",
    "4) Errors encountered and how they were resolved",
    "5) All user messages and corrections, brief but complete, in order",
    "6) Current state and the immediate next step",
    "Under 600 words total. Conversation:",
    "",
    serializeHead(head),
  ].join("\n");
}

/** Сборка сжатой истории: summary (с капом) вшивается в system, хвост
    COMPACT_TAIL_MESSAGES сообщений переживает дословно (пары чинит
    trimContextWindow внутри historyWithSummary) */
export function applyCompact(
  msgs: ChatMsgParam[],
  summary: string,
): ChatMsgParam[] {
  const capped =
    summary.length > SUMMARY_CAP_CHARS
      ? `${summary.slice(0, SUMMARY_CAP_CHARS)}…[truncated]`
      : summary;
  return historyWithSummary(capped, msgs, COMPACT_TAIL_MESSAGES);
}

/** Результат компакции: пересобранная история + текст summary отдельно —
    он уходит в Session.compact (персистентность переживает рестарт) */
export interface CompactResult {
  msgs: ChatMsgParam[];
  summary: string;
}

/** Оркестратор: суммаризация головы + пересборка. Отказ call (сеть, Stop,
    пустой ответ) → null — вызывающий продолжает прежней историей */
export async function compactHistory(
  msgs: ChatMsgParam[],
  call: (prompt: string) => Promise<string>,
): Promise<CompactResult | null> {
  try {
    const summary = (await call(buildSummaryPrompt(msgs))).trim();
    if (!summary) return null;
    return { msgs: applyCompact(msgs, summary), summary };
  } catch {
    return null;
  }
}
