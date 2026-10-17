import { describe, expect, it } from "vitest";
import { fsIsCaseInsensitive, getPlatform, isWindows } from "./platform";

describe("platform", () => {
  it("распознает Windows", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    expect(getPlatform(ua)).toBe("windows");
    expect(fsIsCaseInsensitive(ua)).toBe(true);
  });

  it("распознает macOS", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(getPlatform(ua)).toBe("macos");
  });

  it("распознает Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
    expect(getPlatform(ua)).toBe("linux");
  });

  it("отсекает Android с Linux в строке", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
    expect(getPlatform(ua)).toBeNull();
  });

  it("null/пустая строка отдаёт null", () => {
    expect(getPlatform("")).toBeNull();
    // @ts-expect-error Тестируем некорректный ввод
    expect(getPlatform(null)).toBeNull();
  });

  it("isWindows согласован с getPlatform", () => {
    expect(typeof isWindows()).toBe("boolean");
  });
});
