

export function TypingBubble({ label }: { label: string }) {
  return (
    <div className="anim-fade-up mr-auto w-fit rounded-xl border border-halo-line/70 bg-halo-surface/70 px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="typing-dot size-1.5 rounded-full bg-halo-muted"
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
        <span className="text-xs text-halo-muted">{label}</span>
      </div>
    </div>
  );
}
