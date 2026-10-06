import { memo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import { splitMarkdownTail } from "../../markdownTail";

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

const StablePart = memo(function StablePart(
  props: Omit<MarkdownProps, "children"> & { md: string },
) {
  const { md, ...rest } = props;
  return <ReactMarkdown {...rest}>{md}</ReactMarkdown>;
});

/** Стримящийся markdown (волна 3а): стабильный префикс парсится один раз
 *  за жизнь блока (memo по md), на каждом тике печати ре-парсится только
 *  хвост. streaming=false — одиночный парс, как раньше. Между частями
 *  ставится "\n": react-markdown в одиночном парсе разделяет блочных
 *  соседей переводом строки — с ним DOM стрима байт-в-байт равен финальному
 *  (в т.ч. выделение/копирование текста). ВАЖНО: обёртка-fragment ниже —
 *  это НЕ div; className="stream-tail" носит контейнер в AssistantCard/
 *  RunCard, он монтируется ВСЕГДА и перехватывает прямое родство
 *  .markdown > :first/:last-child — селекторы в index.css пробивают
 *  и его детей (аудит A6-3) */
export function StreamMarkdown({
  md,
  streaming,
  ...rest
}: Omit<MarkdownProps, "children"> & { md: string; streaming: boolean }) {
  if (!streaming) return <ReactMarkdown {...rest}>{md}</ReactMarkdown>;
  const { stable, tail } = splitMarkdownTail(md);
  return (
    <>
      {stable !== "" && <StablePart md={stable} {...rest} />}
      {stable !== "" && tail !== "" && "\n"}
      {tail !== "" && (
        <ReactMarkdown {...rest}>{tail}</ReactMarkdown>
      )}
    </>
  );
}
