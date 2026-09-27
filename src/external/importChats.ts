/**
 * Импорт истории из чужих экспортов (ChatGPT conversations.json, Gemini
 * Takeout) в сессии Nocturn. Чистые функции без I/O — вход уже распарсен.
 * Тренд переносимости памяти: «забери свои данные с чужого облака на свой
 * диск». Ограничения: переносятся текстовые сообщения (attachments/tools
 * чужих платформ несовместимы с нашими структурами).
 */
import { uid } from "../hooks/useAgentRun";
import type { Message, Session } from "../types";

const MAX_MSGS = 500; // потолок на диалог — экспорты бывают гигантскими
const MAX_CONTENT = 32_000; // потолок текста одного сообщения

const clip = (s: string): string =>
  s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s;

interface ChatGptNode {
  message?: {
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[]; text?: string };
    create_time?: number;
  } | null;
  parent?: string | null;
  children?: string[];
}

/** ChatGPT: conversations.json → массив диалогов. Дерево mapping разворачивается
 *  от current_node к корню и переворачивается — активная ветка диалога */
export function parseChatGptExport(data: unknown): Session[] {
  const convos = (data as { conversations?: unknown })?.conversations;
  if (!Array.isArray(convos)) return [];
  const out: Session[] = [];
  for (const c of convos) {
    const conv = c as {
      title?: string;
      create_time?: number;
      current_node?: string;
      mapping?: Record<string, ChatGptNode>;
    };
    if (!conv || typeof conv !== "object" || !conv.mapping || !conv.current_node) continue;

    // Активная ветка: от current_node вверх по parent, затем разворот
    const chain: ChatGptNode[] = [];
    let cur: string | undefined = conv.current_node;
    const seen = new Set<string>();
    while (cur && conv.mapping[cur] && !seen.has(cur)) {
      seen.add(cur);
      const node: ChatGptNode = conv.mapping[cur]!;
      if (node.message) chain.push(node);
      cur = node.parent ?? undefined;
    }
    chain.reverse();

    const messages: Message[] = [];
    for (const node of chain) {
      const m = node.message;
      if (!m) continue;
      const role = m.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = Array.isArray(m.content?.parts) ? m.content?.parts : [];
      const text = parts
        .filter((p): p is string => typeof p === "string")
        .join("\n")
        .trim();
      const asText =
        text || (m.content?.content_type === "code" ? String(m.content.text ?? "") : "");
      if (!asText.trim()) continue;
      if (messages.length >= MAX_MSGS) break;
      messages.push({
        id: uid(),
        role,
        content: clip(asText),
      });
    }
    if (messages.length === 0) continue;
    out.push({
      id: uid(),
      title: clip(String(conv.title ?? "ChatGPT import")).replace(/[\r\n]+/g, " "),
      createdAt: conv.create_time ? Math.round(conv.create_time * 1000) : Date.now(),
      messages,
    });
  }
  return out;
}

interface GeminiChunk {
  text?: unknown;
  isThought?: unknown;
}

/** Gemini Takeout (Дуэт Gemini/*.json): массив чанков {text, isThought}.
 *  Структура рыхлая — берём текстовые чанки подряд: не-мысль = реплика,
 *  чередование user/assistant восстанавливаем по порядку */
export function parseGeminiExport(data: unknown): Session[] {
  const arr = Array.isArray(data) ? data : null;
  if (!arr) return [];
  const chunks: GeminiChunk[] = arr.filter(
    (c): c is GeminiChunk => typeof c === "object" && c !== null && "text" in c,
  );
  const messages: Message[] = [];
  let expected: Message["role"] = "user";
  for (const ch of chunks) {
    if (messages.length >= MAX_MSGS) break;
    const text = typeof ch.text === "string" ? ch.text.trim() : "";
    if (!text) continue;
    const isThought = ch.isThought === true;
    // Диалог чередуется user→assistant; мысли (isThought) прилипают к
    // стороне модели, не переворачивая ход
    const role: Message["role"] = isThought ? "assistant" : expected;
    if (!isThought) {
      expected = expected === "user" ? "assistant" : "user";
    }
    messages.push({ id: uid(), role, content: clip(text) });
  }
  if (messages.length === 0) return [];
  return [
    {
      id: uid(),
      title: clip(String((chunks[0]?.text as string) ?? "Gemini import"))
        .replace(/[\r\n]+/g, " ")
        .slice(0, 48),
      createdAt: Date.now(),
      messages,
    },
  ];
}
