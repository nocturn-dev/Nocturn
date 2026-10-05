import { describe, expect, it } from "vitest";
import { highlightLine, langFromPath } from "./highlight";

// Золотые векторы подсветки (правило 7): DiffView/ToolStepCard рендерят
// результат через dangerouslySetInnerHTML — регресс экранирования/языка
// инжектил бы разметку молча (аудит 2026-10-04)
describe("highlight — золотые векторы", () => {
  it("langFromPath: расширения и отказы", () => {
    expect(langFromPath("src/App.tsx")).toBe("typescript");
    // Windows-разделители: \\ обязательны — одинарные \p/\m JS съедал,
    // вектор превращался в «C:projmain.rs» и split(/[\\/]/) не покрывался
    // (№12 аудита v5)
    expect(langFromPath("C:\\proj\\main.rs")).toBe("rust");
    expect(langFromPath("C:\\proj\\sub dir\\util.go")).toBe("go");
    expect(langFromPath("src/lib/util.go")).toBe("go");
    expect(langFromPath("Makefile.mk")).toBe("makefile");
    expect(langFromPath("no-extension")).toBeNull();
    expect(langFromPath(".gitignore")).toBeNull(); // dot-file, не расширение
    expect(langFromPath("x.unknownext")).toBeNull();
  });

  it("highlightLine: hljs-разметка, escapeHtml без языка, отказ от пустого", () => {
    // rs: строка подсвечивается span'ом hljs, кавычки — class string
    const rs = highlightLine('let x = "hi";', "rust");
    expect(rs).toContain("hljs");
    // без языка — экранирование: HTML-инъекция в исходнике не проходит
    expect(highlightLine("<script>alert(1)</script>", null)).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    // экранирование живёт и внутри hljs-ветки (ignoreIllegals)
    expect(highlightLine("<b>&", "rust")).not.toContain("<b>");
    expect(highlightLine("", "rust")).toBe("");
  });
});
