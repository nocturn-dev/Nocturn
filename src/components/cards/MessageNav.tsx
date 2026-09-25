import type * as React from "react";
import { useLang } from "../../locales";
import { type Message } from "../../types";
import { shortModelName } from "../ProviderIcon";
import { useEffect, useMemo, useState } from "react";

export function MessageNav({
  messages,
  model,
  scrollRef,
}: {
  messages: Message[];
  model: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLang();
  const [activeId, setActiveId] = useState<string | null>(null);

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
        if (n.getBoundingClientRect().top - top <= 140) {
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
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, messages.length]);

  const jump = (id: string) => {
    setActiveId(id);
    const el = scrollRef.current;
    el?.querySelector(`[data-mid="${id}"]`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  // Засечка — на запрос и ОДИН ход агента (каким бы длинным он ни был):
  // tool-шаги и промежуточные ответы не плодят отдельные «-»
  // useMemo: раньше пересобиралось на каждый рендер (каждый токен)
  const visibleTicks = useMemo(() => {
    const ticks: { msg: Message; preview: string }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === "user") {
        ticks.push({ msg: m, preview: m.content });
        continue;
      }
      if (m.role !== "assistant") continue;
      const prev = i > 0 ? messages[i - 1] : null;
      if (prev && prev.role !== "user") continue; // не первый шаг хода
      // Превью хода: первый осмысленный текст/мысль от модели
      let preview = "";
      for (let j = i; j < messages.length; j++) {
        const x = messages[j];
        if (!x || x.role === "user") break;
        if (x.role === "assistant" && (x.content || x.thought)) {
          preview = x.content || x.thought || "";
          break;
        }
      }
      ticks.push({ msg: m, preview });
    }
    return ticks.slice(-60);
  }, [messages]);

  return (
    <div className="no-scrollbar absolute right-3 top-1/2 z-10 flex max-h-[80%] -translate-y-1/2 flex-col items-end gap-2.5">
      {visibleTicks.map(({ msg: m, preview: rawPreview }, i) => {
        const isActive = m.id === activeId;
        const label =
          m.role === "user"
            ? t("card.you")
            : shortModelName(m.model ?? model);
        const preview = rawPreview.replace(/[#*`>\n]+/g, " ").trim().slice(0, 200);
        return (
          <button
            key={m.id}
            onClick={() => jump(m.id)}
            aria-label={label}
            className="nav-tick-in group pointer-events-auto relative flex h-2.5 w-6 shrink-0 items-center justify-end"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {/* Засечка */}
            <span
              className={`h-[3px] rounded-full transition-all duration-200 ${
                isActive
                  ? "w-4 bg-halo-accent"
                  : "w-3 bg-halo-muted/50 group-hover:w-4 group-hover:bg-halo-muted"
              }`}
            />
            {/* Поповер с текстом сообщения — только при наведении */}
            <span
              className="pointer-events-none absolute right-5 top-1/2 w-64 -translate-y-1/2 rounded-xl border border-halo-line bg-halo-deep/95 p-3 text-left shadow-xl opacity-0 translate-x-2 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
            >
              <span className="mb-1 flex items-center gap-1.5">
                {m.role === "user" ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-halo-muted">
                    {label}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-halo-accent/80">
                    {label}
                  </span>
                )}
              </span>
              <span className="line-clamp-4 text-xs leading-relaxed text-halo-text">
                {preview || "…"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Карточка вопроса агента (ask_user): интерактивна, пока вопрос жив
 * (прогон активен и ответа ещё нет); после ответа схлопывается в сводку,
 * после перезапуска/Stop — читается как история.
 */