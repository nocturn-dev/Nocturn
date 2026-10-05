import { afterEach, describe, expect, it, vi } from "vitest";
import {
  noteCacheRequest,
  noteCacheUsage,
  resetCacheGuardForTests,
} from "./cacheGuard";

/** Каркас: запрос + usage одной строкой — механика «раунд N» */
function round(
  sessionId: string,
  opts: {
    system?: string;
    tools?: unknown;
    prompt: number;
    cacheRead?: number;
  },
) {
  noteCacheRequest(sessionId, {
    messages: [
      { role: "system", content: opts.system ?? "sys" },
      { role: "user", content: "hi" },
    ],
    tools: opts.tools ?? [{ name: "fs_read" }],
  });
  noteCacheUsage(sessionId, { prompt: opts.prompt, cacheRead: opts.cacheRead });
}

afterEach(() => {
  resetCacheGuardForTests();
  vi.restoreAllMocks();
});

describe("cacheGuard", () => {
  it("первый раунд не даёт разрыва (нет предыдущих попаданий)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s1", { prompt: 5000, cacheRead: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("стабильные попадания — тишина", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s2", { prompt: 5000, cacheRead: 4096 });
    round("s2", { prompt: 6000, cacheRead: 4500 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("обнуление попаданий при том же фингерпринте — виновник history prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s3", { prompt: 5000, cacheRead: 4096 });
    round("s3", { prompt: 6000, cacheRead: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("provider-side reset");
  });

  it("смена system-блока — виновник system prompt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s4", { system: "sys v1", prompt: 5000, cacheRead: 4096 });
    round("s4", { system: "sys v2", prompt: 6000, cacheRead: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("system prompt changed");
  });

  it("смена схем тулов — виновник tool schemas (MCP обновился)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s5", { tools: [{ name: "fs_read" }], prompt: 5000, cacheRead: 4096 });
    round("s5", { tools: [{ name: "fs_read" }, { name: "web_search" }], prompt: 6000, cacheRead: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("tool schemas changed");
  });

  it("без cacheRead от провайдера детектор молчит (нет фактов)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s6", { prompt: 5000, cacheRead: 4096 });
    round("s6", { prompt: 6000 }); // провайдер не отдал кэш-поле
    expect(warn).not.toHaveBeenCalled();
  });

  it("маленькие попадания (<512) не считаются доказательством кэша", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s7", { prompt: 800, cacheRead: 64 });
    round("s7", { prompt: 900, cacheRead: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("частичное падение попаданий (не до нуля) — не разрыв", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s8", { prompt: 5000, cacheRead: 4096 });
    round("s8", { prompt: 6000, cacheRead: 1024 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("сессии независимы: разрыв в одной не тревожит другую", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    round("s9a", { prompt: 5000, cacheRead: 4096 });
    round("s9b", { prompt: 5000, cacheRead: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});
