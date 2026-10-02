import { describe, expect, it } from "vitest";
import {
  dedupImports,
  hashText,
  MAX_IMPORT_ROWS,
  parseCsv,
  parseJbImport,
} from "./jbImport";
import type { JailbreakEntry } from "./jailbreaks";

describe("parseCsv", () => {
  it("кавычки, запятые и переводы строк внутри поля; CRLF; BOM", () => {
    const csv = "\uFEFFname,text\r\n\"a, b\",\"line1\nline2\"\r\nplain,\"say \"\"hi\"\"\"\r\n";
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["name", "text"]);
    expect(rows[1]).toEqual(["a, b", "line1\nline2"]);
    expect(rows[2]).toEqual(["plain", 'say "hi"']);
  });

  it("хвост без завершающего перевода строки не теряется", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv("x")).toEqual([["x"]]);
  });
});

describe("parseJbImport", () => {
  it("наш labeled-CSV: колонки маппятся по именам, год и теги едут", () => {
    const csv = [
      "id,source,year,date_exact,model_target,name,len_chars,lang,tags,hash,text",
      'w-1,inthewild,2026,2026-02-08,ANTHROPIC,"Godmode Claude",1234,en,"no-limits;encoding",abc,"prompt body, with comma"',
    ].join("\n");
    const r = parseJbImport(csv, "labeled.csv");
    expect(r.format).toBe("csv");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toEqual({
      name: "Godmode Claude",
      model: "ANTHROPIC",
      text: "prompt body, with comma",
      year: "2026",
      tags: "no-limits;encoding",
    });
  });

  it("JSON-массив записей с альтернативными именами полей", () => {
    const r = parseJbImport(
      JSON.stringify([{ title: "T1", provider: "GROK", prompt: "body" }]),
      "a.json",
    );
    expect(r.format).toBe("json");
    expect(r.drafts[0]).toEqual({ name: "T1", model: "GROK", text: "body", year: undefined, tags: undefined });
  });

  it("TXT/MD без структуры — одна запись, имя из заголовка или файла", () => {
    const md = "# My Prompt\n\nbody text here";
    const r = parseJbImport(md, "fallback.md");
    expect(r.format).toBe("text");
    expect(r.drafts[0]?.name).toBe("My Prompt");
    expect(r2name(parseJbImport("just text", "file1.txt"))).toBe("file1");
  });

  it("строки без текста пропускаются, потолок MAX_IMPORT_ROWS честно репортится", () => {
    const header = "name,text\n";
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => `n${i},body ${i}`).join("\n");
    const r = parseJbImport(header + rows, "big.csv");
    expect(r.truncated).toBe(true);
    expect(r.drafts).toHaveLength(MAX_IMPORT_ROWS);
    const withEmpty = parseJbImport("name,text\na,ok\n,,\nb,ok2", "e.csv");
    expect(withEmpty.skippedRows).toBe(1);
    expect(withEmpty.drafts).toHaveLength(2);
  });
});

function r2name(r: { drafts: { name: string }[] }): string {
  return r.drafts[0]?.name ?? "";
}

describe("dedupImports + hashText", () => {
  const existing: JailbreakEntry[] = [
    {
      id: "old",
      name: "Old",
      model: "",
      text: "The SAME  content",
      reasoning: "any",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  it("хэш нормализует регистр и пробелы", () => {
    expect(hashText("the same content")).toBe(hashText("The   SAME\ncontent "));
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("дубликат против библиотеки и внутри пачки пропускается", () => {
    const r = dedupImports(
      existing,
      [
        { name: "dup-old", model: "", text: "the same content" },
        { name: "fresh1", model: "X", text: "unique one", year: "2026" },
        { name: "fresh2", model: "Y", text: "unique two" },
        { name: "dup-inner", model: "", text: "unique one again".replace("again", "") },
      ],
      1000,
    );
    expect(r.skippedDup).toBe(2);
    expect(r.toAdd.map((e) => e.name)).toEqual(["fresh1", "fresh2"]);
    expect(r.toAdd[0]?.year).toBe("2026");
    expect(r.toAdd[0]?.reasoning).toBe("any");
    expect(typeof r.toAdd[0]?.id).toBe("string");
  });
});
