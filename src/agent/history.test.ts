import { describe, expect, it } from "vitest";
import {
  buildHistory,
  buildMemoryBlock,
  toApiContent,
  toApiMessage,
  trimContextWindow,
} from "./history";
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
