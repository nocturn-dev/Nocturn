import type { Message, Session } from "../types";

/**
 * Экспорт чата в Markdown и JSON. Чистые функции без i18n: подписи нейтрально
 * английские — файл уходит наружу и должен читаться независимо от языка UI.
 */

/** Служебные сообщения («[i] Модель изменена» и пр.) в экспорт не попадают */
const SERVICE_PREFIXES = ["[i] ", "⚙ "];

const isService = (m: Message): boolean =>
  SERVICE_PREFIXES.some((p) => m.content.startsWith(p));

/** Локальное время «YYYY-MM-DD HH:MM» без таймзонного суффикса — для шапки документа */
const localDateTime = (ts?: number): string => {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Ограждение код-блока: длиннее любого прогона обратных кавычек в тексте,
 *  иначе вывод инструмента с ``` внутри разъедет */
export function fence(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
  const tick = "`".repeat(Math.max(3, longest + 1));
  return `${tick}\n${code}\n${tick}`;
}

const details = (summary: string, body: string): string =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;

function messageToMarkdown(m: Message): string {
  if (isService(m)) return "";
  const parts: string[] = [];

  if (m.role === "user") {
    parts.push("**User**");
    parts.push(m.content.trim() || "*(empty)*");
    if (m.attachments?.length) {
      parts.push(m.attachments.map((a) => `*(attachment: ${a.name})*`).join("  \n"));
    }
  } else if (m.role === "assistant") {
    parts.push(m.model ? `**Assistant** *(${m.model})*` : "**Assistant**");
    if (m.content.trim()) parts.push(m.content.trim());
    if (m.error) {
      parts.push(`*(error: ${m.error.title})*`);
      if (m.error.raw) parts.push(details("raw error", fence(m.error.raw)));
    }
    if (m.ask) {
      const options = m.ask.options
        .map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ""}`)
        .join("\n");
      let block = `**Question**: ${m.ask.question}\n\n${options}`;
      if (m.ask.answer) {
        const given = [...m.ask.answer.answers, m.ask.answer.custom]
          .filter((x) => x && x.length > 0)
          .join(", ");
        block += `\n\n→ Answer: ${given}`;
      } else if (m.ask.cancelled) {
        block += "\n\n*(cancelled)*";
      }
      parts.push(block);
    }
    for (const c of m.toolCalls ?? []) {
      parts.push(details(`Tool call: ${c.name}`, fence(c.arguments)));
    }
  } else {
    const label = m.toolName ?? "tool";
    const status = m.status ? ` — ${m.status}` : "";
    parts.push(details(`Tool result: ${label}${status}`, fence(m.content)));
  }

  return parts.join("\n\n");
}

/** Чат → Markdown-документ: шапка-метаданные + ход диалога */
export function sessionToMarkdown(session: Session): string {
  const kept = session.messages.filter((m) => !isService(m));
  const meta = [
    `- Created: ${localDateTime(session.createdAt)}`,
    `- Messages: ${kept.length}`,
  ];
  const body = kept.map(messageToMarkdown).join("\n\n---\n\n");
  return `# ${session.title}\n\n${meta.join("\n")}\n\n---\n\n${body}\n`;
}

/** Полная копия сессии как есть (включая служебные поля) — для бэкапа/переноса */
export const sessionToJson = (session: Session): string =>
  `${JSON.stringify(session, null, 2)}\n`;

/** Все чаты одним архивом — кнопка в «Основном» разделе настроек */
export const sessionsToJson = (sessions: Session[]): string =>
  `${JSON.stringify(sessions, null, 2)}\n`;

/** Имя файла: chat-2026-09-25-мой-чат.md; заголовок → слаг из Unicode-букв/цифр */
export function exportFileName(session: Session, ext: "md" | "json"): string {
  const slug = session.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const d = new Date(session.createdAt);
  const p = (n: number): string => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `chat-${day}-${slug || "chat"}.${ext}`;
}
