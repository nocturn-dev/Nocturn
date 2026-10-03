import { describe, expect, it } from "vitest";
import { brandName, matchBrand } from "./ProviderIcon";

/**
 * Волна иконок-фиксов: матчинг бренда стал двухступенчатым. Раньше семья
 * бралась точным ключом «до слэша» — бесслэшные id кастомных провайдеров
 * (claude-3-5-haiku) и вариации OpenRouter (meta-llama, x-ai) рисовали
 * букву-заглушку вместо имеющихся в бандле SVG.
 */
describe("matchBrand", () => {
  it("бесслэшные id Custom URL провайдеров ловятся regex-ступенью", () => {
    expect(matchBrand("claude-3-5-haiku")?.slug).toBe("anthropic");
    expect(matchBrand("gpt-6-astra")?.slug).toBe("openai");
    expect(matchBrand("gemini-2.0-flash")?.slug).toBe("googlegemini");
    expect(matchBrand("deepseek-v4.1-flash")?.slug).toBe("deepseek");
    expect(matchBrand("llama-3.1-70b")?.name).toBe("Llama");
    expect(matchBrand("qwen3-max")?.slug).toBe("qwen");
    expect(matchBrand("o3-mini")?.slug).toBe("openai");
  });

  it("слэш-вариации OpenRouter, которые раньше промахивались", () => {
    // ключ "meta" не равен семье "meta-llama" — теперь ловит /llama/
    expect(matchBrand("meta-llama/llama-3.3-70b")?.slug).toBe("meta");
    // ключ "xai" не равен семье "x-ai" — теперь ловит /x-ai/
    expect(matchBrand("x-ai/grok-2")?.key).toBe("xai");
    // ключи "zhipu"/"glm" не равны семье "z-ai" — теперь ловит /glm/
    expect(matchBrand("z-ai/glm-4.6")?.name).toBe("GLM");
    expect(matchBrand("moonshotai/kimi-k2")?.slug).toBe("moonshotai");
  });

  it("точные ключи по-прежнему в приоритете (семья до слэша)", () => {
    expect(matchBrand("deepseek/deepseek-r1")?.slug).toBe("deepseek");
    expect(matchBrand("openai/gpt-4o")?.slug).toBe("openai");
    expect(matchBrand("google/gemini-2.5-pro")?.slug).toBe("googlegemini");
    expect(matchBrand("xai/grok-3")?.key).toBe("xai");
  });

  it("нишевый вендор — null (буква-аватар), но его модели с известными именами ловятся", () => {
    // семья ashna — неизвестна
    expect(matchBrand("ashna/custom-model")).toBeNull();
    // но модели на ней — известные бренды (главный кейс со скринов)
    expect(matchBrand("gpt-6-astra")?.slug).toBe("openai");
    expect(matchBrand("claude-3-7-sonnet")?.slug).toBe("anthropic");
  });

  it("порядок паттернов: gemini раньше gemma, но обе — Google", () => {
    expect(matchBrand("gemini-2.5-pro")?.name).toBe("Google");
    expect(matchBrand("gemma-3-27b")?.name).toBe("Gemma");
    expect(matchBrand("gemma-3-27b")?.slug).toBe("googlegemini");
  });
});

describe("brandName", () => {
  it("бренд из единой таблицы (синхронно с иконкой)", () => {
    expect(brandName("deepseek/deepseek-r1:free")).toBe("DeepSeek");
    expect(brandName("claude-3-5-haiku")).toBe("Claude");
    expect(brandName("gpt-6-astra")).toBe("OpenAI");
    expect(brandName("meta-llama/llama-3.3-70b")).toBe("Llama");
    expect(brandName("x-ai/grok-2")).toBe("Grok");
  });

  it("неизвестное семейство — сегмент с заглавной", () => {
    expect(brandName("ashna/custom-model")).toBe("Ashna");
  });
});
