import type { ChatMsgParam } from "../api";

/**
 * Обрезка контекстного окна без разрыва пар
 * «assistant с tool_calls ↔ его tool-результаты».
 *
 * Раньше история резалась голым `.slice(-30)`, и окно могло начаться с
 * осиротевших `role:"tool"`-сообщений — провайдеры отвечают на такой запрос
 * 400 ("tool message without preceding tool_calls"), а retry-логика 400
 * не ретраит: длинные агентные прогоны падали навсегда.
 */
export function trimContextWindow(history: ChatMsgParam[], keep: number): ChatMsgParam[] {
  if (history.length <= keep) return history; // окно не двигалось — пара порваться не могла

  const window = history.slice(-keep);

  // 1) Осиротевшие tool-результаты в начале окна: их assistant-родитель
  //    не влез в окно. Выбрасываем все ведущие role:"tool" подряд.
  let start = 0;
  while (start < window.length && window[start].role === "tool") start++;
  const kept = window.slice(start);

  // 2) Обратный случай: assistant с tool_calls, чьи ответы не влезли в окно.
  //    Собираем id всех tool-ответов, оставшихся в окне.
  const answered = new Set(
    kept
      .filter((m) => m.role === "tool" && m.tool_call_id)
      .map((m) => m.tool_call_id as string),
  );

  return kept.map((m) => {
    if (m.role !== "assistant" || m.tool_calls == null) return m;
    // Форма OpenAI: [{ id, type: "function", function: {...} }]
    const calls = m.tool_calls as Array<{ id?: string }>;
    // Обезоруживаем ассистента, у которого хоть один вызов остался без ответа:
    // текст сохраняем, tool_calls снимаем — провайдер не увидит «висящих» вызовов
    const complete =
      Array.isArray(calls) && calls.every((c) => c.id != null && answered.has(c.id));
    return complete ? m : { ...m, tool_calls: undefined };
  });
}
