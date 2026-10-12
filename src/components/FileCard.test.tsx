// @vitest-environment jsdom
// Карточка файла: бейдж расширения и подпись строк. Снапшот-щит карточек
// чата дополнен юнитом на хелпер — расширение в бейдж идёт из имени, а не
// из MIME, и для файла без расширения фолбэк TXT
import { describe, expect, it } from "vitest";
import { fileExtBadge } from "./FileCard";

describe("fileExtBadge", () => {
  it("извлекает расширение из имени", () => {
    expect(fileExtBadge("colibri.rs")).toBe("RS");
    expect(fileExtBadge("App.tsx")).toBe("TSX");
    expect(fileExtBadge("notes.old.txt")).toBe("TXT");
  });

  it("файл без расширения — TXT-фолбэк", () => {
    expect(fileExtBadge("Makefile")).toBe("TXT");
  });

  it("длинные расширения обрезаются до 4 символов", () => {
    expect(fileExtBadge("a.markdown")).toBe("MARK");
  });
});
