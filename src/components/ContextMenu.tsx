import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOverlay } from "../hooks/useOverlay";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Пункт неактивен: показывается, но не выбирается и пропускается навигацией */
  disabled?: boolean;
  /** разделительная линия ПЕРЕД этим пунктом */
  separator?: boolean;
  /** не закрывать меню после выбора (для двухшагового подтверждения) */
  keepOpen?: boolean;
  /** пункт «взведён» — следующий клик выполняет действие; без заметного
   *  состояния второй клик не понимается как подтверждение */
  armed?: boolean;
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
  const [active, setActive] = useState(-1);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const overlay = useOverlay({
    open: true,
    onClose,
    containerRef: ref,
    focusMode: "none",
  });

  const enabledIdxs = items
    .map((item, i) => (item.disabled ? -1 : i))
    .filter((i) => i !== -1);

  // Не даём меню вылезти за края окна: не только min по правому/нижнему
  // краю, но и пол по левому/верхнему — при клике у самого края
  // отрицательные координаты уводили меню из виду
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  // Старт — на первом доступном пункте: меню сразу управляется с клавиатуры
  useLayoutEffect(() => {
    const first = enabledIdxs[0];
    if (first !== undefined) setActive(first);
    // меню пересобирается целиком на каждое открытие
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (dir: 1 | -1) => {
    if (enabledIdxs.length === 0) return;
    const cur = enabledIdxs.indexOf(active);
    const next = enabledIdxs[(cur + dir + enabledIdxs.length) % enabledIdxs.length];
    if (next === undefined) return;
    setActive(next);
    btnRefs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    }
  };

  // Фокус на кнопке хранит активный пункт (roving focus), Enter/Space
  // срабатывают нативно по кнопке
  useEffect(() => {
    if (active !== -1) btnRefs.current[active]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return createPortal(
    <>
      {/* Невидимый слой: клик/ПКМ мимо меню закрывает его. Z — на единицу
          ниже меню и ВЫШЕ модалок: после портала в body слой соревнуется
          с модалкой (z-modal) глобально, и на z-[var(--halo-z-panel-top)] клики по модалке
          проходили мимо — меню не закрывалось */}
      <div
        className="fixed inset-0 z-[calc(var(--halo-z-modal-top)-1)]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        {...overlay}
        role="menu"
        onKeyDown={onKeyDown}
        style={{ left: pos.left, top: pos.top }}
        className="glass-pane anim-pop fixed z-[var(--halo-z-modal-top)] min-w-52 overflow-hidden rounded-xl border border-halo-line bg-halo-deep py-1.5 shadow-2xl"
      >
        {items.map((item, i) => (
          <div key={i}>
            {item.separator && <div className="my-1.5 h-px bg-halo-hover" />}
            <button
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              disabled={item.disabled}
              onFocus={() => setActive(i)}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                if (!item.keepOpen) onClose();
              }}
              className={`w-full px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors ${
                item.disabled
                  ? "cursor-default text-halo-muted/40"
                  : item.armed
                    ? "bg-red-600 font-medium text-white"
                    : item.danger
                      ? "text-red-400 hover:bg-red-500/10"
                      : "text-halo-text hover:bg-halo-hover"
              }`}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>,
    // Portal в body обязателен: fixed внутри модалки настроек якорится К
    // МОДАЛКЕ (backdrop-filter/transform на .glass-pane создают containing
    // block для fixed-потомков), координаты клика уходили мимо — меню
    // «улетало в угол». Из body fixed — честный viewport
    document.body,
  );
}
