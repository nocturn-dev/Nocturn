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

  it("обращение со знаком вопроса — тоже реплика маскоту", () => {
    expect(matchNokTrigger("Нок?")).toBe("fly");
    expect(matchNokTrigger("Эй, Нок!?")).toBe("fly");
  });

  it("кастомное имя работает наравне с дефолтным", () => {
    expect(matchNokTrigger("Искра, лети!", "Искра")).toBe("fly");
    expect(matchNokTrigger("искра, домой", "Искра")).toBe("home");
    // Чужое имя не перехватывает
    expect(matchNokTrigger("Искра, лети!", "")).toBeNull();
  });

  it("обычные сообщения не перехватываются", () => {
    expect(matchNokTrigger("Привет, как дела?")).toBeNull();
    expect(matchNokTrigger("")).toBeNull();
    // Длинное сообщение с упоминанием — не пасхалка (гвард длины)
    expect(
      matchNokTrigger(
        "Эй Нок, кстати помнишь ты обещал полетать, но сначала расскажи про архитектуру стрима целиком и подробно",
      ),
    ).toBeNull();
  });

  it("командные слова не ловятся внутри других слов", () => {
    // «backend» — это не «back», «летит» — не команда «лети»
    expect(matchNokTrigger("Эй Нок, backend")).toBeNull();
    expect(matchNokTrigger("Нок летит над кодом")).toBeNull();
    expect(matchNokTrigger("нок, хватиток")).toBeNull();
  });

  it("обращение без команды уходит модели", () => {
    expect(matchNokTrigger("Нок, а что ты умеешь?")).toBeNull();
  });
});
