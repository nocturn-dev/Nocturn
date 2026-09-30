import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** разделительная линия ПЕРЕД этим пунктом */
  separator?: boolean;
  /** не закрывать меню после выбора (для двухшагового подтверждения) */
  keepOpen?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Не даём меню вылезти за края окна
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - rect.width - 8),
      top: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Невидимый слой: клик/ПКМ мимо меню закрывает его */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        style={{ left: pos.left, top: pos.top }}
        className="glass-pane anim-pop fixed z-50 min-w-52 overflow-hidden rounded-xl border border-halo-line bg-halo-deep py-1.5 shadow-2xl"
      >
        {items.map((item, i) => (
          <div key={i}>
            {item.separator && <div className="my-1.5 h-px bg-white/5" />}
            <button
              onClick={() => {
                item.onSelect();
                if (!item.keepOpen) onClose();
              }}
              className={`w-full px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors ${
                item.danger
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-halo-text hover:bg-white/5"
              }`}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
