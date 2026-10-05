import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { describe, expect, it } from "vitest";
import { splitMarkdownTail } from "./markdownTail";
import { StreamMarkdown } from "./components/cards/StableMarkdown";

// Золотые векторы сплита стрима (волна 3а): граница — последняя пустая
// строка вне code-fence, не продолжающая рыхлый список
describe("splitMarkdownTail — границы", () => {
  it("два абзаца: хвост начинается с нового блока", () => {
    const { stable, tail } = splitMarkdownTail("первый\n\nвторой");
    expect(stable).toBe("первый\n\n");
    expect(tail).toBe("второй");
  });

  it("пустые строки внутри фенса не режут; разрез после закрытия", () => {
    const md = "текст\n\n```rust\nfn a() {}\n\nfn b() {}\n```\n\nхвост";
    const { stable, tail } = splitMarkdownTail(md);
    expect(stable).toContain("```rust");
    expect(stable).toContain("```");
    expect(tail).toBe("хвост");
  });

  it("незакрытый фенс — резать некуда, весь текст в хвосте", () => {
    const { stable, tail } = splitMarkdownTail("текст\n\n```js\nconst x = 1;\n\n");
    expect(stable).toBe("");
    expect(tail).toBe("текст\n\n```js\nconst x = 1;\n\n");
  });

  it("рыхлый список не режется посередине", () => {
    const { stable, tail } = splitMarkdownTail("- а\n\n- б\n\n- в");
    expect(stable).toBe("");
    expect(tail).toBe("- а\n\n- б\n\n- в");
  });

  it("нумерованный рыхлый список не режется", () => {
    const { stable, tail } = splitMarkdownTail("1. а\n\n2. б");
    expect(stable).toBe("");
    expect(tail).toBe("1. а\n\n2. б");
  });

  it("список, затем абзац — граница перед абзацем", () => {
    const { stable, tail } = splitMarkdownTail("- а\n- б\n\nабзац");
    expect(stable).toBe("- а\n- б\n\n");
    expect(tail).toBe("абзац");
  });

  it("тильда-фенс с бэктиками внутри", () => {
    const md = "до\n\n~~~md\n```js\nx\n```\n\nещё в фенсе\n~~~\n\nпосле";
    const { stable, tail } = splitMarkdownTail(md);
    expect(stable).toContain("~~~md");
    expect(tail).toBe("после");
  });

  it("одна строка и пустой вход", () => {
    expect(splitMarkdownTail("одна строка").stable).toBe("");
    expect(splitMarkdownTail("").tail).toBe("");
  });
});

// Ключевой инвариант: DOM от сплита (два соседних фрагмента) совпадает с DOM
// одиночного парса — на стриме документ выглядит как финальный (волне 3а
// можно верить). react-markdown рендерит фрагмент блоков, поэтому
// последовательность элементов в .markdown идентична
const MD_PLUGINS = [remarkGfm];
const REHYPE = [rehypeHighlight];

function renderDoc(md: string): string {
  return renderToStaticMarkup(
    <div className="markdown">
      <ReactMarkdown remarkPlugins={MD_PLUGINS} rehypePlugins={REHYPE}>
        {md}
      </ReactMarkdown>
    </div>,
  );
}

function renderSplit(md: string): string {
  // Рендерим РЕАЛЬНЫЙ компонент стрима: инвариант — его DOM при активном
  // стриме байт-в-байт равен одиночному парсу того же текста
  return renderToStaticMarkup(
    <div className="markdown">
      <StreamMarkdown
        md={md}
        streaming
        remarkPlugins={MD_PLUGINS}
        rehypePlugins={REHYPE}
      />
    </div>,
  );
}

describe("splitMarkdownTail — DOM-эквивалентность", () => {
  it("абзацы, заголовки, фенс с пустыми строками, таблица, код", () => {
    const md = [
      "# Заголовок",
      "",
      "Абзац с **жирным** и `кодом`.",
      "",
      "```rust",
      "fn main() {",
      "    // пустая строка внутри фенса",
      "",
      "    let x = 1;",
      "}",
      "```",
      "",
      "| а | б |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Финальный абзац",
    ].join("\n");
    expect(renderSplit(md)).toBe(renderDoc(md));
  });

  it("плотный список и рыхлый список целиком в одной части", () => {
    const md = "вступление\n\n- а\n- б\n\n- в\n- г\n\nитог";
    expect(renderSplit(md)).toBe(renderDoc(md));
  });

  it("цитата и разделитель", () => {
    const md = "> цитата\n\n---\n\nпосле";
    expect(renderSplit(md)).toBe(renderDoc(md));
  });
});
