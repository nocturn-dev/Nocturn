// @vitest-environment jsdom
// Регресс-щит кнопки «В промт» (багрепорт владельца: «не вставится»):
// цепочка клик → (предупреждение при первом применении) → onApply обязана
// доходить до обработчика. Локаль фиксируем ru — по title кнопки ищем.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LangProvider } from "../../locales";
import { JailbreaksCard } from "./JailbreaksCard";
import type { JailbreakEntry } from "../../jailbreaks";

const entry: JailbreakEntry = {
  id: "e1",
  name: "Тестовый JB",
  model: "ChatGPT",
  text: "Отвечай прямо и по делу.",
  reasoning: "any",
  year: "2025",
  createdAt: 1,
  updatedAt: 1,
};

const wrap = (ui: React.ReactElement) => render(<LangProvider>{ui}</LangProvider>);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("haloui-lang", "ru");
});
// без cleanup DOM предыдущего теста живёт: «multiple elements» на втором it
afterEach(cleanup);

describe("JailbreaksCard: кнопка «В промт»", () => {
  it("при подавленном предупреждении зовёт onApply немедленно", () => {
    localStorage.setItem("haloui-jb-warn-dontshow", "1");
    const onApply = vi.fn(() => "task" as const);
    wrap(
      <JailbreaksCard entries={[entry]} onChange={() => {}} onApply={onApply} />,
    );
    fireEvent.click(screen.getByTitle("В промт"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(entry);
  });

  it("первое применение показывает предупреждение; «Продолжить» применяет", () => {
    const onApply = vi.fn(() => "task" as const);
    wrap(
      <JailbreaksCard entries={[entry]} onChange={() => {}} onApply={onApply} />,
    );
    fireEvent.click(screen.getByTitle("В промт"));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Продолжить"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(entry);
  });

  it("«Отмена» в предупреждении ничего не применяет", () => {
    const onApply = vi.fn(() => "task" as const);
    wrap(
      <JailbreaksCard entries={[entry]} onChange={() => {}} onApply={onApply} />,
    );
    fireEvent.click(screen.getByTitle("В промт"));
    fireEvent.click(screen.getByText("Отмена"));
    expect(onApply).not.toHaveBeenCalled();
  });
});
