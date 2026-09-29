/**
 * Динамический дашборд вместо статических подсказок (фидбек 29.09:
 * «нейрослоп» из ролей/чипов никто не читает). Показывает живое состояние
 * локального окружения и незавершённые задачи — всё интерактивно:
 *  - MCP: число подключённых серверов (клик → настройки MCP);
 *  - Colibri: локальный MoE-движок запущен/нет (клик → настройки);
 *  - незавершённые задачи: последние активные сессии (клик — открыть);
 *  - код-действия: готовые промты под агентный режим.
 * Данные — локальные invoke'ы, один снимок на монтирование; ноль сети.
 */

import { useEffect, useState } from "react";
import { colibriStatus, mcpStatus } from "../api";
import { useLang } from "../locales";
import type { Session } from "../types";

export interface GreetingDashboardProps {
  sessions: Session[];
  onOpenSession: (id: string) => void;
  onOpenSettingsSection?: (section: "mcp" | "main") => void;
  onQuickPrompt: (text: string) => void;
}

interface StatusCards {
  mcpConnected: number | null;
  colibriRunning: boolean | null;
}

export default function GreetingDashboard({
  sessions,
  onOpenSession,
  onOpenSettingsSection,
  onQuickPrompt,
}: GreetingDashboardProps) {
  const { t } = useLang();
  const [status, setStatus] = useState<StatusCards>({
    mcpConnected: null,
    colibriRunning: null,
  });

  useEffect(() => {
    let disposed = false;
    void mcpStatus()
      .then((list) => {
        if (!disposed) {
          setStatus((prev) => ({ ...prev, mcpConnected: list.length }));
        }
      })
      .catch(() => {});
    void colibriStatus()
      .then((st) => {
        if (!disposed) {
          setStatus((prev) => ({ ...prev, colibriRunning: st.running }));
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  // Незавершённые задачи: неархивированные сессии с сообщениями, свежие сверху
  const recent = [...sessions]
    .filter((s) => !s.archived && s.messages.length > 0)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, 3);

  const card =
    "flex min-w-36 items-center gap-2 rounded-xl border border-halo-line bg-halo-surface/50 px-3.5 py-2.5 text-left transition-colors duration-150 hover:border-halo-accent/40 hover:bg-halo-surface";

  return (
    <div className="w-full">
      {/* Живое состояние локального окружения */}
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={() => onOpenSettingsSection?.("mcp")}
          className={card}
          title={t("greet.mcpHint")}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              status.mcpConnected === null
                ? "bg-halo-muted/50"
                : status.mcpConnected > 0
                  ? "bg-emerald-400"
                  : "bg-halo-muted/50"
            }`}
          />
          <span className="text-xs text-halo-muted">
            {status.mcpConnected === null
              ? t("greet.mcp")
              : status.mcpConnected > 0
                ? t("greet.mcpCount", { n: String(status.mcpConnected) })
                : t("greet.mcpNone")}
          </span>
        </button>
        <button
          onClick={() => onOpenSettingsSection?.("main")}
          className={card}
          title={t("greet.colibriHint")}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              status.colibriRunning === null
                ? "bg-halo-muted/50"
                : status.colibriRunning
                  ? "bg-emerald-400"
                  : "bg-halo-muted/50"
            }`}
          />
          <span className="text-xs text-halo-muted">
            {status.colibriRunning === null
              ? t("greet.colibri")
              : status.colibriRunning
                ? t("greet.colibriOn")
                : t("greet.colibriOff")}
          </span>
        </button>
      </div>

      {/* Незавершённые задачи: клик открывает сессию */}
      {recent.length > 0 && (
        <div className="mt-5 w-full text-left">
          <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-halo-muted/60">
            {t("greet.tasks")}
          </p>
          <div className="flex flex-col gap-1">
            {recent.map((s) => (
              <button
                key={s.id}
                onClick={() => onOpenSession(s.id)}
                className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors duration-150 hover:border-halo-line hover:bg-halo-surface/60"
              >
                <span className="size-1 shrink-0 shrink-0 rounded-full bg-halo-muted/60" />
                <span className="min-w-0 flex-1 truncate text-xs text-halo-muted">
                  {s.title}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-halo-muted/50">
                  {s.messages.length}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Код-действия: готовые промты под агентный режим */}
      <div className="mt-5 flex w-full flex-wrap justify-center gap-2">
        {[
          t("greet.actionBugs"),
          t("greet.actionOverview"),
          t("greet.actionRefactor"),
        ].map((prompt) => (
          <button
            key={prompt}
            onClick={() => onQuickPrompt(prompt)}
            className="rounded-lg border border-halo-line bg-halo-surface/50 px-3 py-1.5 text-xs text-halo-muted transition duration-150 hover:border-halo-accent/50 hover:bg-halo-surface hover:text-halo-text"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
