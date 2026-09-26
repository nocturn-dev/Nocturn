import { beforeEach, describe, expect, it } from "vitest";
import { evalHardLimit, loadLimits, saveLimits } from "./limits";

// Минимальный in-memory localStorage: модуль читает/пишет напрямую
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});

beforeEach(() => store.clear());

describe("loadLimits", () => {
  it("returns all-null defaults when nothing is stored", () => {
    expect(loadLimits()).toEqual({ maxTokens: null, maxUsd: null, usdPer1M: null });
  });

  it("round-trips values through saveLimits", () => {
    saveLimits({ maxTokens: 100000, maxUsd: 2.5, usdPer1M: 3 });
    expect(loadLimits()).toEqual({ maxTokens: 100000, maxUsd: 2.5, usdPer1M: 3 });
  });

  it("falls back to nulls on corrupt JSON", () => {
    store.set("haloui-limits", "{not json");
    expect(loadLimits()).toEqual({ maxTokens: null, maxUsd: null, usdPer1M: null });
  });

  it("rejects non-finite and negative values", () => {
    store.set("haloui-limits", JSON.stringify({ maxTokens: -5, maxUsd: "10", usdPer1M: Infinity }));
    expect(loadLimits()).toEqual({ maxTokens: null, maxUsd: null, usdPer1M: null });
  });
});

describe("evalHardLimit", () => {
  it("без лимитов — никогда не срабатывает", () => {
    const lim = { maxTokens: null, maxUsd: null, usdPer1M: null };
    expect(evalHardLimit(lim, { prompt: 10_000_000, completion: 10_000_000 })).toBeNull();
  });

  it("токен-лимит: превышение и точная граница", () => {
    const lim = { maxTokens: 1000, maxUsd: null, usdPer1M: null };
    expect(evalHardLimit(lim, { prompt: 600, completion: 400 })).toBeNull();
    expect(evalHardLimit(lim, { prompt: 600, completion: 401 })).toBe("limits.hitTokens");
  });

  it("$-лимит считает usd = total / 1M × usdPer1M", () => {
    const lim = { maxTokens: null, maxUsd: 1, usdPer1M: 2 };
    // 600k токенов × $2/1M = $1.20 > $1
    expect(evalHardLimit(lim, { prompt: 600_000, completion: 0 })).toBe("limits.hitUsd");
    // 400k × $2/1M = $0.80 < $1
    expect(evalHardLimit(lim, { prompt: 400_000, completion: 0 })).toBeNull();
  });

  it("$-лимит без цены не считается (деление на неполные данные отключено)", () => {
    const lim = { maxTokens: null, maxUsd: 1, usdPer1M: null };
    expect(evalHardLimit(lim, { prompt: 10_000_000, completion: 0 })).toBeNull();
  });

  it("нулевой лимит равен отсутствующему", () => {
    const lim = { maxTokens: 0, maxUsd: 0, usdPer1M: 2 };
    expect(evalHardLimit(lim, { prompt: 999_999, completion: 0 })).toBeNull();
  });
});
