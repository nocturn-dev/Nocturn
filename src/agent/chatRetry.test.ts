import { describe, expect, it, vi } from "vitest";
import { chatWithRetry, RETRYABLE_RE, type RetryDeps } from "./chatRetry";

const instantSleep = () => Promise.resolve();
const baseOpts = {
  requestId: "r1",
  baseUrl: "http://test.local",
  apiKey: "k",
  model: "m1",
  messages: [],
  onDelta: () => {},
  onThought: () => {},
  onUsage: () => {},
};
const deps = (over: Partial<RetryDeps> = {}): RetryDeps => ({
  stream: vi.fn(),
  isAborted: () => false,
  sleep: instantSleep,
  ...over,
});

describe("chatWithRetry", () => {
  it("успех с первой попытки — один вызов стрима", async () => {
    const stream = vi.fn().mockResolvedValue(undefined);
    await chatWithRetry(deps({ stream }), baseOpts);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("ретрайабельная ошибка: до 2 повторов до первого токена, нотификации 1 и 2", async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503: overloaded"))
      .mockRejectedValueOnce(new Error("HTTP 503: overloaded"))
      .mockResolvedValueOnce(undefined);
    const onRetryNote = vi.fn();
    await chatWithRetry(deps({ stream, onRetryNote }), baseOpts);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(onRetryNote).toHaveBeenNthCalledWith(1, 1);
    expect(onRetryNote).toHaveBeenNthCalledWith(2, 2);
  });

  it("после третьей неудачи бросает исходную ошибку", async () => {
    const stream = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    await expect(
      chatWithRetry(deps({ stream }), baseOpts),
    ).rejects.toThrow("HTTP 503");
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it("не-ретрайабельная ошибка бросается сразу", async () => {
    const stream = vi.fn().mockRejectedValue(new Error("HTTP 401: bad key"));
    await expect(
      chatWithRetry(deps({ stream }), baseOpts),
    ).rejects.toThrow("HTTP 401");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("usage до ошибки = частично оплаченный ответ — ретрая нет", async () => {
    const stream = vi
      .fn()
      .mockImplementationOnce(async (o: Parameters<RetryDeps["stream"]>[0]) => {
        o.onUsage?.({ prompt: 10, completion: 0, total: 10 });
        throw new Error("HTTP 503");
      });
    await expect(
      chatWithRetry(deps({ stream }), baseOpts),
    ).rejects.toThrow("HTTP 503");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("abort до старта — стрим не вызывается; abort в паузе — тихий выход", async () => {
    const stream = vi.fn().mockResolvedValue(undefined);
    let aborted = true;
    await chatWithRetry(deps({ stream, isAborted: () => aborted }), baseOpts);
    expect(stream).not.toHaveBeenCalled();
    aborted = false;
    let calls = 0;
    const flaky = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        aborted = true; // Stop нажался во время паузы ретрая
        throw new Error("HTTP 503");
      }
      return undefined;
    });
    await chatWithRetry(deps({ stream: flaky, isAborted: () => aborted }), baseOpts);
    expect(flaky).toHaveBeenCalledTimes(1);
  });

  it("фолбэк: 429, два ретрая тоже пали → стрим с моделью fb + onFallback", async () => {
    const stream = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 429: slow down")) // попытка 0
      .mockRejectedValueOnce(new Error("HTTP 429: slow down")) // ретрай 1 (та же модель)
      .mockRejectedValueOnce(new Error("HTTP 429: slow down")) // ретрай 2 (та же модель)
      .mockImplementationOnce(async (o: Parameters<RetryDeps["stream"]>[0]) => {
        expect(o.model).toBe("m2"); // фолбэк-попытка
      });
    const onFallback = vi.fn();
    const onFallbackNote = vi.fn();
    await chatWithRetry(
      deps({ stream, onFallbackNote }),
      { ...baseOpts, fallbackModel: "m2", onFallback },
    );
    expect(stream).toHaveBeenCalledTimes(4);
    expect(onFallback).toHaveBeenCalledWith("m2");
    expect(onFallbackNote).toHaveBeenCalledWith("m2");
  });

  it("фолбэк не срабатывает: без fallbackModel / тот же model / не-429-5xx", async () => {
    const noFb = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    await expect(
      chatWithRetry(deps({ stream: noFb }), baseOpts),
    ).rejects.toThrow();
    expect(noFb).toHaveBeenCalledTimes(3); // ретраи были, фолбэка нет
    const sameModel = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    await expect(
      chatWithRetry(deps({ stream: sameModel }), { ...baseOpts, fallbackModel: "m1" }),
    ).rejects.toThrow();
    expect(sameModel).toHaveBeenCalledTimes(3);
    // failed to fetch — ретрайабелен, но кода нет → фолбэк моделью не лечится
    const netFail = vi.fn().mockRejectedValue(new Error("failed to fetch"));
    await expect(
      chatWithRetry(deps({ stream: netFail }), { ...baseOpts, fallbackModel: "m2" }),
    ).rejects.toThrow("failed to fetch");
    expect(netFail).toHaveBeenCalledTimes(3);
  });

  it("RETRYABLE_RE: сеть/таймаут — да, 4xx-контракт — нет", () => {
    expect(RETRYABLE_RE.test("HTTP 502")).toBe(true);
    expect(RETRYABLE_RE.test("connection reset")).toBe(true);
    expect(RETRYABLE_RE.test("request timed out")).toBe(true);
    expect(RETRYABLE_RE.test("HTTP 403")).toBe(false);
    expect(RETRYABLE_RE.test("HTTP 400 bad request")).toBe(false);
  });
});
