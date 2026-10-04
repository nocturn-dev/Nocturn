import { useLang } from "../../locales";
import { type PlanTask } from "../../types";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { useState } from "react";

export function PlanPanel({ plan }: { plan: PlanTask[] }) {
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(false);
  const done = plan.filter((p) => p.status === "done").length;

  return (
    <div className="anim-fade-up absolute left-0 top-0 z-[var(--halo-z-panel)] m-3 max-w-xs rounded-xl border border-halo-line bg-halo-deep/85 p-3 shadow-lg backdrop-blur">
      {/* Заголовок-строка: сворачивание, «Прогресс», счётчик done/total */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? t("card.expand") : t("card.collapse")}
          className="rounded-md p-0.5 text-halo-muted transition-colors hover:bg-halo-hover hover:text-halo-text"
        >
          <ChevronDownIcon className={collapsed ? "-rotate-90" : ""} />
        </button>
        <span className="text-[0.75rem] font-medium text-halo-text">
          {t("plan.progress")}
        </span>
        <span className="ml-auto rounded-full bg-halo-surface/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-halo-muted">
          {done}/{plan.length}
        </span>
      </div>
      {/* Свёрнуто — только заголовок-строка */}
      {!collapsed && (
        <ul className="scroll-slim mt-2 max-h-[40vh] space-y-1.5 overflow-y-auto">
          {plan.map((task, i) => (
            <li key={i} className="flex items-start gap-1.5">
              {/* Иконка статуса: галочка / пульсирующее кольцо / серый кружок */}
              <span className="mt-[3px] shrink-0">
                {task.status === "done" ? (
                  <span className="block text-halo-accent">
                    <CheckIcon />
                  </span>
                ) : task.status === "in_progress" ? (
                  <span className="block size-2.5 animate-pulse rounded-full border-[1.5px] border-halo-accent" />
                ) : (
                  <span className="block size-2.5 rounded-full border-[1.5px] border-halo-muted/50" />
                )}
              </span>
              <span
                className={`text-[0.75rem] leading-snug ${
                  task.status === "done"
                    ? "text-halo-muted line-through"
                    : "text-halo-text"
                }`}
              >
                {task.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Кнопка «−» в углу карточки: видна при наведении, сворачивает сообщение */