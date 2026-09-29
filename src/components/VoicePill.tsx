/**
 * Минималистичная пилюля статуса Jarvis вверху по центру. Все состояния
 * привязаны к реальным функциям: слушает (wake-детектор активен),
 * выполняет (голосовая задача стримится), выполнил (задача завершена —
 * гаснет сама). pointer-events:none — никогда не мешает кликам.
 */

import { useLang } from "../locales";

export type VoicePhase = "idle" | "listen" | "run" | "done";

const DOT: Record<Exclude<VoicePhase, "idle">, string> = {
  listen: "bg-halo-accent animate-pulse",
  run: "bg-sky-400 animate-pulse",
  done: "bg-emerald-400",
};

const LABEL: Record<Exclude<VoicePhase, "idle">, "pillListen" | "pillRun" | "pillDone"> = {
  listen: "pillListen",
  run: "pillRun",
  done: "pillDone",
};

export default function VoicePill({ phase }: { phase: VoicePhase }) {
  const { t } = useLang();
  if (phase === "idle") return null;
  return (
    <div
      role="status"
      className="anim-fade-up pointer-events-none fixed left-1/2 top-3 z-[70] -translate-x-1/2"
    >
      <div className="flex items-center gap-2 rounded-full border border-halo-line bg-halo-raised/90 py-1.5 pl-3 pr-4 shadow-lg backdrop-blur-sm">
        <span className={`size-1.5 shrink-0 rounded-full ${DOT[phase]}`} />
        <span className="whitespace-nowrap text-xs font-medium text-halo-text">
          {t(`voice.${LABEL[phase]}`)}
        </span>
      </div>
    </div>
  );
}
