import { describe, expect, it } from "vitest";
import { parseChatGptExport, parseGeminiExport } from "./importChats";

const gptConvo = {
  title: "Test chat",
  create_time: 1700000000,
  current_node: "n3",
  mapping: {
    root: { parent: null, children: ["n1"] },
    n1: {
      message: { author: { role: "user" }, content: { parts: ["Привет"] } },
      parent: "root",
      children: ["n2"],
    },
    n2: {
      message: {
        author: { role: "assistant" },
        content: { parts: ["Привет!", "Как дела?"] },
      },
      parent: "n1",
      children: ["n3"],
    },
    // Отвёрнутая ветка: не должна попасть в активную цепочку
    nX: {
      message: { author: { role: "user" }, content: { parts: ["мусор"] } },
      parent: "n1",
      children: [],
    },
    n3: {
      message: { author: { role: "user" }, content: { parts: ["Пока"] } },
      parent: "n2",
      children: [],
    },
  },
};

describe("parseChatGptExport", () => {
  it("разворачивает активную ветку дерева в линейный диалог", () => {
    const sessions = parseChatGptExport({ conversations: [gptConvo] });
    const s0 = sessions[0]!;
    expect(sessions).toHaveLength(1);
    expect(s0.title).toBe("Test chat");
    expect(s0.messages.map((m) => m.content)).toEqual([
      "Привет",
      "Привет!\nКак дела?",
      "Пока",
    ]);
    expect(s0.createdAt).toBe(1700000000000);
  });

  it("глотает мусор и пустые конверсации", () => {
    expect(parseChatGptExport({ conversations: [{}, null, gptConvo] })).toHaveLength(1);
    expect(parseChatGptExport({})).toEqual([]);
    expect(parseChatGptExport(null)).toEqual([]);
  });
});

describe("parseGeminiExport", () => {
  it("чередует реплики и держит мысли на стороне модели", () => {
    const sessions = parseGeminiExport([
      { text: "Вопрос пользователя" },
      { text: "размышление", isThought: true },
      { text: "Ответ модели" },
      { text: 42 },
    ]);
    const s0 = sessions[0]!;
    expect(sessions).toHaveLength(1);
    expect(s0.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(s0.messages[2]!.content).toBe("Ответ модели");
  });

  it("пустой вход — пустой результат", () => {
    expect(parseGeminiExport([])).toEqual([]);
    expect(parseGeminiExport("nope")).toEqual([]);
  });
});
