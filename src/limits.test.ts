import { beforeEach, describe, expect, it } from "vitest";
import { loadLimits, saveLimits } from "./limits";

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
