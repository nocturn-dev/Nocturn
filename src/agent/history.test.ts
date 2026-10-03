import { describe, expect, it } from "vitest";
import {
  buildHistory,
  buildMemoryBlock,
  COMPACT_SUMMARY_HEADER,
  historyWithSummary,
  toApiContent,
  toApiMessage,
  trimContextWindow,
} from "./history";
import type { ChatMsgParam } from "../api";
import type { Message, Session } from "../types";

const msg = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  role: "user",
  content: "hello",
  ...over,
});

describe("toApiContent / toApiMessage", () => {
  it("текстовый документ инлайнится в контент, картинки — частями image_url", () => {
    const m = msg({
      content: "смотри",
      attachments: [
        { name: "a.txt", text: "hello doc" },
        { name: "b.png", dataUrl: "data:image/png;base64,xx" },
      ],
    });
    const parts = toApiContent(m) as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]?.type).toBe("text");
    expect(parts[0]?.text).toContain("Attached file: a.txt");
    expect(parts[0]?.text).toContain("hello doc");
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,xx" } });
  });

  it("документ без картинок — просто строка (провайдерам не нужны пустые части)", () => {
    const m = msg({ content: "go", attachments: [{ name: "a.md", text: "x" }] });
    const out = toApiContent(m);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("Attached file: a.md");
  });


  it("цитата подмешивается в текст запроса", () => {
    const out = toApiContent(msg({ content: "объясни", quote: "исходный текст" }));
    expect(String(out)).toContain("[Quote from earlier in this conversation]");
    expect(String(out)).toContain("исходный текст");
  });

  it("вложения превращаются в image_url части", () => {
    const out = toApiContent(
      msg({ content: "смотри", attachments: [{ name: "a.png", dataUrl: "data:x" }] }),
    ) as Array<{ type: string }>;
    expect(out[0]?.type).toBe("text");
    expect(out[1]?.type).toBe("image_url");
  });

  it("assistant с tool_calls → openai-форма; tool → tool_call_id", () => {
    const a = toApiMessage(
      msg({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "fs_read", arguments: "{}" }],
      }),
    );
    expect(a.role).toBe("assistant");
    const calls = a.tool_calls as Array<{ id: string; function: { name: string } }>;
    expect(calls[0]?.id).toBe("tc1");
    expect(calls[0]?.function.name).toBe("fs_read");

    const tool = toApiMessage(msg({ role: "tool", toolCallId: "tc1", content: "ok" }));
    expect(tool.role).toBe("tool");
    expect(tool.tool_call_id).toBe("tc1");
  });

  it("thinking-блок Anthropic идёт в историю первым (правило Messages API)", () => {
    const a = toApiMessage(
      msg({
        role: "assistant",
        content: "",
        thought: "думаю",
        thoughtSignature: "sig",
        toolCalls: [{ id: "tc1", name: "x", arguments: "{}" }],
      }),
    );
    expect(a.thinking).toBeDefined();
    expect((a.thinking as { signature: string }).signature).toBe("sig");
  });
});

describe("buildHistory", () => {
  it("systemPrompt первым, окно обрезается, новое сообщение в конце", () => {
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      systemPrompt: "Ты ассистент",
      messages: Array.from({ length: 40 }, (_, i) => msg({ id: `m${i}`, content: `line ${i}` })),
    };
    const history = buildHistory(current, msg({ id: "new", content: "вопрос" }));
    expect(history[0]?.role).toBe("system");
    expect(history[history.length - 1]?.content).toBe("вопрос");
    // systemPrompt + окно 30 + новое
    expect(history.length).toBe(32);
  });

  it("служебные «[i]»-сообщения выбрасываются", () => {
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      messages: [msg({ content: "[i] Модель изменена" }), msg({ content: "настоящий вопрос" })],
    };
    const history = buildHistory(current, msg({ content: "next" }));
    const contents = history.map((h) => String(h.content));
    expect(contents.some((c) => c.includes("[i]"))).toBe(false);
  });

  it("пустой tool-результат не выбрасывается, а получает текст-заглушку", () => {
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      messages: [
        msg({ role: "tool", toolCallId: "tc1", content: "" }),
        msg({ content: "q" }),
      ],
    };
    const history = buildHistory(current, msg({ content: "next" }));
    const tool = history.find((h) => h.role === "tool");
    expect(tool?.content).toBe("(empty result)");
  });
});

describe("buildMemoryBlock", () => {
  it("собирает названия + первые запросы соседних задач проекта", () => {
    const sessions: Session[] = [
      { id: "a", title: "Дизайн", createdAt: 0, projectId: "p1", messages: [msg({ content: "нарисуй макет" })] },
      { id: "b", title: "Лишняя (другой проект)", createdAt: 0, projectId: "p2", messages: [msg()] },
      { id: "c", title: "Пустая не считается", createdAt: 0, projectId: "p1", messages: [] },
    ];
    const out = buildMemoryBlock(sessions, "c", "p1");
    expect(out).toContain("- Дизайн: нарисуй макет");
    expect(out).not.toContain("Лишняя");
  });

  it("сам целевой чат в память не попадает", () => {
    const sessions: Session[] = [
      { id: "me", title: "Текущая", createdAt: 0, projectId: "p1", messages: [msg()] },
    ];
    expect(buildMemoryBlock(sessions, "me", "p1")).toBe("");
  });
});

