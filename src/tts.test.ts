import { describe, expect, it } from "vitest";
import { speakableText } from "./tts";

describe("speakableText", () => {
  it("снимает парные эмфазис-маркеры, сохраняя содержимое", () => {
    expect(speakableText("**жирный** и *курсив*")).toBe("жирный и курсив");
    expect(speakableText("~~зачёркнуто~~")).toBe("зачёркнуто");
    expect(speakableText("__подчёркнутый__ текст")).toBe("подчёркнутый текст");
    expect(speakableText("выделение _словом_ рядом")).toBe("выделение словом рядом");
  });

  it("не ломает snake_case: подчёркивания внутри слова — часть имени", () => {
    expect(speakableText("вызови snake_case_name как есть")).toBe(
      "вызови snake_case_name как есть",
    );
    expect(speakableText("путь my_app_home не читается слитно")).toBe(
      "путь my_app_home не читается слитно",
    );
  });

  it("код-блоки и картинки выбрасываются, inline-код и ссылки схлопываются в текст", () => {
    expect(speakableText("до ```py\nprint(1)\n``` после")).toBe("до после");
    expect(speakableText("см. `config.ts` и [доку](https://x.y)")).toBe(
      "см. config.ts и доку",
    );
    expect(speakableText("![alt](img.png) текст")).toBe("текст");
  });

  it("порядок замен: ** снимается раньше одиночной звёздочки", () => {
    // Одиночный регэксп с * первым съел бы открывающий ** и оставил мусор
    expect(speakableText("**a** b **c**")).toBe("a b c");
  });
});
