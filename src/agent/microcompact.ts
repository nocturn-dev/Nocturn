import type { ChatMsgParam } from "../api";

/**
 * Microcompact — первый, дешёвый (без LLM-вызова) слой против амнезии длинных
 * агентных прогонов: старые tool-результаты в ИСТОРИИ ЗАПРОСА заменяются
 * плейсхолдером, последние шаги не трогаются. Сессия и карточки чата не
 * меняются — срезается только то, что уходит провайдеру (врезки в useAgentRun).
 *
 * Инварианты (каждый закреплён тестом):
 *  - пары «assistant.tool_calls ↔ tool.tool_call_id» не рвутся: role и ids
 *    не изменяются, заменяется только content tool-сообщения;
 *  - identity: под бюджетом (или когда шагов ≤ keepRecent) возвращается ТОТ ЖЕ
 *    массив — короткие прогоны не платят ничего;
 *  - reference-preserving: незатронутые сообщения возвращаются тем же объектом
 *    (живые патчи dispatch по history.find(tool_call_id) продолжают работать);
 *  - идемпотентность: повторный прогон — no-op, плейсхолдеры не плодятся.
 *
 * Триггер — грубая оценка chars/4 по tool-контентам: детерминизм для тестов и
 * ноль точек касания usage/HardLimit в useAgentRun. Привязка к реальным
 * токенам провайдера — слой autocompact (волна B2).
 */

/** Плейсхолдер для модели; EN — текст предназначен модели, не UI */
export const CLEARED_TOOL_RESULT =
  "[Old tool result cleared to reduce context size]";

/** Порог суммарной оценки ЖИВЫХ старых tool-контентов в окне, в токенах */
export const MICROCOMPACT_BUDGET_TOKENS = 20_000;

/** Сколько последних шагов (assistant+tool групп) защищаем от очистки */
export const KEEP_RECENT_STEPS = 3;

/** Грубая оценка ~4 символа на токен; UTF-16 .length, не символы — для
    триггера точность не критична, а очистка ничего не режет посимвольно */
const CHARS_PER_TOKEN = 4;

/** Оценка токенов всех строковых tool-контентов (в т.ч. уже очищенных) */
export function estimateToolTokens(msgs: ChatMsgParam[]): number {
  let chars = 0;
  for (const m of msgs) {
    if (m.role === "tool" && typeof m.content === "string") {
      chars += m.content.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function microcompactWindow(
  msgs: ChatMsgParam[],
  budget: number = MICROCOMPACT_BUDGET_TOKENS,
  keepRecent: number = KEEP_RECENT_STEPS,
): ChatMsgParam[] {
  // Группировка по шагам: шаг открывает assistant с tool_calls; tool-сообщение
  // принадлежит ближайшему предшествующему такому assistant (семантика OpenAI).
  // Сообщения до первого шага (groupOf -1) — осиротевший мусор, их не трогаем
  const groupOf: number[] = new Array(msgs.length);
  let groups = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.tool_calls != null) groups++;
    groupOf[i] = groups - 1;
  }
  // Защищено всё — чистить нечего (и бюджет считать не нужно)
  if (groups <= keepRecent) return msgs;
  const protectedFrom = groups - keepRecent;

  // Ранний выход: считаем только ЖИВЫЕ старые контенты — уже очищенные в
  // бюджет не входят, поэтому после первой очистки функция стабильно
  // identity, пока не накопятся новые шаги
  let live = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== "tool" || typeof m.content !== "string") continue;
    const g = groupOf[i] ?? -1;
    if (g < 0 || g >= protectedFrom || m.content === CLEARED_TOOL_RESULT) {
      continue;
    }
    live += Math.ceil(m.content.length / CHARS_PER_TOKEN);
  }
  if (live <= budget) return msgs;

  // Очистка: {...m} создаётся только для затрагиваемых сообщений
  const out = msgs.slice();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== "tool" || typeof m.content !== "string") continue;
    const g = groupOf[i] ?? -1;
    if (g < 0 || g >= protectedFrom || m.content === CLEARED_TOOL_RESULT) {
      continue;
    }
    out[i] = { ...m, content: CLEARED_TOOL_RESULT };
  }
  return out;
}

/** Обёртка для врезок в useAgentRun: прогон + диагностика в консоль.
    Сама чистка — чистая microcompactWindow, тесты живут на ней */
export function applyMicrocompact(msgs: ChatMsgParam[]): ChatMsgParam[] {
  const out = microcompactWindow(msgs);
  if (out !== msgs) {
    console.info(
      `[microcompact] cleared old tool results: ~${
        estimateToolTokens(msgs) - estimateToolTokens(out)
      } tok`,
    );
  }
  return out;
}
