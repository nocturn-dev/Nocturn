import { ThinkingOrbs } from "./ThinkingOrbs";

/**
 * Статус «работаю» — капсула как в референсе Claude: шар из орбитальных
 * точек (порт Thinking Orbs) + моно-метка. Точки красятся токеном темы,
 * капсула живёт на стекле ленты (glass-pane + msg-glass: в стекле —
 * полупрозрачная с блюром, без стекла — плотный deep, как у карточек).
 */
export function TypingBubble({ label }: { label: string }) {
  return (
    <div className="glass-pane msg-glass anim-fade-up mr-auto flex w-fit items-center gap-2.5 rounded-full border border-halo-line/70 bg-halo-surface/70 py-2 pl-2.5 pr-5 shadow-sm">
      <span className="shrink-0">
        <ThinkingOrbs size={30} />
      </span>
      <span className="font-mono text-[0.8125rem] text-halo-text/75">{label}</span>
    </div>
  );
}
