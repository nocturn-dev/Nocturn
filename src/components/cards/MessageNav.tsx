import type * as React from "react";
import { useLang } from "../../locales";
import { type Message } from "../../types";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

interface HoverCard {
  top: number;
  preview: string;
}

// memo: навигация рендерится рядом с лентой и пересобиралась на каждый
// keystroke черновика. messages меняется на каждый флеш стрима — memo
// пробивается, но цена мала: один проход O(visible) без markdown-парса
export const MessageNav = memo(function MessageNav({
  messages,
  scrollRef,
}: {
  messages: Message[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLang();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverCard | null>(null);

  // Засечка — ТОЛЬКО на сообщения пользователя (навигация «по вопросам»)
  const ticks = useMemo(
    () => messages.filter((m) => m.role === "user").slice(-60),
    [messages],
  );

  const tickIdsRef = useRef<Set<string>>(new Set());
  tickIdsRef.current = new Set(ticks.map((m) => m.id));

  // Отмечаем «текущее» сообщение при прокрутке
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const nodes = el.querySelectorAll<HTMLElement>("[data-mid]");
      if (nodes.length === 0) return;
      const top = el.getBoundingClientRect().top;
      let current: string | null = null;
      nodes.forEach((n) => {
        if (
          n.getBoundingClientRect().top - top <= 140 &&
          tickIdsRef.current.has(n.dataset.mid ?? "")
        ) {
          current = n.dataset.mid ?? null;
        }
      });
      setActiveId(current);
    };
    const onScroll = () => {
      // rAF-троттлинг: без него каждое событие скролла давало
      // querySelectorAll + getBoundingClientRect на каждый узел (forced reflow)
      if (raf === 0) raf = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Смена состава засечек — перемер без скролла: стрим держит ленту у
    // низа, событие скролла может не прийти
    measure();
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, ticks]);

  // Прицельный скролл КОНТЕЙНЕРА ленты: scrollIntoView скроллил и вложенные
  // прокручиваемые блоки (код, терминал), и прыжок получался «50/50». Плюс
  // ручной подъём вверх снимает ловушку автоскролла (followOff в ChatArea)
  const jump = (id: string) => {
    setActiveId(id);
    const el = scrollRef.current;
    const node = el?.querySelector(`[data-mid="${id}"]`);
    if (!el || !node) return;
    const top =
      node.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop -
      el.clientHeight / 2 +
      node.getBoundingClientRect().height / 2;
    el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  // Поповер позиционируется fixed: absolute внутри скролл-контейнера
  // клипался его overflow и уезжал под карточки ленты
  const onEnter = useCallback((m: Message, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHover({
      top: r.top + r.height / 2,
      preview: m.content.replace(/\s+/g, " ").trim().slice(0, 200),
    });
  }, []);

  return (
    <>
    {/* Поповер — сиблинг контейнера, а не ребёнок: у контейнера есть
        transform (-translate-y-1/2), а transform делает его containing
        block для fixed — поповер внутри клипался и позиционировался мимо */}
    {hover && (
      <div
        className="pointer-events-none fixed right-5 z-30 w-64 -translate-y-1/2 rounded-xl border border-halo-line bg-halo-deep/95 p-3 text-left shadow-xl"
        style={{ top: hover.top }}
      >
        <p className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-halo-muted">
          {t("card.you")}
        </p>
        <p className="line-clamp-4 text-xs leading-relaxed text-halo-text">
          {hover.preview || "…"}
        </p>
      </div>
    )}
    <div className="no-scrollbar absolute right-4 top-1/2 z-20 flex max-h-[80%] -translate-y-1/2 flex-col items-end gap-2 overflow-y-auto">
      {ticks.map((m, i) => {
        const isActive = m.id === activeId;
        return (
          <button
            key={m.id}
            onClick={() => jump(m.id)}
            onMouseEnter={(e) => onEnter(m, e)}
            onMouseLeave={() => setHover(null)}
            aria-label={t("card.you")}
            className="nav-tick-in group pointer-events-auto relative flex h-2.5 w-5 shrink-0 items-center justify-end"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {/* Засечка: ширина через transform с origin-right (колонка не
                пере-лейаутится), длительность из motion-токена — переключение
                активной засечки в общем темпе анимаций, без дёрганья */}
            <span
              className={`h-[2px] w-3.5 origin-right rounded-full transition-[transform,background-color] [transition-duration:var(--motion-fast)] ${
                isActive
                  ? "scale-x-100 bg-halo-accent"
                  : "scale-x-75 bg-halo-muted/50 group-hover:scale-x-100 group-hover:bg-halo-muted"
              }`}
            />
          </button>
        );
      })}
    </div>
    </>
  );
});
