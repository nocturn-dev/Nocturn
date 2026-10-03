import { describe, expect, it } from "vitest";
import {
  applyCompact,
  buildSummaryPrompt,
  compactHistory,
  isContextLengthError,
  serializeHead,
} from "./autocompact";
import { COMPACT_SUMMARY_HEADER } from "./history";
import type { ChatMsgParam } from "../api";

const sys = { role: "system" as const, content: "Ты ассистент" };
const user = { role: "user" as const, content: "почини баг" };
const assistant = (id: string): ChatMsgParam => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "fs_read", arguments: "{}" } }],
});
const tool = (id: string, content: string): ChatMsgParam => ({
  role: "tool",
  tool_call_id: id,
  content,
});

describe("isContextLengthError", () => {
  it("ловит известные формулировки переполнения контекста", () => {
    for (const msg of [
      "Error: 400 ... context_length_exceeded",
      "maximum context length is 128000 tokens",
      "prompt is too long: 200000 tokens > 128000 maximum",
      "Input token count exceeds the limit",
    ]) {
      expect(isContextLengthError(msg), msg).toBe(true);
    }
  });

  it("не путает с другими ошибками", () => {
    for (const msg of [
      "HTTP 429 rate limit exceeded",
      "invalid api key",
      "connection reset by peer",
      "tool reported an error",
    ]) {
      expect(isContextLengthError(msg), msg).toBe(false);
    }
  });
});

describe("serializeHead", () => {
  it("system не отдаём, tool подписан id вызова", () => {
    const out = serializeHead([sys, user, assistant("tc7"), tool("tc7", "результат")]);
    expect(out).not.toContain("Ты ассистент");
    expect(out).toContain("[user] почини баг");
    expect(out).toContain("[tool result for tc7] результат");
  });

  it("кап одного сообщения и кап всей сериализации", () => {
    const msgs: ChatMsgParam[] = [user, tool("t1", "x".repeat(5000))];
    const out = serializeHead(msgs);
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThan(10_000);
  });

  it("переполнение всей сериализации: сохранены начало и конец, середина помечена", () => {
    // Маркер в НАЧАЛЕ контента: per-message-кап режет хвост, но не начало,
    // а total-кап сохраняет последние шаги целиком
    const msgs: ChatMsgParam[] = [
      user,
      ...Array.from({ length: 60 }, (_, i) => [
        assistant(`tc${i}`),
        tool(`tc${i}`, `-STEP${i}-MARKER-${"a".repeat(4000)}`),
      ]),
    ].flat() as ChatMsgParam[];
    const out = serializeHead(msgs);
    expect(out.length).toBeLessThanOrEqual(80_000 + 200);
    expect(out).toContain("[…older messages omitted…]");
    // начало (цель) и конец головы (свежее состояние) сохранены
    expect(out.startsWith("[user] почини баг")).toBe(true);
    expect(out).toContain("-STEP59-MARKER");
  });

  it("нестроковый контент сериализуется JSON-ом без падения", () => {
    const vision: ChatMsgParam = {
      role: "user",
      content: [{ type: "text", text: "смотри" }],
    };
    expect(serializeHead([vision])).toContain("смотри");
  });
});

describe("buildSummaryPrompt", () => {
  it("содержит все 6 секций и сериализованную голову", () => {
    const prompt = buildSummaryPrompt([user, tool("t1", "что-то случилось")]);
    for (const needle of [
      "Task goal",
      "Key decisions",
      "Files and artifacts",
      "Errors encountered",
      "user messages and corrections",
      "Current state",
      "[tool result for t1] что-то случилось",
    ]) {
      expect(prompt).toContain(needle);
    }
  });
});

describe("applyCompact", () => {
  it("summary вшивается в system, хвост сохранён, пары целы", () => {
    const msgs: ChatMsgParam[] = [sys, user];
    for (let i = 0; i < 20; i++) {
      msgs.push(assistant(`tc${i}`), tool(`tc${i}`, "r".repeat(3000)));
    }
    const out = applyCompact(msgs, "Итог: задачу начали, баг найден");
    expect(out[0]?.role).toBe("system");
    const c = out[0]?.content as string;
    expect(c).toContain("Ты ассистент");
    expect(c).toContain(COMPACT_SUMMARY_HEADER);
    expect(c).toContain("Итог: задачу начали, баг найден");
    // system + хвост 12
    expect(out).toHaveLength(13);
    const answered = new Set(
      out.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );
    for (const m of out) {
      if (m.role === "assistant" && m.tool_calls != null) {
        for (const call of m.tool_calls as Array<{ id: string }>) {
          expect(answered.has(call.id)).toBe(true);
        }
      }
    }
  });

  it("кап суммаризации не даёт summary заменить собой контекст", () => {
    const out = applyCompact([user], "y".repeat(20_000));
    expect((out[0]?.content as string).length).toBeLessThan(10_000);
  });
});

describe("compactHistory", () => {
  it("успех: возвращает сжатую историю", async () => {
    const msgs: ChatMsgParam[] = [sys, user, assistant("t0"), tool("t0", "r")];
    const out = await compactHistory(msgs, async () => "Итог суммаризации");
    expect(out).not.toBeNull();
    expect(out?.[0]?.role).toBe("system");
    expect(String(out?.[0]?.content)).toContain("Итог суммаризации");
  });

  it("отказ call → null, вход не тронут", async () => {
    const msgs: ChatMsgParam[] = [sys, user];
    const out = await compactHistory(msgs, async () => {
      throw new Error("aborted by user");
    });
    expect(out).toBeNull();
    expect(msgs).toHaveLength(2);
  });

  it("пустой ответ суммаризатора → null", async () => {
    const out = await compactHistory([user], async () => "   ");
    expect(out).toBeNull();
  });
});
