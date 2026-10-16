import { describe, expect, it } from "vitest";
import {
  blockHash,
  parseChartBlock,
  parseQuizBlock,
} from "./chartQuiz";

describe("parseChartBlock", () => {
  it("line с метками и двумя сериями", () => {
    const spec = parseChartBlock(
      JSON.stringify({
        type: "line",
        title: "Рост",
        labels: ["Пн", "Вт", "Ср"],
        series: [
          { name: "A", values: [1, 2, 3] },
          { name: "B", values: [3, null, 1] },
        ],
      }),
    );
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe("line");
    expect(spec!.labels).toEqual(["Пн", "Вт", "Ср"]);
    expect(spec!.series).toHaveLength(2);
    expect(spec!.series[1]!.values).toEqual([3, null, 1]);
  });

  it("алиасы: labels→categories, series→data, безымянные массивы", () => {
    const spec = parseChartBlock(
      JSON.stringify({ type: "bar", categories: ["x", "y"], data: [[5, 7]] }),
    );
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe("bar");
    expect(spec!.series[0]!.name).toBe("S1");
    expect(spec!.series[0]!.values).toEqual([5, 7]);
  });

  it("дефолт-тип line при отсутствии type", () => {
    const spec = parseChartBlock(
      JSON.stringify({ labels: ["a"], series: [{ values: [1] }] }),
    );
    expect(spec!.type).toBe("line");
  });

  it("pie требует метку каждой доле", () => {
    expect(
      parseChartBlock(
        JSON.stringify({ type: "pie", labels: ["a", "b"], series: [{ values: [1, 2] }] }),
      ),
    ).not.toBeNull();
    expect(
      parseChartBlock(
        JSON.stringify({ type: "pie", series: [{ values: [1, 2] }] }),
      ),
    ).toBeNull();
    expect(
      parseChartBlock(
        JSON.stringify({ type: "pie", labels: ["a"], series: [{ values: [1, 2] }] }),
      ),
    ).toBeNull();
  });

  it("отбраковка: не-JSON, не-объект, пустые/кривые серии, лимиты", () => {
    expect(parseChartBlock("nope{")).toBeNull();
    expect(parseChartBlock("[1,2]")).toBeNull();
    expect(parseChartBlock(JSON.stringify({ series: [] }))).toBeNull();
    expect(parseChartBlock(JSON.stringify({ series: [{ values: ["x"] }] }))).toBeNull();
    expect(
      parseChartBlock(JSON.stringify({ labels: ["a", "b"], series: [{ values: [1] }] })),
    ).toBeNull(); // длина labels ≠ длине значений
    expect(
      parseChartBlock(
        JSON.stringify({
          series: Array.from({ length: 9 }, () => ({ values: [1] })),
        }),
      ),
    ).toBeNull(); // > 8 серий
    expect(
      parseChartBlock(
        JSON.stringify({ series: [{ values: Array(201).fill(1) }] }),
      ),
    ).toBeNull(); // > 200 точек
    expect(parseChartBlock("x".repeat(200 * 1024 + 1))).toBeNull(); // кап размера
  });
});

describe("parseQuizBlock", () => {
  const quiz = JSON.stringify({
    title: "Проверка",
    questions: [
      {
        question: "2+2?",
        options: ["3", "4", "5"],
        answer: 1,
        explanation: "база",
        hint: "посчитай",
      },
      {
        question: "чётные?",
        options: ["2", "3", "4"],
        answer: [0, 2],
      },
    ],
  });

  it("канонический формат + мультиответ", () => {
    const spec = parseQuizBlock(quiz);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe("Проверка");
    expect(spec!.questions[0]!.answer).toEqual([1]);
    expect(spec!.questions[1]!.answer).toEqual([0, 2]);
    expect(spec!.questions[1]!.explanation).toBeUndefined();
  });

  it("алиасы: choices, объектные опции, буквенный ответ, correct", () => {
    const spec = parseQuizBlock(
      JSON.stringify({
        questions: [
          {
            question: "Q",
            choices: [{ text: "первый" }, { label: "второй" }],
            correct: "B",
          },
        ],
      }),
    );
    expect(spec!.questions[0]!.options).toEqual(["первый", "второй"]);
    expect(spec!.questions[0]!.answer).toEqual([1]);
  });

  it("кириллическая буквенная метка А=0", () => {
    const spec = parseQuizBlock(
      JSON.stringify({ questions: [{ question: "Q", options: ["a", "b"], answer: "А" }] }),
    );
    expect(spec!.questions[0]!.answer).toEqual([0]);
  });

  it("отбраковка: нет вопросов, <2 опций, >6 опций, ответ вне диапазона", () => {
    expect(parseQuizBlock(JSON.stringify({ questions: [] }))).toBeNull();
    expect(
      parseQuizBlock(JSON.stringify({ questions: [{ question: "Q", options: ["1"], answer: 0 }] })),
    ).toBeNull();
    expect(
      parseQuizBlock(
        JSON.stringify({
          questions: [{ question: "Q", options: ["1", "2", "3", "4", "5", "6", "7"], answer: 0 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseQuizBlock(JSON.stringify({ questions: [{ question: "Q", options: ["1", "2"], answer: 2 }] })),
    ).toBeNull();
    expect(parseQuizBlock("nope")).toBeNull();
  });

  it("кап 30 вопросов", () => {
    const many = Array.from({ length: 31 }, () => ({
      question: "Q",
      options: ["a", "b"],
      answer: 0,
    }));
    expect(parseQuizBlock(JSON.stringify({ questions: many }))).toBeNull();
  });
});

describe("blockHash", () => {
  it("стабилен и чувствителен к содержимому", () => {
    expect(blockHash("abc")).toBe(blockHash("abc"));
    expect(blockHash("abc")).not.toBe(blockHash("abd"));
  });
});
