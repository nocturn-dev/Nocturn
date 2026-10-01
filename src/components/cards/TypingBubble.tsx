import { StarburstIcon } from "./icons";

/**
 * Статус «работаю» (паттерн claude.ai): старбёрст на акценте с медленным
 * линейным вращением + дышащий текст. Анимации живут в index.css
 * (.work-status-star / .work-status-text) — там же гасятся reduce-motion'ом
 */
export function TypingBubble({ label }: { label: string }) {
  return (
    <div className="anim-fade-up mr-auto w-fit rounded-xl border border-halo-line/70 bg-halo-surface/70 px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-halo-accent">
          <StarburstIcon />
        </span>
        <span className="work-status-text text-xs text-halo-muted">{label}</span>
      </div>
    </div>
  );
}
