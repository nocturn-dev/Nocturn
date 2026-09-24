import { describe, expect, it } from "vitest";
import { dayKeyLocal, dayPeriod } from "./time";

describe("dayPeriod", () => {
  it("morning is 5–12", () => {
    expect(dayPeriod(new Date(2026, 0, 1, 5, 0, 0))).toBe("morning");
    expect(dayPeriod(new Date(2026, 0, 1, 11, 59, 0))).toBe("morning");
  });
  it("afternoon is 12–18", () => {
    expect(dayPeriod(new Date(2026, 0, 1, 12, 0, 0))).toBe("afternoon");
    expect(dayPeriod(new Date(2026, 0, 1, 17, 59, 0))).toBe("afternoon");
  });
  it("evening is 18–23", () => {
    expect(dayPeriod(new Date(2026, 0, 1, 18, 0, 0))).toBe("evening");
    expect(dayPeriod(new Date(2026, 0, 1, 22, 59, 0))).toBe("evening");
  });
  it("night is the rest", () => {
    expect(dayPeriod(new Date(2026, 0, 1, 23, 0, 0))).toBe("night");
    expect(dayPeriod(new Date(2026, 0, 1, 4, 59, 0))).toBe("night");
  });
});

describe("dayKeyLocal", () => {
  it("pads month and day", () => {
    expect(dayKeyLocal(new Date(2026, 2, 5))).toBe("2026-03-05");
    expect(dayKeyLocal(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});
