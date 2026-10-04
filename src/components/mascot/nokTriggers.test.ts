import { describe, expect, it } from "vitest";
import { matchNokTrigger } from "./nokTriggers";

/** Пасхальные команды Ноку: перехват до отправки, модели не видно */
describe("matchNokTrigger", () => {
  it("полёт: русские и английские фразы", () => {
    expect(matchNokTrigger("Эй Нок, полетай над чатом")).toBe("fly");
    expect(matchNokTrigger("эй нок, лети!")).toBe("fly");
    expect(matchNokTrigger("Nok, fly")).toBe("fly");
    expect(matchNokTrigger("Эй Нок")).toBe("fly");
    expect(matchNokTrigger("нок полёт")).toBe("fly");
  });

  it("домой: возврат на насест", () => {
    expect(matchNokTrigger("Эй Нок, домой")).toBe("home");
    expect(matchNokTrigger("нок, стоп")).toBe("home");
    expect(matchNokTrigger("Nok, come back home")).toBe("home");
  });

  it("обычные сообщения не перехватываются", () => {
    expect(matchNokTrigger("Привет, как дела?")).toBeNull();
    expect(matchNokTrigger("напиши функцию полета на js")).toBeNull();
    expect(matchNokTrigger("")).toBeNull();
    // Длинное сообщение с упоминанием — не пасхалка (гвард длины)
    expect(
      matchNokTrigger(
        "Эй Нок, кстати помнишь ты обещал полетать, но сначала расскажи про архитектуру стрима целиком и подробно",
      ),
    ).toBeNull();
  });
});
