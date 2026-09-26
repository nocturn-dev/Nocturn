import { describe, expect, it } from "vitest";
import {
  exportFileName,
  fence,
  sessionToJson,
  sessionToMarkdown,
  sessionsToJson,
} from "./chatExport";
import type { Message, Session } from "../types";

const T0 = new Date(2026, 8, 25, 20, 44).getTime();

const msg = (over: Partial<Message>): Message => ({
  id: "m1",
  role: "user",
  content: "hello",
  ...over,
});

const session = (messages: Message[], over: Partial<Session> = {}): Session => ({
  id: "s1",
  title: "My chat",
  createdAt: T0,
  messages,
  ...over,
});

describe("fence", () => {
  it("обычный текст — тройные кавычки", () => {
    expect(fence("out")).toBe("```\nout\n```");
  });

  it("текст с ``` внутри — ограждение длиннее", () => {
    const out = fence("code:\n```\nx\n```");
    expect(out.startsWith("````\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
  });
});

describe("sessionToMarkdown", () => {
  it("шапка + ход диалога", () => {
    const md = sessionToMarkdown(
      session([
        msg({ id: "u1", content: "Привет" }),
        msg({
          id: "a1",
          role: "assistant",
          content: "Ответ",
          model: "gpt-x",
        }),
      ]),
    );
    expect(md).toContain("# My chat");
    expect(md).toContain("- Created: 2026-09-25 20:44");
    expect(md).toContain("- Messages: 2");
    expect(md).toContain("**User**\n\nПривет");
    expect(md).toContain("**Assistant** *(gpt-x)*\n\nОтвет");
  });

  it("служебные сообщения отфильтрованы и не считаются", () => {
    const md = sessionToMarkdown(
      session([
        msg({ content: "[i] Модель изменена" }),
        msg({ content: "вопрос" }),
      ]),
    );
    expect(md).not.toContain("[i]");
    expect(md).toContain("- Messages: 1");
  });

  it("legacy-префикс «⚙ » тоже служебный", () => {
    const md = sessionToMarkdown(session([msg({ content: "⚙ Модель изменена" })]));
    expect(md).not.toContain("⚙");
  });

  it("инструментальные шаги — в details с именем и статусом", () => {
    const md = sessionToMarkdown(
      session([
        msg({ content: "run" }),
        msg({
          id: "a2",
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc1", name: "shell_run", arguments: '{"cmd":"ls"}' }],
        }),
        msg({
          id: "t1",
          role: "tool",
          content: "file1\nfile2",
          toolCallId: "tc1",
          toolName: "shell_run",
          status: "error",
        }),
      ]),
    );
    expect(md).toContain("<summary>Tool call: shell_run</summary>");
    expect(md).toContain("<summary>Tool result: shell_run — error</summary>");
    expect(md).toContain("file1\nfile2");
  });

  it("вывод с обратными кавычками не ломает код-блок", () => {
    const md = sessionToMarkdown(
      session([
        msg({ content: "go" }),
        msg({
          id: "t2",
          role: "tool",
          content: "```\n嵌套\n```",
          toolName: "shell_run",
        }),
      ]),
    );
    expect(md).toContain("````\n```\n嵌套\n```\n````");
  });

  it("ask_user: вопрос, варианты и ответ пользователя", () => {
    const md = sessionToMarkdown(
      session([
        msg({
          id: "a3",
          role: "assistant",
          content: "",
          ask: {
            question: "Какой вариант?",
            options: [{ label: "A", description: "первый" }, { label: "B" }],
            answer: { answers: ["A"] },
          },
        }),
      ]),
    );
    expect(md).toContain("**Question**: Какой вариант?");
    expect(md).toContain("- A — первый");
    expect(md).toContain("- B");
    expect(md).toContain("→ Answer: A");
  });

  it("ошибка запроса: заголовок + сырой текст под details", () => {
    const md = sessionToMarkdown(
      session([
        msg({
          id: "a4",
          role: "assistant",
          content: "",
          error: { title: "400 Bad Request", raw: "raw-provider-body" },
        }),
      ]),
    );
    expect(md).toContain("*(error: 400 Bad Request)*");
    expect(md).toContain("<summary>raw error</summary>");
    expect(md).toContain("raw-provider-body");
  });

  it("вложения пользователя перечислены", () => {
    const md = sessionToMarkdown(
      session([
        msg({
          content: "смотри",
          attachments: [{ name: "shot.png", dataUrl: "data:..." }],
        }),
      ]),
    );
    expect(md).toContain("*(attachment: shot.png)*");
  });
});

describe("sessionToJson / sessionsToJson", () => {
  it("JSON — полная копия без потерь (служебные поля сохранены)", () => {
    const s = session([msg({ thought: "скрытые размышления", ts: T0 })]);
    const back = JSON.parse(sessionToJson(s)) as Session;
    expect(back.id).toBe("s1");
    expect(back.messages[0]?.thought).toBe("скрытые размышления");
    const many = JSON.parse(sessionsToJson([s, s])) as Session[];
    expect(many).toHaveLength(2);
  });
});

describe("exportFileName", () => {
  it("заголовок → слаг, дата из createdAt", () => {
    expect(exportFileName(session([], { title: "Мой чат: v2?" }), "md")).toBe(
      "chat-2026-09-25-мой-чат-v2.md",
    );
  });

  it("пустой/мусорный заголовок → fallback «chat»", () => {
    expect(exportFileName(session([], { title: "???" }), "json")).toBe(
      "chat-2026-09-25-chat.json",
    );
  });

  it("слаг обрезан до 40 символов без хвостового дефиса", () => {
    const name = exportFileName(session([], { title: "а".repeat(60) }), "md");
    const slug = name.slice("chat-2026-09-25-".length, -".md".length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});
