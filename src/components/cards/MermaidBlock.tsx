import { useEffect, useRef, useState } from "react";
import { useLang } from "../../locales";

/**
 * Mermaid-диаграмма из ```mermaid-блока ответа модели.
 * - Ленивый импорт: mermaid тяжёлый, в основной бандл не попадает
 *   (динамический import — отдельный чанк, грузится при первой диаграмме)
 * - securityLevel: "strict" — SVG без произвольного HTML и колбэков:
 *   ответ модели — недоверенный ввод
 * - Ошибка разбора (в т.ч. недопечатанный блок во время стрима) → код
 */
export function MermaidBlock({
  code,
  onSendSource,
}: {
  code: string;
  /** Правка исходника уходит в композер («поправил схему — перепиши код»);
   *  нет колбэка — кнопки не будет */
  onSendSource?: (edited: string) => void;
}) {
  const { t } = useLang();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  // Черновик правки: синхронизируется с кодом сообщения, но не мешает
  // пользователю дописывать свои правки, пока стрим идёт
  const [draft, setDraft] = useState(code);
  useEffect(() => setDraft(code), [code]);
  // Тема приложения — класс light на <html>: следим, чтобы диаграмма
  // перекрашивалась вместе с темой без перезапуска сообщения
  const [light, setLight] = useState(
    () => document.documentElement.classList.contains("light"),
  );
  const seq = useRef(0);

  useEffect(() => {
    const obs = new MutationObserver(() => {
      setLight(document.documentElement.classList.contains("light"));
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${++seq.current}`;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: light ? "neutral" : "dark",
          fontFamily: "inherit",
        });
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(out);
          setFailed(false);
        }
      } catch {
        // При ошибке рендера mermaid может оставить битый элемент в body
        document.getElementById(id)?.remove();
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      document.getElementById(id)?.remove();
    };
  }, [code, light]);

  const toggleBtn = (title: string, onClick: () => void, label: string) => (
    <button
      onClick={onClick}
      title={title}
      className="absolute right-2 top-2 z-10 rounded-md border border-halo-line bg-halo-deep/80 px-1.5 py-0.5 text-[0.625rem] text-halo-muted opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-halo-text"
    >
      {label}
    </button>
  );

  if (showCode || failed || svg === null) {
    const editable = showCode || failed;
    // Код-фолбэк: недопечатанный/битый блок выглядит как обычный код;
    // битая диаграмма — главный кандидат на правку руками
    return (
      <div className="group/code relative">
        {svg !== null && !failed &&
          toggleBtn(t("md.showDiagram"), () => setShowCode(false), "▦")}
        {editable ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={Math.min(24, Math.max(4, draft.split("\n").length + 1))}
              className="w-full resize-y overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-code-bg px-3 py-2 font-mono text-xs leading-relaxed text-halo-text outline-none focus:border-halo-accent/40"
            />
            {onSendSource && draft.trim() !== code.trim() && (
              <div className="mt-1 flex justify-end">
                <button
                  onClick={() => onSendSource(draft)}
                  className="rounded-md border border-halo-accent/40 bg-halo-accent/10 px-2 py-0.5 text-[0.625rem] text-halo-accent transition-colors hover:bg-halo-accent/20"
                >
                  {t("md.toComposer")}
                </button>
              </div>
            )}
          </>
        ) : (
          <pre className="overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-code-bg px-3 py-2 text-xs leading-relaxed text-halo-text">
            {code}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="group/code relative my-1">
      {toggleBtn(t("md.showCode"), () => setShowCode(true), "</>")}
      <div
        className="mermaid-host flex justify-center overflow-x-auto rounded-lg border border-halo-line/60 bg-halo-deep/40 px-2 py-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
