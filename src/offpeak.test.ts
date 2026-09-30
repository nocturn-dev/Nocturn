import { describe, expect, it } from "vitest";
import {
  addOffPeakTask,
  isIdle,
  nextWaiting,
  offPeakTitle,
  pruneOffPeak,
  sanitizeOffPeak,
  type OffPeakTask,
} from "./offpeak";

describe("offpeak idle gate", () => {
  it("стрим = не простое, независимо от времени", () => {
    expect(isIdle(1_000_000, 0, true, 120_000)).toBe(false);
  });
  it("до порога — не простое, ровно порог — простое", () => {
    expect(isIdle(1_000_000, 1_000_000 - 119_999, false, 120_000)).toBe(false);
    expect(isIdle(1_000_000, 1_000_000 - 120_000, false, 120_000)).toBe(true);
  });
  it("долгое отсутствие — простое", () => {
    expect(isIdle(10_000_000, 0, false, 120_000)).toBe(true);
  });
});

describe("offpeak queue", () => {
  const base: OffPeakTask = {
    id: "op-1",
    text: "задача",
    title: "задача",
    createdAt: 0,
    status: "waiting",
  };

  it("FIFO: первая waiting-задача", () => {
    const list = [
      { ...base, id: "1", status: "done" as const },
      { ...base, id: "2" },
      { ...base, id: "3" },
    ];
    expect(nextWaiting(list)?.id).toBe("2");
    expect(nextWaiting([])).toBeNull();
  });

  it("add: пустой текст игнорируется, задача в конец", () => {
    const l1 = addOffPeakTask([], "   ", 5);
    expect(l1).toEqual([]);
    const l2 = addOffPeakTask([base], "новая задача", 5);
    expect(l2).toHaveLength(2);
    expect(l2[1]!.status).toBe("waiting");
    expect(l2[1]!.text).toBe("новая задача");
  });

  it("title: первая непустая строка, обрезка на 60", () => {
    expect(offPeakTitle("\n\n  Привет, мир!\nпока")).toBe("Привет, мир!");
    const long = "x".repeat(80);
    expect(offPeakTitle(long).length).toBe(60);
    expect(offPeakTitle(long).endsWith("…")).toBe(true);
  });

  it("sanitize: мусор → [], битые поля добираются дефолтами", () => {
    expect(sanitizeOffPeak("nope")).toEqual([]);
    expect(sanitizeOffPeak([null, {}, { id: "", text: "x" }])).toEqual([]);
    const out = sanitizeOffPeak([{ id: "a", text: "текст" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("waiting");
    expect(out[0]!.title).toBe("текст");
  });

  it("prune: waiting не трогаем, done/failed старше TTL чистим", () => {
    const now = 1_000_000;
    const list: OffPeakTask[] = [
      base,
      { ...base, id: "d1", status: "done", ranAt: now - 1000 },
      { ...base, id: "d2", status: "failed", ranAt: now - 25 * 60 * 60 * 1000, error: "x" },
    ];
    const out = pruneOffPeak(list, now);
    expect(out.map((t) => t.id)).toEqual(["op-1", "d1"]);
  });

  it("prune: жёсткий потолок 50 задач", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...base, id: `t${i}` }));
    expect(pruneOffPeak(many, 0)).toHaveLength(50);
  });
});