describe("trimContextWindow", () => {
  it("не трогает короткую историю", () => {
    const h = [{ role: "user" as const, content: "a" }];
    expect(trimContextWindow(h, 30)).toBe(h);
  });

  it("срезает осиротевшие tool-сообщения в начале окна", () => {
    const history = [
      { role: "assistant" as const, content: "", tool_calls: [{ id: "tc1", type: "function" as const, function: { name: "x", arguments: "{}" } }] },
      { role: "tool" as const, tool_call_id: "tc1", content: "r" },
      ...Array.from({ length: 35 }, (_, i) => ({ role: "user" as const, content: `u${i}` })),
    ];
    const out = trimContextWindow(history, 30);
    // Окно не может начаться с осиротевшего tool-результата
    expect(out[0]?.role).not.toBe("tool");
    // И не содержит tool без родителя
    expect(out.some((m) => m.role === "tool" && !out.some(
      (a) => a.role === "assistant" && (a.tool_calls as Array<{ id?: string }> | undefined)?.some((c) => c.id === (m as { tool_call_id?: string }).tool_call_id),
    ))).toBe(false);
  });
});

describe("historyWithSummary", () => {
  const sys = { role: "system" as const, content: "Ты ассистент" };
  const user = { role: "user" as const, content: "задача" };
  const assistant = (id: string) => ({
    role: "assistant" as const,
    content: "",
    tool_calls: [{ id, type: "function" as const, function: { name: "x", arguments: "{}" } }],
  });
  const tool = (id: string) => ({ role: "tool" as const, tool_call_id: id, content: "r" });

  it("дописывает summary к существующему system, а не отдельным user-ходом", () => {
    const out = historyWithSummary("Итог задачи", [sys, user], 30);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("system");
    const c = out[0]?.content as string;
    expect(c).toContain("Ты ассистент");
    expect(c).toContain(COMPACT_SUMMARY_HEADER);
    expect(c).toContain("Итог задачи");
  });

  it("без system синтезирует system-месседж (адаптер вынесет в поле system)", () => {
    const out = historyWithSummary("Итог", [user], 30);
    expect(out[0]?.role).toBe("system");
    expect(String(out[0]?.content)).toContain("Итог");
    expect(out[1]?.role).toBe("user");
  });

  it("keep задаёт окно, пары не рвутся", () => {
    const msgs: ChatMsgParam[] = [sys, user];
    for (let i = 0; i < 20; i++) msgs.push(assistant(`tc${i}`), tool(`tc${i}`));
    const out = historyWithSummary("Итог", msgs, 12);
    // system + окно 12
    expect(out).toHaveLength(13);
    expect(out.slice(1).some((m) => m.role === "tool")).toBe(true);
    const answered = new Set(
      out.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );
    for (const m of out) {
      if (m.role === "assistant" && m.tool_calls != null) {
        for (const c of m.tool_calls as Array<{ id: string }>) {
          expect(answered.has(c.id)).toBe(true);
        }
      }
    }
  });
});

describe("buildHistory + compact", () => {
  const assistantMsg = (id: string, callId: string): Message =>
    msg({ id, role: "assistant", content: "", toolCalls: [{ id: callId, name: "fs_read", arguments: "{}" }] });
  const toolMsg = (id: string, callId: string, content: string): Message =>
    msg({ id, role: "tool", toolCallId: callId, content });

  it("summary вшивается в system, до baseCount виден только хвост 12", () => {
    const messages: Message[] = [msg({ id: "u0", content: "первая задача" })];
    for (let i = 0; i < 30; i++) {
      messages.push(assistantMsg(`a${i}`, `tc${i}`), toolMsg(`t${i}`, `tc${i}`, `res ${i}`));
    }
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      systemPrompt: "Ты ассистент",
      messages,
      compact: { summary: "Итог: цель была X", baseCount: messages.length, createdAt: 0 },
    };
    const history = buildHistory(current, msg({ id: "new", content: "продолжай" }));
    // system = промт + summary
    expect(history[0]?.role).toBe("system");
    const c0 = history[0]?.content as string;
    expect(c0).toContain("Ты ассистент");
    expect(c0).toContain("Conversation compacted");
    expect(c0).toContain("Итог: цель была X");
    // covered-хвост: 12 сообщений = 6 пар, старые результаты не вернулись
    const toolContents = history.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolContents).toHaveLength(6);
    expect(toolContents).not.toContain("res 0");
    expect(toolContents).toContain("res 29");
    // after-baseCount пуст, новое сообщение замыкает
    expect(history[history.length - 1]?.content).toBe("продолжай");
  });

  it("после baseCount сообщения едут в окно целиком", () => {
    const messages: Message[] = [msg({ id: "u0", content: "задача" })];
    for (let i = 0; i < 3; i++) {
      messages.push(assistantMsg(`a${i}`, `tc${i}`), toolMsg(`t${i}`, `tc${i}`, `res ${i}`));
    }
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      messages,
      compact: { summary: "S", baseCount: 1, createdAt: 0 },
    };
    const history = buildHistory(current, msg({ id: "new", content: "дальше" }));
    const contents = history.map((m) => String(m.content));
    // covered = [u0] (хвост из 1), after = все 6 сообщений — ничего не потеряно
    for (const res of ["res 0", "res 1", "res 2"]) {
      expect(contents).toContain(res);
    }
    expect(contents).toContain("задача");
    expect(history[0]?.role).toBe("system");
  });

  it("ручное удаление сообщений после компакции — мягкий клэмп", () => {
    const current: Session = {
      id: "s1",
      title: "t",
      createdAt: 0,
      messages: [msg({ id: "u0", content: "задача" })],
      compact: { summary: "S", baseCount: 50, createdAt: 0 },
    };
    const history = buildHistory(current, msg({ id: "n", content: "дальше" }));
    expect(history[0]?.role).toBe("system");
    expect(String(history[0]?.content)).toContain("S");
    expect(history.some((m) => m.role === "user" && m.content === "задача")).toBe(true);
  });
});
