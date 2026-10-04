/**
 * Ретрай + fallback-модель для стрима провайдера (PLAN §24 шаг 4г) —
 * вынесено из useAgentRun без изменения поведения. Зависимости
 * инъектятся: isAborted (барьеры Stop/Hard Limit), onRetryNote/
 * onFallbackNote (активность в UI), sleep (в тестах — мгновенный).
 */

import type { ChatUsage } from "../api";
import type { ToolCallInfo } from "../types";
import { parseHttpCode } from "./toolArgs";

/** Ошибки провайдера, которые имеет смысл ретраить: перегрузка/лимиты/сеть */
export const RETRYABLE_RE =
  /\bHTTP (?:429|500|502|503|504|52\d)\b|failed to fetch|connection|timed?.?out/i;

/** Опции стрима провайдера + фолбэк-модель (сам вызов — в api.chatStream) */
export type RetryStreamOpts = Parameters<
  typeof import("../api").chatStream
>[0] & {
  /** Fallback-модель: только на 429/5xx, до первого токена */
  fallbackModel?: string;
  onFallback?: (model: string) => void;
};

export interface RetryDeps {
  stream: (opts: RetryStreamOpts) => Promise<void>;
  /** Барьеры Stop/Hard Limit: requestId внутри opts */
  isAborted: () => boolean;
  /** Ретрай начат (attempt с 1) — активность в UI */
  onRetryNote?: (attempt: number) => void;
  /** Ретраи не помогли — переключение на фолбэк-модель */
  onFallbackNote?: (model: string) => void;
  /** Пауза между ретраями (в тестах — мгновенная); 1500мс × attempt */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Стрим с ретраями: до 2 повторов ретрайабельных ошибок ДО первого токена
 * (usage/tool_calls — часть частично-оплаченного ответа, после них не
 * ретраим), затем фолбэк-модель на 429/5xx (сетевые сбои моделью не
 * лечатся). Stop/Hard Limit гасят всё молча — обрыв при отмене не ошибка.
 * Бросает исходную ошибку, если ничего не помогло.
 */
export async function chatWithRetry(
  deps: RetryDeps,
  opts: RetryStreamOpts,
): Promise<void> {
  const { stream, isAborted, onRetryNote, onFallbackNote } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  let received = false;
  const wrapped = {
    ...opts,
    onDelta: (d: string, seq?: number) => {
      received = true;
      opts.onDelta(d, seq);
    },
    onThought: (th: string, seq?: number) => {
      received = true;
      opts.onThought(th, seq);
    },
    // FIX: usage означает «провайдер уже насчитал токены за попытку» —
    // ретрай после него двойно считал токены в Hard-Limit и журнале
    onUsage: (u: ChatUsage, barrier?: boolean, seq?: number) => {
      received = true;
      opts.onUsage(u, barrier, seq);
    },
    // FIX: tool_calls тоже часть частично-оплаченного ответа — не ретраим
    onToolCalls: (c: ToolCallInfo[], barrier?: boolean, seq?: number) => {
      received = true;
      opts.onToolCalls?.(c, barrier, seq);
    },
  };
  // Stop/Hard Limit могли сработать ещё до старта стрима (п пока собирался
  // контекст: хуки, память, KB) — не стартуем запрос впустую
  if (isAborted()) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await stream(wrapped);
      return;
    } catch (e) {
      const msg = String(e);
      if (!received && attempt < 2 && RETRYABLE_RE.test(msg) && !isAborted()) {
        onRetryNote?.(attempt + 1);
        await sleep(1500 * (attempt + 1));
        // Stop нажат во время паузы — новый запрос не стартуем
        if (isAborted()) return;
        continue;
      }
      // Fallback-модель: только на 429/5xx (сетевые сбои моделью не лечатся),
      // до первого токена и пока прогон не отменён
      const fb = opts.fallbackModel?.trim();
      const code = parseHttpCode(msg);
      if (
        !received &&
        fb &&
        fb !== opts.model &&
        (code === 429 || (code !== null && code >= 500)) &&
        !isAborted()
      ) {
        onFallbackNote?.(fb);
        try {
          await stream({ ...wrapped, model: fb });
          opts.onFallback?.(fb);
          return;
        } catch {
          // Ошибка фолбэка не информативнее исходной — показываем исходную
        }
      }
      // Прогон остановлен пользователем/лимитом: обрыв — не ошибка,
      // карточку ошибки не рисуем (маркер «остановлено» ставит finalize)
      if (isAborted()) return;
      throw e;
    }
  }
}
