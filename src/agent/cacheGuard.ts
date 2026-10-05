/**
 * Детектор разрыва промпт-кэша (PLAN §27 [P2]; паттерн CC
 * promptCacheBreakDetection своими словами — код не копировался).
 *
 * Провайдеры кэшируют общий префикс запроса (system-блок + схемы тулов +
 * начало истории): попадания видны в usage (OpenAI prompt_tokens_details
 * .cached_tokens, Anthropic cache_read_input_tokens). Обнуление попаданий
 * между раундами означает, что префикс сломался — BYOK-пользователь с этого
 * момента платит полный прайс за каждый запрос, часто незаметно (обновился
 * MCP-сервер, пересобрались схемы, сменился system-блок).
 *
 * Детектор ведёт на сессию фингерпринт последнего запроса (hash system-блока
 * и hash схем тулов) и последний подтверждённый cache-read. Разрыв — когда
 * раньше были реальные попадания (>= CACHE_EVIDENCE_MIN), а стало меньше
 * четверти; виновник называется диффом фингерпринта: system / tool schemas /
 * провайдер (префикс истории или серверный сброс).
 *
 * Только диагностика в консоли tauri dev (домовый паттерн [microcompact]):
 * UI-канал добавится, когда накопится статистика ложных срабатываний.
 */

export interface CacheUsage {
  prompt: number;
  cacheRead?: number;
}

/** Попаданий меньше этого порога — кэш-факты не считаются доказательством:
 *  маленькие запросы (<1024 токенов у OpenAI) вообще не кэшируются */
const CACHE_EVIDENCE_MIN = 512;
/** Разрыв = стало меньше четверти от прошлых попаданий (не любое падение —
 *  провайдер вправе частично переиспользовать) */
const BREAK_RATIO = 4;

interface GuardState {
  /** Фингерпринт ПРЕДЫДУЩЕГО запроса (сравнение идёт N-1 → N) */
  prevSystemHash: string;
  prevToolsHash: string;
  prevCached: number;
  /** Фингерпринт текущего запроса: запоминается в noteRequest, пишется в
   *  подтверждённое состояние в noteUsage (usage приходит после запроса) */
  pendingSystemHash: string;
  pendingToolsHash: string;
}

const states = new Map<string, GuardState>();

/** FNV-1a: строковый хэш без криптографии — нужен только детект СМЕНЫ,
 *  скорость на 100КБ system-блока важнее устойчивости к коллизиям */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface CacheGuardRequest {
  /** Сообщения запроса КАК ОНИ УЙДУТ (history перед chatWithRetry) */
  messages: { role: string; content: unknown }[];
  /** Схемы тулов (финальный отфильтрованный список) */
  tools: unknown;
}

/** Запомнить фингерпринт исходящего запроса сессии */
export function noteCacheRequest(sessionId: string, req: CacheGuardRequest): void {
  // system собирается из system-сообщений с ЛЮБОЙ позиции: адаптер Anthropic
  // hoist'ит их в system-блок, поэтому их изменение ломает кэш даже в середине
  const system = messagesSystemText(req.messages);
  const state = states.get(sessionId) ?? {
    prevSystemHash: "",
    prevToolsHash: "",
    prevCached: 0,
    pendingSystemHash: "",
    pendingToolsHash: "",
  };
  state.prevSystemHash = state.pendingSystemHash;
  state.prevToolsHash = state.pendingToolsHash;
  state.pendingSystemHash = fnv1a(system);
  state.pendingToolsHash = fnv1a(JSON.stringify(req.tools ?? null));
  states.set(sessionId, state);
}

/** Обработать usage ответа: детект разрыва + лог виновника */
export function noteCacheUsage(sessionId: string, usage: CacheUsage): void {
  const state = states.get(sessionId);
  if (!state) return;
  // Фингерпринт текущего запроса становится «предыдущим» для следующего
  const curSystemHash = state.pendingSystemHash;
  const curToolsHash = state.pendingToolsHash;

  if (
    usage.cacheRead != null &&
    state.prevCached >= CACHE_EVIDENCE_MIN &&
    usage.cacheRead < state.prevCached / BREAK_RATIO
  ) {
    const culprit =
      state.prevSystemHash !== curSystemHash
        ? "system prompt changed"
        : state.prevToolsHash !== curToolsHash
          ? "tool schemas changed"
          : "provider-side reset (history prefix)";
    console.warn(
      `[cacheGuard] prompt cache reset: ${culprit} (cached ${state.prevCached} -> ${usage.cacheRead}, prompt ${usage.prompt})`,
    );
  }

  state.prevSystemHash = curSystemHash;
  state.prevToolsHash = curToolsHash;
  state.prevCached = usage.cacheRead ?? 0;
}

function messagesSystemText(messages: { role: string; content: unknown }[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\u0000");
}

/** Тест-хук: состояние живёт в памяти процесса на всю сессию */
export function resetCacheGuardForTests(): void {
  states.clear();
}
