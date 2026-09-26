import type { ChatMsgParam } from "../api";
import type { Message, Session } from "../types";

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
  while (start < window.length && window[start]?.role === "tool") start++;
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

// ---------- Сборка истории прогона (фаза prepare, чистая часть) ----------

/** Сообщение в OpenAI-формат: текст + картинки (vision) + цитата */
export function toApiContent(m: Message): unknown {
  // Цитата (follow-up по выделенному фрагменту) идёт в контекст модели
  const text = m.quote
    ? `[Quote from earlier in this conversation]: «${m.quote}»\n\n${m.content}`
    : m.content;
  if (m.attachments?.length) {
    // Текстовые документы (RAG-lite): содержимое инлайнится в текст —
    // отдельного типа частей для файлов в провайдерах нет
    const docText = m.attachments
      .filter((a) => a.text != null)
      .map(
        (a) =>
          `\n\n--- Attached file: ${a.name} ---\n\`\`\`\n${a.text}\n\`\`\``,
      )
      .join("");
    const images = m.attachments.filter((a) => a.dataUrl != null);
    const fullText = docText ? text + docText : text;
    if (images.length === 0) return fullText;
    return [
      { type: "text", text: fullText },
      ...images.map((a) => ({
        type: "image_url",
        image_url: { url: a.dataUrl },
      })),
    ];
  }
  return text;
}

/** Сообщение → параметр запроса: tool_calls/thinking у ассистента, tool_call_id у результата */
export function toApiMessage(m: Message): ChatMsgParam {
  if (m.role === "assistant" && m.toolCalls?.length) {
    // Thinking-блок Anthropic возвращается в историю первым: Messages API
    // при extended thinking отвергает ход с tool_use без thinking
    // («Expected thinking or redacted_thinking, but found tool_use»)
    const hasThinking = m.thoughtSignature || m.thoughtRedacted?.length;
    const thinking = hasThinking
      ? {
          thinking: m.thought ?? "",
          signature: m.thoughtSignature ?? "",
          redacted: m.thoughtRedacted ?? [],
        }
      : undefined;
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
      ...(thinking ? { thinking } : {}),
    };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      content: m.content,
    };
  }
  return { role: m.role, content: toApiContent(m) };
}

/**
 * История запроса: системный промт + окно (30) + новое сообщение.
 * Служебные уведомления («[i] …») не попадают; tool-результаты не
 * выбрасываются никогда — пустой content (runTool вернул "") рвал пару
 * assistant.tool_calls ↔ tool ещё до обрезки окна → 400 у провайдера.
 */
export function buildHistory(
  current: Session | undefined,
  userMsg: Message,
): ChatMsgParam[] {
  return [
    ...(current?.systemPrompt
      ? [{ role: "system" as const, content: current.systemPrompt }]
      : []),
    ...trimContextWindow(
      (current?.messages ?? [])
        .filter((m) => {
          // Страховка поверх санитайзера при загрузке: content не строка
          // (повреждённая мутация) не роняет прогон, а выкидывается
          if (typeof m.content !== "string") return false;
          // Служебные уведомления (смена модели) в запрос не попадают
          if (m.content.startsWith("[i]")) return false;
          // Tool-результат не выбрасываем никогда: пустой content
          // (runTool вернул "") рвал пару assistant.tool_calls ↔ tool
          // ещё до обрезки окна → 400 у провайдера
          if (m.role === "tool") return true;
          return m.content !== "" || m.thought || m.attachments?.length || m.toolCalls;
        })
        .map((m) =>
          m.role === "tool" && m.content === ""
            ? { ...toApiMessage(m), content: "(empty result)" }
            : toApiMessage(m),
        ),
      30,
    ),
    { role: "user", content: toApiContent(userMsg) },
  ];
}

/**
 * Память проектов: краткий контекст предыдущих задач того же проекта
 * (название + первый запрос), до 10 последних. Пустая строка — добавить
 * в историю нечего.
 */
export function buildMemoryBlock(
  sessions: Session[],
  targetId: string,
  projectId: string,
): string {
  return sessions
    .filter(
      (s) =>
        s.id !== targetId &&
        s.projectId === projectId &&
        (s.messages?.length ?? 0) > 0,
    )
    .slice(-10)
    .map((s) => {
      const first = (s.messages ?? []).find((m) => m.role === "user");
      const ask = (first?.content ?? "").replace(/\s+/g, " ").slice(0, 120);
      return `- ${s.title}${ask ? `: ${ask}` : ""}`;
    })
    .join("\n");
}
