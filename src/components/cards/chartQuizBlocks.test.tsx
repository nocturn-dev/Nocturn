// @vitest-environment jsdom
// Интерактивные блоки: битый JSON остаётся кодом, живой квиз отвечает на
// клики (выбор → проверка → объяснение → рестарт), пирог рисует долю
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChartBlock } from "./ChartBlock";
import { QuizBlock } from "./QuizBlock";
import { afterAll, afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
afterAll(() => localStorage.clear());

describe("ChartBlock", () => {
  it("битый JSON рисуется как код", () => {
    render(<ChartBlock code="{oops" />);
    expect(screen.getByText("{oops")).toBeTruthy();
  });

  it("pie — SVG с долей и процентами в легенде", () => {
    const code = JSON.stringify({
      type: "pie",
      labels: ["А", "Б"],
      series: [{ name: "S", values: [3, 1] }],
    });
    const { container } = render(<ChartBlock code={code} />);
    expect(container.querySelector("svg path")).toBeTruthy();
    expect(screen.getByText(/75%/)).toBeTruthy();
  });
});

describe("QuizBlock", () => {
  const quiz = JSON.stringify({
    title: "Тест",
    questions: [
      {
        question: "2+2?",
        options: ["3", "4"],
        answer: 1,
        explanation: "база",
        hint: "посчитай",
      },
      { question: "3+3?", options: ["6", "7"], answer: 0 },
    ],
  });

  it("полный цикл: подсказка → неверный ответ → объяснение → далее → рестарт", () => {
    render(<QuizBlock code={quiz} />);
    fireEvent.click(screen.getByText("Подсказка"));
    expect(screen.getByText("посчитай")).toBeTruthy();
    fireEvent.click(screen.getByText("3"));
    fireEvent.click(screen.getByText("Ответить"));
    expect(screen.getByText(/Неверно/)).toBeTruthy();
    expect(screen.getByText(/база/)).toBeTruthy();
    fireEvent.click(screen.getByText("Следующий"));
    expect(screen.getByText("3+3?")).toBeTruthy();
    fireEvent.click(screen.getByText("Пройти заново"));
    expect(screen.getByText("Вопрос 1 из 2")).toBeTruthy();
  });

  it("верные ответы завершают квиз со счётом", () => {
    render(<QuizBlock code={quiz} />);
    fireEvent.click(screen.getByText("4"));
    fireEvent.click(screen.getByText("Ответить"));
    expect(screen.getByText(/Верно/)).toBeTruthy();
    fireEvent.click(screen.getByText("Следующий"));
    fireEvent.click(screen.getByText("6"));
    fireEvent.click(screen.getByText("Ответить"));
    fireEvent.click(screen.getByText("Итоги"));
    expect(screen.getByText(/Счёт: 2\/2/)).toBeTruthy();
  });

  it("битый JSON рисуется как код", () => {
    render(<QuizBlock code="nope" />);
    expect(screen.getByText("nope")).toBeTruthy();
  });
});
